// Run from the assembled workspace with TEMPO_BINARY and TEMPO_PLAYWRIGHT.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";

const { chromium } = await import(process.env.TEMPO_PLAYWRIGHT || "playwright");
const root = await mkdtemp(join(tmpdir(), "tempo-gap-recommendation-"));
const database = join(root, "study.sqlite");
const binary = resolve(process.env.TEMPO_BINARY || "target/release/tempo");
const assets = resolve("tempo-ui/dist");
let server;
let browser;
let page;
let sql;

try {
  execFileSync(binary, ["init", database]);
  if (process.env.TEMPO_MAIA) await symlink(resolve(process.env.TEMPO_MAIA), join(root, "maia"), "dir");
  server = spawn(binary, ["serve", database, assets, "0"], { stdio: ["ignore", "pipe", "inherit"] });
  const lines = createInterface({ input: server.stdout });
  const origin = await Promise.race([
    once(lines, "line").then(([line]) => line.replace("Tempo study at ", "")),
    once(server, "exit").then(([code]) => { throw Error(`Tempo exited (${code})`); }),
  ]);
  async function post(path, input) {
    const response = await fetch(origin + "/api/" + path, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
    });
    const result = await response.json();
    assert(response.ok && result.status !== "error", JSON.stringify(result));
    return result;
  }
  const { dataset_id } = await post("repertoires", { command: "list" });
  const input = { dataset_id, name: "Italian", learner_color: "white", pgn: "1. e4 e5 2. Nf3 Nc6 3. Bc4 *" };
  const preview = await post("repertoires", { command: "preview", ...input });
  const saved = await post("repertoires", { command: "save", ...input, token: preview.token });
  const repertoire = saved.repertoires.find(book => book.name === input.name);
  const first = await post("study", { command: "next" });
  await post("study", {
    command: "acknowledge", dataset_id, attempt_id: first.attempt_id, expected_revision: first.revision,
    submission_id: "before-gap", answer: { uci: first.lesson.move_uci },
  });
  const games = ["1. e4 d5 2. exd5 Qxd5", "1. e4 d5 2. exd5 Nf6", "1. e4 c6 2. d4 d5"];
  for (const [index, line] of games.entries()) {
    await post("games/import", {
      dataset_id, command_id: `game-${index}`, learner: "Learner",
      pgn: `[White "Learner"]\n[Black "Opponent"]\n[Date "2024.12.0${index + 1}"]\n\n${line} 1-0`,
    });
  }
  sql = new DatabaseSync(database, { readOnly: true });
  const durable = () => ["learning", "assessments", "attempts", "receipts", "content_receipts", "repertoire_documents"]
    .map(table => sql.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
  if (process.env.TEMPO_MAIA) {
    const old = durable();
    const { gaps } = await (await fetch(origin + "/api/games/gaps")).json();
    const { repertoire_id, position, actual_move, document_revision } = gaps[0];
    const id = "real-engine-recommendation";
    await post("games/gap-analysis", {
      request_id: id, gap: { dataset_id, repertoire_id, position, actual_move, document_revision },
    });
    let state;
    for (let i = 0; i < 100; i++) {
      state = await (await fetch(origin + "/api/games/gap-analysis")).json();
      if (state.status === "complete") break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(state.status, "complete");
    assert.equal(state.request_id, id);
    assert(state.similar_responses.current.some(move => move.uci === "g1f3"));
    assert.match(state.stockfish.engine, /Stockfish/);
    assert.equal(state.stockfish.candidates.length, 3);
    assert.deepEqual(durable(), old);
  }
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage({ viewport: { width: 1320, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const button = name => page.getByRole("button", { name, exact: true });
  const heading = name => page.getByRole("heading", { name, exact: true });
  const board = () => page.getByLabel("Repertoire response board", { exact: true });
  const similar = page.getByRole("region", { name: "Similar repertoire positions" });
  const engine = page.getByRole("region", { name: "Stockfish" });
  const explorer = page.getByRole("region", { name: "Lichess Explorer" });

  let lookup;
  let ready = false;
  let staleNext = false;
  let loseSave = false;
  const saves = [];
  const neighbor = {
    fen: "rnbqkbnr/ppp1pppp/8/3p4/4P3/2N5/PPPP1PPP/R1BQKBNR w KQkq - 0 1",
    distance: 2,
    responses: [{ repertoire_id: "example", uci: "e4d5", san: "exd5", reusable: true }],
  };
  await page.route("**/api/games/gap-analysis", async route => {
    const request = route.request();
    if (request.method() === "POST") {
      const submitted = request.postDataJSON();
      const draft = await fetch(origin + "/api/games/gap-draft", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(submitted.gap),
      });
      const details = await draft.json();
      if (!draft.ok) return route.fulfill({ status: draft.status, json: details });
      lookup = { request_id: submitted.request_id, content_revision: details.content_revision };
      return route.fulfill({ status: 202, json: { ...lookup, status: "running" } });
    }
    const json = {
      ...lookup,
      status: ready ? "complete" : "running",
      nearby: { current: [neighbor], other: [] },
      similar_responses: { current: [{ uci: "e4d5", position_count: 2 }], other: [] },
      repertoire_names: { example: "Italian" },
    };
    if (ready) {
      json.stockfish = { engine: "Stockfish fixture", candidates: [{ uci: "d2d4", san: "d4", centipawns: 38 }] };
      json.recommendation = { uci: "e4d5", basis: "similar", scope: "current", position_count: 2, loss_centipawns: 50 };
    }
    if (ready && staleNext) {
      staleNext = false;
      json.request_id = "previous-gap";
    }
    return route.fulfill({ json });
  });
  await page.route("**/api/repertoires", async route => {
    if (route.request().postDataJSON().command === "save") {
      saves.push(route.request().postData());
      if (loseSave) {
        loseSave = false;
        const accepted = await route.fetch();
        assert.equal((await accepted.json()).status, "repertoires");
        return route.abort("failed");
      }
    }
    return route.continue();
  });

  const studyStatus = await post("study", { command: "study_status" });
  await page.route("**/api/study", route => route.fulfill({ json: studyStatus }));
  await page.goto(origin);
  await button("Games").click();
  const before = durable();
  async function open() {
    await button("Fix response").first().click();
    await heading("Respond to 1…d5").waitFor();
  }
  async function square(file, rank) {
    await board().scrollIntoViewIfNeeded();
    const box = await board().locator("cg-board").boundingBox();
    assert(box);
    return [box.x + (file.charCodeAt(0) - 97 + .5) * box.width / 8, box.y + (8 - rank + .5) * box.height / 8];
  }
  async function dragStart(from) {
    await page.mouse.move(...await square(...from));
    await page.mouse.down();
  }
  async function dragEnd(to) {
    await page.mouse.move(...await square(...to), { steps: 12 });
    await page.mouse.up();
  }
  const green = () => page.locator(".gap-board svg line[stroke='#4f8a59']");
  const blue = () => page.locator(".gap-board svg line[stroke='#4e7ca8']");

  await open();
  const startingFen = await board().getAttribute("data-fen");
  await similar.getByText("2 positions", { exact: true }).waitFor();
  assert.equal(await button("Save response").isEnabled(), false);
  ready = true;
  await page.getByText("Suggested exd5", { exact: true }).waitFor();
  await green().waitFor({ state: "attached" });
  assert.equal(await board().getAttribute("data-fen"), startingFen);
  assert.equal(await button("Save response").isEnabled(), true);
  const [left, right, below] = await Promise.all([similar.boundingBox(), engine.boundingBox(), explorer.boundingBox()]);
  assert(left.x < right.x && Math.abs(left.y - right.y) < 2 && below.y > left.y);
  await engine.getByRole("button", { name: /d4/ }).hover();
  await blue().waitFor({ state: "attached" });
  await dragStart(["e", 4]);
  await dragEnd(["e", 5]);
  await page.getByText("Selected e5", { exact: true }).waitFor();
  await button("Clear response").click();
  await page.getByText("Play a move on the board.", { exact: true }).waitFor();
  assert.equal(await button("Save response").isEnabled(), false);
  assert.deepEqual(durable(), before);
  await button("Close").click();

  ready = false;
  await open();
  await similar.getByText("2 positions", { exact: true }).waitFor();
  await dragStart(["e", 4]);
  ready = true;
  await engine.getByText(/Stockfish fixture/).waitFor();
  assert.equal(await button("Save response").isEnabled(), false);
  await dragEnd(["d", 5]);
  await page.getByText("Selected exd5", { exact: true }).waitFor();
  await button("Close").click();

  await page.setViewportSize({ width: 390, height: 800 });
  await open();
  await page.getByText("Suggested exd5", { exact: true }).waitFor();
  const [mobileLeft, mobileRight, mobileBelow] = await Promise.all([similar.boundingBox(), engine.boundingBox(), explorer.boundingBox()]);
  assert(Math.abs(mobileLeft.x - mobileRight.x) < 2 && mobileRight.y > mobileLeft.y && mobileBelow.y > mobileRight.y);
  await engine.getByRole("button", { name: /d4/ }).focus();
  await blue().waitFor({ state: "attached" });
  await similar.getByRole("button", { name: /exd5/ }).click();
  await page.getByText("Selected exd5", { exact: true }).waitFor();
  assert.deepEqual(durable(), before);

  loseSave = true;
  await button("Save response").click();
  await button("Retry save").waitFor();
  staleNext = true;
  await page.reload();
  await heading("Respond to 1…c6").waitFor();
  await page.getByText("The result belongs to a different position. Try again.", { exact: true }).waitFor();
  assert.equal(await button("Save response").isEnabled(), false);
  assert.equal(saves.length, 2);
  assert.equal(saves[0], saves[1]);
  const after = durable();
  const oldLearning = new Set(before[0].map(row => row.target_id));
  assert.deepEqual(after[0].filter(row => oldLearning.has(row.target_id)), before[0]);
  assert.deepEqual(after.slice(1, 4), before.slice(1, 4));
  assert.equal(after[4].length, before[4].length + 1);
  const document = await post("repertoires", {
    command: "read_document", dataset_id, repertoire_id: repertoire.id,
  });
  assert.match(document.document.pgn, /e4 d5 exd5/);
  assert.deepEqual(errors, []);
  console.log("Passed desktop and mobile layout, recommendation arrows, override, pending drag, stale results, unchanged learning, and exact Save recovery.");
} finally {
  sql?.close();
  await browser?.close();
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill();
    await once(server, "exit");
  }
  await rm(root, { recursive: true, force: true });
}
