import assert from "node:assert/strict";
import { checkDesktopBoardLayout, checkDesktopBoardResize } from "./desktop_board_resize_browser.mjs";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const { chromium } = await import(process.env.TEMPO_PLAYWRIGHT || "playwright");
const binary = resolve(process.env.TEMPO_BINARY || "target/debug/tempo");
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "tempo-tactic-builder-"));
const database = join(directory, "test.sqlite");
let server, browser;

function counts() {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    return Object.fromEntries(["current_content", "content_sources", "content_receipts", "learning", "assessments"]
      .map(table => [table, db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count]));
  } finally {
    db.close();
  }
}

try {
  execFileSync(binary, ["init", database]);
  server = spawn(binary, ["serve", database, dist, "0"], { stdio: ["ignore", "pipe", "inherit"] });
  const output = createInterface({ input: server.stdout });
  let url;
  for await (const line of output) {
    url = line.match(/^Tempo study at (http:\/\/127\.0\.0\.1:\d+)$/)?.[1];
    if (url) break;
  }
  assert.ok(url, "Disposable Tempo server did not start");
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1120, height: 900 } });
  page.setDefaultTimeout(7000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const requests = [];
  let dropSave = false;
  let droppedReply;
  await page.route("**/api/tactics", async route => {
    const request = route.request();
    const input = request.postDataJSON();
    requests.push({ input, bytes: request.postData() });
    if (input.command === "save" && dropSave) {
      dropSave = false;
      droppedReply = await (await route.fetch()).json();
      await route.abort();
    } else await route.continue();
  });

  const button = label => page.getByRole("button", { name: label, exact: true });
  const moves = () => page.getByRole("list", { name: "Solution moves" }).getByRole("listitem").allTextContents();
  const clickSquare = async (board, square, orientation) => {
    const surface = page.getByRole("group", { name: board }).locator("cg-board");
    await surface.scrollIntoViewIfNeeded();
    const bounds = await surface.boundingBox();
    assert.ok(bounds && bounds.width > 200);
    const file = "abcdefgh".indexOf(square[0]);
    const rank = Number(square[1]);
    const x = orientation === "black" ? 7 - file : file;
    const y = orientation === "black" ? rank - 1 : 8 - rank;
    await page.mouse.click(bounds.x + (x + 0.5) * bounds.width / 8, bounds.y + (y + 0.5) * bounds.height / 8);
  };
  const clickMove = async (from, to, orientation) => {
    await clickSquare("Tactic solution board", from, orientation);
    await clickSquare("Tactic solution board", to, orientation);
  };
  const useFen = async fen => {
    await button("Edit board or enter FEN").click();
    await page.getByLabel("Starting position FEN").fill(fen);
    await button("Use FEN").click();
  };
  const addSan = async san => {
    await page.getByLabel("Paste SAN moves").fill(san);
    await button("Add moves").click();
  };
  const saveNotice = () => page.getByText("One tactic saved.", { exact: false }).waitFor();

  await page.goto(url);
  await button("Tactics").click();
  await button("Capture tactics").click();
  const importPgn = '[SetUp "1"]\n[FEN "4k3/8/8/8/8/8/8/R3K3 w - - 0 1"]\n\n1. Ra2 *';
  await page.getByLabel("Or paste PGN").fill(importPgn);
  await button("Preview tactics").click();
  const previewBoard = page.getByRole("group", { name: "Tactic solver preview" });
  await previewBoard.waitFor();
  assert.equal(await previewBoard.locator(".tempo-board-resize-handle").count(), 0);
  await button("Select all valid").click();

  await button("Build a tactic").click();
  await checkDesktopBoardResize(page, "Tactic solution board");
  await button("Edit board or enter FEN").click();
  await checkDesktopBoardResize(page, "Starting position editor");
  await button("Cancel position edit").click();
  await page.setViewportSize({ width: 1000, height: 500 });
  await checkDesktopBoardLayout(page, "Tactic solution board");
  await button("Edit board or enter FEN").click();
  await checkDesktopBoardLayout(page, "Starting position editor");
  await button("Cancel position edit").click();
  await page.setViewportSize({ width: 1120, height: 900 });
  const fen = "r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 23";
  await useFen(fen.replace("0 23", "0 70000"));
  await addSan("O-O");
  await button("Save tactic").click();
  await page.getByText("invalid standard chess FEN", { exact: false }).waitFor();
  assert.deepEqual(requests.map(({ input }) => input.command), ["preview", "preview"]);
  assert.deepEqual(await moves(), ["70000... O-O"]);

  await useFen(fen.replace("KQkq", "qkQK"));
  await clickMove("e8", "g8", "black");
  await page.getByText("23... O-O", { exact: true }).waitFor();
  await addSan("24.Ra2 Ba9");
  await page.getByText(/Move 2.*Ba9/).waitFor();
  assert.deepEqual(await moves(), ["23... O-O"]);
  await addSan("24.Ra2?!");
  await page.getByText("24. Ra2", { exact: true }).waitFor();
  await button("Undo last move").click();
  await clickMove("a1", "a2", "black");
  await page.getByText("24. Ra2", { exact: true }).waitFor();

  await button("Import PGN").click();
  assert.equal(await page.getByLabel("Or paste PGN").inputValue(), importPgn);
  assert.equal(await page.getByRole("checkbox", { name: "Select tactic 1 for capture" }).isChecked(), true);
  await button("Build a tactic").click();
  assert.deepEqual(await moves(), ["23... O-O", "24. Ra2"]);

  dropSave = true;
  await button("Save tactic").click();
  await page.waitForFunction(() => [...document.querySelectorAll("button")]
    .some(control => control.textContent === "Retry capture" && !control.disabled));
  assert.equal(droppedReply.status, "tactics_saved");
  const [preview, save] = requests.slice(-2);
  assert.equal(preview.input.command, "preview");
  assert.equal(save.input.command, "save");
  assert.equal(preview.input.pgn, `[SetUp "1"]\n[FEN "${fen}"]\n[TempoSetupPlies "0"]\n\n23... O-O 24. Ra2 *`);
  assert.equal(save.input.pgn, preview.input.pgn);
  assert.deepEqual(save.input.selected, [0]);
  assert.deepEqual(counts(), { current_content: 1, content_sources: 1, content_receipts: 1, learning: 1, assessments: 0 });
  const sent = requests.length;
  await page.reload();
  await saveNotice();
  assert.deepEqual(requests.slice(sent).map(request => request.bytes), [save.bytes]);
  assert.deepEqual(counts(), { current_content: 1, content_sources: 1, content_receipts: 1, learning: 1, assessments: 0 });
  let response = await page.request.post(url + "/api/tactics-collection", { data: { command: "list", search: "", filter: "all" } });
  const collection = await response.json();
  assert.equal(collection.status, "tactics_page");
  response = await page.request.post(url + "/api/tactics-collection", { data: {
    command: "detail", dataset_id: collection.dataset_id, target: collection.rows[0].target, show_solution: true,
  } });
  const detail = await response.json();
  assert.equal(detail.fen, fen.replace("0 23", "0 1"));
  assert.deepEqual(detail.solution.moves.map(move => move.notation), ["1... O-O", "2. Ra2"]);
  await button("Tactics").click();
  await button(detail.label).click();
  await page.getByRole("group", { name: "Tactic position" }).waitFor();
  await checkDesktopBoardResize(page, "Tactic position");
  await button("Show solution").click();
  await button("1... O-O").waitFor();

  await page.setViewportSize({ width: 390, height: 844 });
  await button("Capture tactics").click();
  await button("Build a tactic").click();
  await button("Edit board or enter FEN").click();
  await button("Clear board").click();
  await button("Use board position").click();
  await page.getByText(/Invalid FEN/).waitFor();
  for (const [label, square] of [["White king", "h1"], ["Black king", "h8"], ["White pawn", "b7"]]) {
    await button(label).click();
    await clickSquare("Starting position editor", square, "white");
  }
  await button("Move pieces").click();
  await clickSquare("Starting position editor", "b7", "white");
  await clickSquare("Starting position editor", "a7", "white");
  await button("White rook").click();
  await clickSquare("Starting position editor", "b7", "white");
  await button("Remove piece").click();
  await clickSquare("Starting position editor", "b7", "white");
  await button("Use board position").click();
  await clickMove("a7", "a8", "white");
  await page.getByRole("dialog", { name: "Choose promotion" }).waitFor();
  await button("Cancel").click();
  await clickMove("a7", "a8", "white");
  await button("Knight").click();
  await page.getByText("1. a8=N", { exact: true }).waitFor();
  await button("Save tactic").click();
  await saveNotice();
  assert.match(requests.at(-1).input.pgn, /\[FEN "7k\/P7\/8\/8\/8\/8\/8\/7K w - - 0 1"\][\s\S]*1\. a8=N \*$/);
  await page.getByRole("list", { name: "Solution moves" }).waitFor({ state: "hidden" });

  await button("Import PGN").click();
  await page.getByLabel("Or paste PGN").fill(importPgn);
  await button("Preview tactics").click();
  await button("Select all valid").click();
  await button("Save selected tactics").click();
  await saveNotice();
  assert.equal(requests.at(-1).input.pgn, importPgn);
  assert.deepEqual(counts(), { current_content: 3, content_sources: 3, content_receipts: 3, learning: 3, assessments: 0 });
  assert.deepEqual(errors, []);
  console.log("FEN and board setup, mixed SAN and board moves, promotion, PGN import, and byte-identical save recovery passed.");
} finally {
  await browser?.close();
  if (server?.exitCode === null && server.pid) {
    const exited = once(server, "exit");
    server.kill();
    await exited;
  }
  await rm(directory, { recursive: true, force: true });
}
