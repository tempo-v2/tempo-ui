// Run with the matched Tempo binary and built desktop UI on a disposable store.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { checkDesktopBoardResize } from "./desktop_board_resize_browser.mjs";

const { chromium } = await import(process.env.TEMPO_PLAYWRIGHT || "playwright");
const binary = resolve(process.env.TEMPO_BINARY || "target/release/tempo");
const ui = resolve("tempo-ui/dist");
const scratch = await mkdtemp(join(tmpdir(), "tempo-opponent-moves-"));
const database = join(scratch, "study.sqlite");
const beforeFen = "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1";
const pgn = `[SetUp "1"]\n[FEN "${beforeFen}"]\n[TempoSetupPlies "1"]\n\n1... d5 2. c4 e6 3. Nc3 Nf6 4. Bg5 *`;
const boardLabel = '[aria-label="Study chessboard"]';
let server, browser;

try {
  execFileSync(binary, ["init", database]);
  server = spawn(binary, ["serve", database, ui, "0"], { stdio: ["ignore", "pipe", "inherit"] });
  const output = createInterface({ input: server.stdout });
  const origin = await Promise.race([
    once(output, "line").then(([line]) => line.replace("Tempo study at ", "")),
    once(server, "exit").then(([code]) => { throw Error(`Tempo exited (${code})`); }),
  ]);
  async function post(path, command, headers) {
    const result = await fetch(origin + "/api/" + path, {
      method: "POST", headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(command),
    });
    assert.equal(result.status, 200);
    return result.json();
  }
  const { dataset_id } = await post("study", { command: "study_status" });
  const capture = { dataset_id, pgn };
  const preview = await post("tactics", { command: "preview", ...capture });
  assert.equal(preview.rows[0].status, "valid", JSON.stringify(preview.rows[0]));
  const saved = await post("tactics", { command: "save", ...capture, token: preview.token, selected: [0] });
  assert.equal(saved.status, "tactics_saved");
  const oldView = await post("study", { command: "next" }, { "X-Tempo-Move-Details": "1" });
  assert.equal(oldView.status, "ready");
  assert.equal(oldView.opponent_move, undefined);
  const view = await post("study", { command: "next" }, { "X-Tempo-Study-Opponent-Moves": "1" });
  assert.deepEqual(view, {
    ...oldView, opponent_move: { before_fen: beforeFen, uci: "d7d5" },
  });
  assert.equal(view.prompt.expected, undefined);

  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(6000);
  await page.addInitScript(label => {
    window.boardFrames = [];
    new MutationObserver(() => {
      const board = document.querySelector(label);
      if (!board) return;
      const fen = board.dataset.fen;
      if (window.boardFrames.at(-1)?.fen === fen) return;
      window.boardFrames.push({ fen, locked: board.getAttribute("aria-disabled"), at: performance.now() });
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-fen"] });
  }, boardLabel);
  const commands = [];
  page.on("request", request => {
    if (request.url().endsWith("/api/study")) commands.push(request.postDataJSON());
  });
  const root = page.locator(boardLabel);
  const board = root.locator("cg-board");
  async function move(uci) {
    await page.waitForFunction(label => document.querySelector(label)?.getAttribute("aria-disabled") === "false", boardLabel);
    await board.scrollIntoViewIfNeeded();
    const rect = await board.boundingBox();
    for (const offset of [0, 2]) {
      const file = uci.charCodeAt(offset) - 97;
      const rank = 8 - Number(uci[offset + 1]);
      await page.mouse.click(rect.x + (file + 0.5) * rect.width / 8, rect.y + (rank + 0.5) * rect.height / 8);
    }
  }
  const arrow = (uci, color = "red") => page.waitForFunction(([label, uci, color]) =>
    [...document.querySelectorAll(label + " svg.cg-shapes g[cgHash]")].some(shape =>
      shape.getAttribute("cgHash").includes(`,${uci.slice(0, 2)},${uci.slice(2, 4)},${color}`)),
    [boardLabel, uci, color]);
  await page.goto(origin);
  await arrow("d7d5");
  const [before, after] = await page.evaluate(() => window.boardFrames);
  assert.equal(before.fen, beforeFen);
  assert.equal(before.locked, "true");
  assert.equal(after.fen, view.display_fen);
  assert.equal(after.locked, "false");
  assert.ok(after.at - before.at >= 200, "The pre-move board needs a visible delay");
  assert.deepEqual(commands.map(command => command.command), ["next"]);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await arrow("d7d5");
  assert.deepEqual(await page.evaluate(() => window.boardFrames.map(frame => frame.fen)), [view.display_fen]);
  await board.evaluate(element => { window.liveStudyBoard = element; });
  const resizedWidth = await checkDesktopBoardResize(page, "Study chessboard");
  assert.deepEqual(commands.map(command => command.command), ["next", "next"]);

  const touch = await browser.newPage({ viewport: { width: 1440, height: 900 }, hasTouch: true, isMobile: true });
  await touch.goto(origin);
  await touch.locator(boardLabel).waitFor();
  assert.equal(await touch.locator(".tempo-board-resize-handle").count(), 0);
  await touch.close();

  const interrupted = await browser.newPage({ reducedMotion: "reduce" });
  await interrupted.addInitScript(() => {
    const schedule = window.setTimeout.bind(window);
    // Give the test time to leave during the hold on a slow test machine.
    window.setTimeout = (fn, ms, ...args) => schedule(fn, ms === 250 ? 1500 : ms, ...args);
  });
  await interrupted.goto(origin);
  await interrupted.getByText("Opponent to move", { exact: true }).waitFor();
  assert.equal(await interrupted.locator(boardLabel).getAttribute("data-fen"), beforeFen);
  await interrupted.getByRole("button", { name: "Saved for review", exact: true }).click();
  await interrupted.getByRole("button", { name: "Back to Study", exact: true }).click();
  await interrupted.waitForFunction(([label, fen]) =>
    document.querySelector(label)?.dataset.fen === fen, [boardLabel, view.display_fen]);
  assert.equal(await interrupted.getByText("Opponent to move", { exact: true }).count(), 0);
  await interrupted.close();

  await move("c2c4");
  await arrow("e7e6");
  await page.getByText("Move 2 of 3").waitFor();
  assert.equal((await board.boundingBox()).width, resizedWidth);
  await move("g1f3"); // Legal, but the saved line expects Nc3 here.
  await arrow("b1c3", "blue");
  await arrow("e7e6");
  assert.ok(await board.evaluate(element => element === window.liveStudyBoard));

  await page.reload();
  await arrow("e7e6");
  await page.getByText("Move 2 of 3").waitFor();
  await board.evaluate(element => { window.liveStudyBoard = element; });
  await move("b1c3");
  await arrow("g8f6");
  await page.getByText("Move 3 of 3").waitFor();
  assert.ok(await board.evaluate(element => element === window.liveStudyBoard));
  assert.equal(await page.evaluate(fen => window.boardFrames.some(frame => frame.fen === fen), beforeFen), false);

  const transfer = join(scratch, "solver-first.json");
  await writeFile(transfer, JSON.stringify({ schema_version: 1, puzzles: [{
    namespace: "no-previous-move", source_id: "mate", solver_fen: "7k/8/5KQ1/8/8/8/8/8 w - - 0 1",
    solution: ["g6g7"], label: "Solver-first", provenance: [],
  }] }));
  execFileSync(binary, ["import-tactics", database, transfer]);
  await move("c1g5");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.waitForFunction(label => document.querySelector(label)?.dataset.fen.startsWith("7k/8/5KQ1/"), boardLabel);
  assert.equal(await root.locator("svg.cg-shapes g[cgHash]").count(), 0);
  assert.deepEqual(commands.map(command => command.command), ["next", "next", "answer", "answer", "next", "answer", "answer", "next"]);

  const beforeCompletion = await board.boundingBox();
  const commandCount = commands.length;
  await board.evaluate(element => {
    const container = element.closest(".study-board");
    const observer = new MutationObserver(() => {
      const cue = container.querySelector('[role="status"]');
      if (!cue?.textContent.includes("Exercise complete")) return;
      const { x, y, width, height } = element.getBoundingClientRect();
      window.completedStudyBoardBounds = { x, y, width, height };
      observer.disconnect();
    });
    observer.observe(container, { childList: true });
  });
  const [next] = await Promise.all([
    page.waitForResponse(response => response.url() === origin + "/api/study" &&
      response.request().postDataJSON()?.command === "next"),
    move("g6g7"),
  ]);
  assert.ok(next.ok());
  await page.getByRole("status").filter({ hasText: "Exercise complete" }).waitFor({ state: "hidden" });
  assert.deepEqual(await page.evaluate(() => window.completedStudyBoardBounds), beforeCompletion,
    "The completion checkmark should leave the board in place");
  assert.deepEqual(commands.slice(commandCount).map(command => command.command), ["answer", "next"]);
  console.log("Desktop Study keeps the board in place through replies, correction and the completion checkmark.");
} finally {
  await browser?.close();
  if (server?.exitCode === null && server.signalCode === null) {
    const exited = once(server, "exit");
    server.kill();
    await exited;
  }
  await rm(scratch, { recursive: true, force: true });
}
