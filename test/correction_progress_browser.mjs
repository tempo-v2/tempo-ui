// Run from the assembled workspace with TEMPO_BINARY and TEMPO_PLAYWRIGHT.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";

const { chromium } = await import(process.env.TEMPO_PLAYWRIGHT || "playwright");
const root = await mkdtemp(join(tmpdir(), "tempo-correction-progress-"));
const database = join(root, "study.sqlite");
const binary = resolve(process.env.TEMPO_BINARY || "target/release/tempo");
let server;
let browser;
let sql;

try {
  execFileSync(binary, ["init", database]);
  server = spawn(binary, ["serve", database, resolve("tempo-ui/dist"), "0"],
    { stdio: ["ignore", "pipe", "inherit"] });
  const lines = createInterface({ input: server.stdout });
  const origin = await Promise.race([
    once(lines, "line").then(([line]) => line.replace("Tempo study at ", "")),
    once(server, "exit").then(([code]) => { throw Error(`Tempo exited (${code})`); }),
  ]);
  const post = async (path, input) => {
    const response = await fetch(`${origin}/api/${path}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
    });
    const result = await response.json();
    assert(response.ok && result?.status !== "error", JSON.stringify(result));
    return result;
  };
  const { dataset_id } = await post("repertoires", { command: "list" });
  const book = { dataset_id, name: "Opening", learner_color: "white", pgn: "1. e4 e5 2. Nf3 *" };
  const { token } = await post("repertoires", { command: "preview", ...book });
  await post("repertoires", { command: "save", ...book, token });
  const importMiss = (id, line) => post("games/import", {
    dataset_id, command_id: id, learner: "Learner",
    pgn: `[White "Learner"]\n[Black "Opponent"]\n[Date "2024.10.06"]\n\n${line} 1-0`,
  });
  await importMiss("deep-miss", "1. e4 e5 2. Bc4");
  const issued = await post("study", { command: "next" });
  assert.equal(issued.lesson.move_san, "Nf3");
  await importMiss("first-move-miss", "1. d4 d5");
  assert.equal((await post("study-progress", null)).repairs_remaining, 2);
  const { context } = await post("study/game-context", { dataset_id, attempt_id: issued.attempt_id });

  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1320, height: 900 } });
  page.setDefaultTimeout(8000);
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  const commands = [];
  page.on("request", request => {
    if (request.url() === `${origin}/api/study`) commands.push(request.postDataJSON().command);
  });
  const heading = text => page.getByRole("heading", { name: text, exact: true });
  const button = name => page.getByRole("button", { name, exact: true });
  const prefix = page.locator(".correction-context");
  await page.goto(origin);
  await heading("Repertoire correction (2 remaining)").waitFor().catch(async error => {
    throw Error(`${await page.locator("body").innerText()}\n${pageErrors.join("\n")}`, { cause: error });
  });
  await prefix.waitFor();
  assert.equal((await prefix.innerText()).trim(), "Moves before the decision\n1. e4 e5");

  await page.route("**/api/study/game-context", route => route.fulfill({ json: {
    context: { ...context, line: { start_fen: context.line.moves[0].fen, moves: context.line.moves.slice(1) } },
  } }), { times: 1 });
  await page.reload();
  await prefix.waitFor();
  assert.equal((await prefix.innerText()).trim(), "Moves before the decision\n1... e5");
  await page.reload();
  await prefix.waitFor();

  await page.setViewportSize({ width: 390, height: 820 });
  const commandsBeforeReplay = commands.length;
  await button("Replay game").click();
  await page.waitForFunction(fen =>
    document.querySelector('[aria-label="Game replay chessboard"]')?.dataset.fen === fen,
  context.line.moves.at(-1).fen);
  await button("Return to exercise").click();
  await prefix.waitFor();
  await page.waitForFunction(() => document.documentElement.scrollWidth <= window.innerWidth);
  assert.equal(commands.length, commandsBeforeReplay);

  const board = page.locator(".study-board cg-board");
  await board.scrollIntoViewIfNeeded();
  const rect = await board.boundingBox();
  assert(rect);
  for (const [file, rank] of [[6, 7], [5, 5]]) {
    await page.mouse.click(rect.x + (file + 0.5) * rect.width / 8, rect.y + (rank + 0.5) * rect.height / 8);
  }
  await page.getByText(/Move reproduced/).waitFor();
  await heading("Repertoire correction (2 remaining)").waitFor();
  let failNext = true;
  await page.route("**/api/study", async route => {
    if (failNext && route.request().postDataJSON().command === "next") {
      failNext = false;
      await route.abort();
    } else {
      await route.continue();
    }
  });
  sql = new DatabaseSync(database, { readOnly: true });
  const rows = table => sql.prepare(`SELECT count(*) AS count FROM ${table}`).get().count;
  const receiptsBefore = rows("receipts");
  const assessmentsBefore = rows("assessments");
  await button("Got it — continue").click();
  await button("Retry next exercise").waitFor();
  await heading("Repertoire correction (1 remaining)").waitFor();
  assert.equal(rows("receipts"), receiptsBefore + 1);
  assert.equal(rows("assessments"), assessmentsBefore);
  await button("Retry next exercise").click();
  await page.getByText(/You played d4 in your game/).waitFor();
  await heading("Repertoire correction (1 remaining)").waitFor();
  assert.equal(await prefix.count(), 0);
  assert.deepEqual(commands.slice(commandsBeforeReplay), ["acknowledge", "next", "next"]);
  assert.equal(rows("receipts"), receiptsBefore + 1);

  await page.route("**/api/study/game-context", route => route.fulfill({ json: { context: null } }));
  const sourceRead = page.waitForResponse(response => response.url().endsWith("/api/study/game-context"));
  await page.reload();
  await sourceRead;
  await heading("Repertoire correction (1 remaining)").waitFor();
  assert.equal(await prefix.count(), 0);
  assert.equal(await button("Replay game").count(), 0);
  assert(await page.getByText("Play e4 on the board.").isVisible());

  await page.route("**/api/study-progress", async route => {
    const response = await route.fetch();
    const progress = await response.json();
    delete progress.repairs_remaining;
    await route.fulfill({ response, json: progress });
  });
  await page.reload();
  await heading("Today").waitFor();
  await heading("Repertoire correction").waitFor();
  assert.deepEqual(pageErrors, []);
  console.log("Correction context, remaining count, replay, and Next recovery passed.");
} finally {
  sql?.close();
  await browser?.close();
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = once(server, "exit");
    server.kill();
    await exited;
  }
  await rm(root, { recursive: true, force: true });
}
