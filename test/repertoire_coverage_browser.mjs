// Run in the assembled workspace with TEMPO_BINARY and TEMPO_PLAYWRIGHT.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
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
  const panel = page.locator(".advanced-games").getByRole("heading", { name: "Scan repertoire coverage" }).locator("..");

  async function openCoverage() {
    await page.goto(origin + "/#games");
    await page.getByText("Provider history and opponent coverage gaps", { exact: true }).click();
    await panel.locator("select").selectOption(repertoire_id);
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
  await button("Save response").click();
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
  await page.getByText(/85% estimated coverage.*80% target/).waitFor();
  assert.equal(starts.length, 3);
  assert.equal(await button("Retry same scan").count(), 0);
  assert.deepEqual(errors, []);
  console.log("Coverage scan, merged backlog, signed response, rescan, restart and exact scan recovery passed.");
} finally {
  await browser?.close();
  await stop();
  await rm(root, { recursive: true, force: true });
}
