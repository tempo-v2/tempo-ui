// Run in the assembled workspace with TEMPO_BINARY and TEMPO_PLAYWRIGHT.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { Chess } from "chess.js";

const { chromium } = await import(process.env.TEMPO_PLAYWRIGHT || "playwright");
const root = await mkdtemp(join(tmpdir(), "tempo-coverage-"));
const database = join(root, "study.sqlite");
const binary = resolve(process.env.TEMPO_BINARY || "target/debug/tempo");
let server;
let browser;
let origin;

async function serve() {
  server = spawn(binary, ["serve", database, resolve("tempo-ui/dist"), "0"], { stdio: ["ignore", "pipe", "inherit"] });
  const lines = createInterface({ input: server.stdout });
  origin = await Promise.race([
    once(lines, "line").then(([line]) => line.replace("Tempo study at ", "")),
    once(server, "exit").then(([code]) => { throw Error(`Tempo exited (${code})`); }),
  ]);
}

async function post(path, input) {
  const response = await fetch(origin + "/api/" + path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
  const result = await response.json();
  assert(response.ok && result.status !== "error", JSON.stringify(result));
  return result;
}

async function stop() {
  if (server?.exitCode === null && server?.signalCode === null) {
    server.kill();
    await once(server, "exit");
  }
}

try {
  execFileSync(binary, ["init", database]);
  await serve();
  const { dataset_id } = await post("repertoires", { command: "list" });
  const input = {
    dataset_id, name: "Coverage book", learner_color: "white", pgn: "1.e4 e5 (1...c5) 2.Nf3 *",
  };
  const preview = await post("repertoires", { command: "preview", ...input });
  const { repertoires } = await post("repertoires", { command: "save", ...input, token: preview.token });
  const repertoire_id = repertoires.find(book => book.name === input.name).id;
  const address = { dataset_id, repertoire_id };
  await post("games/import", {
    dataset_id, command_id: "coverage-observed", learner: "Learner",
    pgn: '[White "Learner"]\n[Black "Opponent"]\n[Date "2024.12.01"]\n\n1.e4 d5 2.exd5 1-0',
  });

  const seed = new DatabaseSync(database);
  seed.exec("PRAGMA busy_timeout=5000");

  try {
    const board = new Chess();
    board.move("e4");
    const chances = { e7e5: 0.6, c7c5: 0.25, d7d5: 0.15 };
    const distribution = Object.fromEntries(board.moves({ verbose: true }).map(({ from, to }) => {
      const move = from + to;
      return [move, chances[move] ?? 0];
    }));
    seed.prepare("INSERT INTO game_move_models VALUES (?, ?, ?)").run(
      "maia2-0.11.0:65aae8465eed5e65df66a24ea7370715579f9e5435098d06fe18bdb1e267e997:rapid:1500:1500:cpu",
      board.fen().split(" ").slice(0, 4).join(" "), JSON.stringify(distribution),
    );
  } finally {
    seed.close();
  }
  function facts() {
    const db = new DatabaseSync(database, { readOnly: true });
    db.exec("PRAGMA busy_timeout=5000");

    try {
      return ["learning", "attempts", "assessments", "content_receipts", "game_opponent_gaps"]
        .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
    } finally {
      db.close();
    }
  }

  const before = facts();
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1320, height: 950 } });
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const button = name => page.getByRole("button", { name, exact: true });
  const panel = page.locator("#games-panel-coverage").getByRole("heading", { name: "Scan repertoire coverage" }).locator("..");

  async function openCoverage(book = repertoire_id) {
    const url = origin + "/#games";
    if (page.url() === url) await page.reload();
    else await page.goto(url);
    await page.getByRole("tab", { name: "Coverage" }).click();
    await panel.locator("select").selectOption(book);
  }

  await openCoverage();
  await panel.getByLabel("Through your move").fill("2");
  await panel.getByLabel("Target probability (%)", { exact: true }).fill("95");
  await button("Scan repertoire").click();
  await page.getByText(/60% estimated coverage through your move 2/).waitFor();
  assert.deepEqual(facts(), before);
  const first = await post("games/coverage/status", address);
  assert.equal(first.report.explorer_positions, 0);
  assert.equal(first.report.maia_positions, 1);
  await button("This scan").click();
  const c5 = page.getByText(/c5 · 25% estimated/).locator("..");
  await page.getByText(/d5 · 1 game · 15% estimated/).waitFor();
  await c5.getByRole("button", { name: "Fix response" }).click();
  const board = page.getByLabel("Repertoire response board", { exact: true });
  await board.waitFor();
  await board.scrollIntoViewIfNeeded();
  const box = await board.locator("cg-board").boundingBox();
  assert(box);
  const center = (file, rank) => [box.x + box.width * (file + 0.5) / 8, box.y + box.height * (8.5 - rank) / 8];
  await page.mouse.move(...center(6, 1));
  await page.mouse.down();
  await page.mouse.move(...center(5, 3), { steps: 8 });
  await page.mouse.up();
  await page.getByText("Selected Nf3", { exact: true }).waitFor();
  await button("Save response only").click();
  await page.getByRole("heading", { name: "Respond to 1…d5" }).waitFor();
  await button("Close").click();
  await page.getByText(/Repertoire changed. Rerun the scan/).waitFor();
  assert.equal(await c5.count(), 0);
  await button("Scan repertoire").click();
  await page.getByText(/85% estimated coverage through your move 2/).waitFor();
  const last = await post("games/coverage/status", address);
  assert.equal(last.stale, false);
  await post("repertoires", { command: "rename", ...address, name: "Renamed coverage book" });
  const renamed = await post("games/coverage/status", address);
  assert.equal(renamed.stale, false);
  assert.deepEqual(renamed.report, last.report);

  await stop();
  await serve();
  await openCoverage();
  await page.getByText(/85% estimated coverage through your move 2/).waitFor();
  await button("This scan").click();
  await page.getByText(/d5 · 1 game · 15% estimated/).waitFor();
  const retry = await fetch(origin + "/api/games/coverage", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...address, request_id: first.report.request_id,
      target_percent: 95, through_move: 2, prior_report_id: null }),
  });
  assert.equal((await retry.json()).code, "stale_coverage");
  assert.equal((await post("games/coverage/status", address)).report.request_id, last.report.request_id);
  const starts = [];
  let dropStart = "before";
  await page.route("**/api/games/coverage", async route => {
    starts.push(route.request().postData());
    if (dropStart === "before") {
      dropStart = null;
      return route.abort();
    }
    if (dropStart === "after") {
      dropStart = null;
      assert.equal((await route.fetch()).status(), 202);
      return route.abort();
    }
    return route.continue();
  });
  const target = panel.getByLabel("Target probability (%)", { exact: true });
  await panel.getByLabel("Through your move").fill("2");
  await target.fill("75");
  await button("Scan repertoire").click();
  await button("Retry same scan").waitFor();
  await page.getByText("Tempo has not confirmed this scan.", { exact: true }).waitFor();
  await page.getByText("Earlier estimate", { exact: true }).waitFor();
  assert.equal((await post("games/coverage/status", address)).report.request_id, last.report.request_id);
  await target.fill("80");
  await button("Retry same scan").click();
  await page.getByText(/85% estimated coverage.*75% target/).waitFor();
  assert.equal(starts.length, 2);
  assert.equal(starts[0], starts[1]);

  dropStart = "after";
  await button("Scan repertoire").click();
  await page.getByRole("tab", { name: "Library" }).click();
  assert.equal(await page.getByText(/estimated coverage/).first().isVisible(), false);
  await page.getByRole("tab", { name: "Coverage" }).click();
  await page.getByText(/85% estimated coverage.*80% target/).waitFor();
  assert.equal(starts.length, 3);
  assert.equal(await button("Retry same scan").count(), 0);
  if (process.env.TEMPO_MAIA) {
    function seedForecastMoves(positions) {
      const seed = new DatabaseSync(database);
      try {
        for (const [moves, chance] of positions) {
          const position = new Chess();
          moves.forEach(move => position.move(move));
          const distribution = Object.fromEntries(position.moves({ verbose: true })
            .map(({ from, to }) => [from + to, chance[from + to] ?? 0]));
          seed.prepare("INSERT OR REPLACE INTO game_move_models VALUES (?, ?, ?)").run(
            "maia2-0.11.0:65aae8465eed5e65df66a24ea7370715579f9e5435098d06fe18bdb1e267e997:rapid:1500:1500:cpu",
            position.fen().split(" ").slice(0, 4).join(" "), JSON.stringify(distribution),
          );
        }
      } finally { seed.close(); }
    }
    seedForecastMoves([
      [["e4", "e5", "Nf3"], { b8c6: 1 }],
      [["e4", "c5", "Nf3"], { d7d6: 1 }],
      [["e4", "d5", "exd5"], { d8d5: 0.8, g8f6: 0.2 }],
    ]);
    await button("All gaps").click();
    await panel.getByLabel("Through your move").fill("3");
    await target.fill("100");
    await button("Scan repertoire").click();
    await page.getByText(/estimated coverage through your move 3/).waitFor();
    const combined = await (await fetch(origin + "/api/games/gaps")).json();
    assert.deepEqual(combined.gaps.map(gap => gap.actual_move), ["b8c6", "d7d6", "d7d5"]);
    assert.deepEqual(combined.gaps.map(gap => gap.games), [0, 0, 1]);

    // An authored opponent endpoint still needs a response. The scan owns
    // its live eligibility while the matching recorded game remains evidence.
    const current = await post("repertoires", { command: "read_document", ...address });
    const withEndpoint = {
      ...address, name: current.name, learner_color: current.learner_color,
      pgn: current.document.pgn.trimEnd() + "\n\n1.e4 d5 *\n",
    };
    const edited = await post("repertoires", {
      command: "edit_preview", base_revision: current.revision, ...withEndpoint,
    });
    await post("repertoires", { command: "save", token: edited.token, ...withEndpoint });
    const updated = await post("games/gaps", { offset: 0, forecast_repertoire: repertoire_id });
    const stillOpen = updated.gaps.filter(gap => gap.actual_move === "d7d5");
    assert.equal(stillOpen.length, 1);
    assert.equal(stillOpen[0].gap_kind, "forecast");
    assert.equal(stillOpen[0].games, 1);
    assert.equal(stillOpen[0].forecast.stale, true);
    await openCoverage();
    await page.getByText("Earlier estimate", { exact: true }).waitFor();

    const beforeLine = facts();
    await symlink(resolve(process.env.TEMPO_MAIA), join(root, "maia"), "dir");
    const scandinavian = page.getByText(/d5 · 1 game · 15% estimated/).locator("..");
    await scandinavian.getByRole("button", { name: "Fix response" }).click();
    const lineBoard = page.getByLabel("Repertoire response board", { exact: true });
    await lineBoard.scrollIntoViewIfNeeded();
    const bounds = await lineBoard.locator("cg-board").boundingBox();
    const square = (file, rank) => [bounds.x + bounds.width * (file + 0.5) / 8,
      bounds.y + bounds.height * (8.5 - rank) / 8];
    await page.mouse.move(...square(4, 4));
    await page.mouse.down();
    await page.mouse.move(...square(3, 5), { steps: 8 });
    await page.mouse.up();
    await button("Save line").waitFor({ timeout: 30_000 });
    const variation = page.getByRole("region", { name: "Likely line" });
    await variation.getByText("2…Qxd5", { exact: true }).click();
    const link = new URL(await page.getByRole("link", { name: "Analyze line in Lichess" }).getAttribute("href"));
    assert.match(decodeURIComponent(link.pathname), /1\. e4 d5 2\. exd5 Qxd5 \*/);
    await variation.getByText("2 new replies in this line", { exact: true }).waitFor();
    assert.deepEqual(facts(), beforeLine);
    const saves = [];
    let dropSave = true;
    let failNext = true;
    await page.route("**/api/repertoires", async route => {
      if (route.request().postDataJSON().command !== "save") return route.continue();
      saves.push(route.request().postData());
      if (!dropSave) return route.continue();
      dropSave = false;
      assert.equal((await route.fetch()).status(), 200);
      return route.abort();
    });
    await page.route("**/api/games/gaps", async route => {
      if (saves.length === 2 && failNext) {
        failNext = false;
        return route.abort();
      }
      return route.continue();
    });
    await button("Save line").click();
    await button("Retry save").click();
    await button("Retry loading next gap").waitFor();
    await page.getByText("Saved line through your move 3.", { exact: true }).waitFor();
    await button("Retry loading next gap").click();
    await page.getByRole("heading", { name: "Respond to 2…Nc6" }).waitFor();
    assert.equal(saves.length, 2);
    assert.equal(saves[0], saves[1]);
    const afterLine = facts();
    assert.deepEqual(afterLine[0].filter(row => beforeLine[0].some(old => old.target_id === row.target_id)), beforeLine[0]);
    assert.deepEqual(afterLine.slice(1, 3), beforeLine.slice(1, 3));
    assert.equal(afterLine[3].length, beforeLine[3].length + 1);
    const { document } = await post("repertoires", { command: "read_document", ...address });
    assert.match(document.pgn, /e4 d5 exd5 Qxd5 [^ ]+ \*/);

    // The move-3 forecast follows a legal transposition to the saved g3.
    // Its first authored occurrence is a move later in the imported PGN.
    const transposeInput = {
      dataset_id, name: "Transposed coverage book", learner_color: "white",
      pgn: "1.Nf3 Nf6 2.Nd4 d5 3.Nf3 Ng8 4.g3 *",
    };
    const draftTranspose = await post("repertoires", { command: "preview", ...transposeInput });
    const transposed = await post("repertoires", { command: "save", token: draftTranspose.token, ...transposeInput });
    const transposedId = transposed.repertoires.find(book => book.name === transposeInput.name).id;
    seedForecastMoves([
      [["Nf3"], { d7d5: 1 }],
      [["Nf3", "d5", "g3"], { e7e5: 1 }],
    ]);
    await openCoverage(transposedId);
    await panel.getByLabel("Through your move").fill("3");
    await target.fill("100");
    await button("Scan repertoire").click();
    await page.getByText(/estimated coverage through your move 3/).waitFor();
    await button("This scan").click();
    await page.getByText(/e5 · 100% estimated/).locator("..").getByRole("button", { name: "Fix response" }).click();
    await page.getByRole("heading", { name: "Respond to 2…e5", exact: true }).waitFor();
    const { gaps } = await post("games/gaps", { offset: 0, forecast_repertoire: transposedId });
    const { position, actual_move, document_revision, gap_kind } = gaps[0];
    const addressed = { dataset_id, repertoire_id: transposedId, position, actual_move, document_revision, gap_kind };
    const opened = await post("games/gap-draft", addressed);
    const marked = await post("repertoires", {
      command: "marked_preview", dataset_id, repertoire_id: transposedId,
      base_revision: opened.content_revision, name: transposeInput.name, learner_color: "white",
      anchor_fen: opened.draft.fen, anchor_route: opened.anchor_route, lines: [["f1g2"]],
    });
    assert.match(marked.save_command.pgn, /1\. Nf3 d5 2\. g3 e5 3\. Bg2 \*/);
    const transposedBoard = page.getByLabel("Repertoire response board", { exact: true });
    await transposedBoard.scrollIntoViewIfNeeded();
    const bb = await transposedBoard.locator("cg-board").boundingBox();
    const centerOf = (file, rank) => [bb.x + bb.width * (file + 0.5) / 8,
      bb.y + bb.height * (8.5 - rank) / 8];
    await page.mouse.move(...centerOf(5, 1));
    await page.mouse.down();
    await page.mouse.move(...centerOf(6, 2), { steps: 8 });
    await page.mouse.up();
    await page.getByRole("button", { name: "3.Bg2 · New reply", exact: true }).click();
    const transposeLink = new URL(await page.getByRole("link", { name: "Analyze line in Lichess" }).getAttribute("href"));
    assert.match(decodeURIComponent(transposeLink.pathname), /1\. Nf3 d5 2\. g3 e5 3\. Bg2 \*/);
    const receiptsBeforeReply = facts()[3].length;
    await button("Save response only").click();
    await page.getByText("Saved Bg2.", { exact: true }).waitFor();
    const savedTranspose = await post("repertoires", {
      command: "read_document", dataset_id, repertoire_id: transposedId,
    });
    assert.match(savedTranspose.document.pgn, /Nf3 d5 g3 e5 Bg2 \*\s*$/);
    assert.equal(facts()[3].length, receiptsBeforeReply + 1);

  }
  assert.deepEqual(errors, []);
  console.log("Coverage scan, merged backlog, signed response, rescan, restart and exact scan recovery passed.");
} finally {
  await browser?.close();
  await stop();
  await rm(root, { recursive: true, force: true });
}
