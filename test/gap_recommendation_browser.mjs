// Run from the assembled workspace with TEMPO_BINARY and TEMPO_PLAYWRIGHT.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { Chess } from "chess.js";
import { checkDesktopBoardResize } from "./desktop_board_resize_browser.mjs";

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
  // The real gap draft must stay usable when a decodable retained map
  // overstates its probabilities. The read must have no durable effects.
  const { gaps: storedGaps } = await (await fetch(origin + "/api/games/gaps")).json();
  const { repertoire_id, position, actual_move, document_revision } = storedGaps[0];
  const distribution = Object.fromEntries(new Chess(`${position} 0 1`).moves({ verbose: true })
    .map((move, index) => [move.from + move.to + (move.promotion ?? ""), index < 2 ? 1 : 0]));
  const connection = new DatabaseSync(database);
  try {
    connection.prepare("INSERT INTO game_move_models VALUES (?, ?, ?)").run(
      "maia2-0.11.0:65aae8465eed5e65df66a24ea7370715579f9e5435098d06fe18bdb1e267e997:rapid:1500:1500:cpu",
      position, JSON.stringify(distribution),
    );
  } finally {
    connection.close();
  }
  const beforeDraft = durable();
  const invalidCache = await post("games/gap-draft", {
    dataset_id, repertoire_id, position, actual_move, document_revision,
  });
  assert.equal(invalidCache.local_model_error, "invalid_maia_reply");
  assert.equal(invalidCache.local_coverage, null);
  assert.equal(invalidCache.actual_probability, null);
  assert.equal(invalidCache.top_replies, null);
  assert(invalidCache.draft.legal_moves.length > 0);
  assert.deepEqual(durable(), beforeDraft);

  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage({ viewport: { width: 1320, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const button = name => page.getByRole("button", { name, exact: true });
  const heading = name => page.getByRole("heading", { name, exact: true });
  const board = () => page.getByLabel("Repertoire response board", { exact: true });
  const requests = [];
  page.on("request", request => {
    if (/\/api\/games\/gap-analysis(?:\/status)?$/.test(request.url())) requests.push(request.url());
  });
  let loseSave = false;
  const saves = [];
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
  await page.getByRole("link", { name: "Games", exact: true }).click();
  const before = durable();
  async function open() {
    await page.getByRole("tab", { name: "Coverage" }).click();
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
  await open();
  await checkDesktopBoardResize(page, "Repertoire response board");
  assert.equal(await button("Save response").isEnabled(), false);
  assert.equal(await page.getByRole("region", { name: "Stockfish" }).count(), 0);
  await dragStart(["e", 4]);
  await dragEnd(["e", 5]);
  await page.getByText("Selected e5", { exact: true }).waitFor();
  await button("Analyze lines").click();
  await heading("Analysis board").waitFor();
  await button("Return").click();
  await page.getByText("Selected e5", { exact: true }).waitFor();
  await button("Clear response").click();
  assert.equal(await button("Save response").isEnabled(), false);
  assert.deepEqual(durable(), before);
  await button("Close").click();

  await open();
  await button("Analyze lines").click();
  await heading("Analysis board").waitFor();
  const navigation = page.getByRole("navigation", { name: "Tempo sections" });
  await navigation.getByRole("link", { name: "Games", exact: true }).hover();
  await navigation.getByRole("link", { name: "Import", exact: true }).click();
  await page.getByRole("tab", { name: "Import", selected: true }).waitFor();
  assert.equal(await page.getByRole("dialog").count(), 0);

  await open();
  await button("Analyze lines").click();
  await heading("Analysis board").waitFor();
  await page.goBack();
  await page.getByRole("tab", { name: "Coverage", selected: true }).waitFor();
  assert.equal(await page.getByRole("dialog").count(), 0);

  await page.setViewportSize({ width: 390, height: 800 });
  await open();
  assert.equal(await board().locator(".tempo-board-resize-handle").count(), 0);
  await dragStart(["e", 4]);
  await dragEnd(["d", 5]);
  await page.getByText("Selected exd5", { exact: true }).waitFor();
  assert.deepEqual(durable(), before);

  loseSave = true;
  await button("Save response").click();
  await button("Retry save").waitFor();
  await page.reload();
  await heading("Respond to 1…c6").waitFor();
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
  assert.deepEqual(requests, []);
  console.log("Passed board sizing, manual reply selection, local board navigation and exact Save recovery without standalone gap analysis.");
} finally {
  sql?.close();
  await browser?.close();
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill();
    await once(server, "exit");
  }
  await rm(root, { recursive: true, force: true });
}
