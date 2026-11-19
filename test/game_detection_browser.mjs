// Run with the assembled Tempo workspace, installed Playwright, built production
// and fixture binaries, and built UI. The fixture uses the production HTTP host.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { databaseRows } from "../../tempo/tests/support/game_detection_readback.mjs";

const [tempoInput, fixtureInput, uiInput] = process.argv.slice(2);
assert.ok(tempoInput && fixtureInput && uiInput,
  "Usage: node game_detection_browser.mjs PRODUCTION_BINARY FIXTURE_BINARY UI_DIST");
const [tempo, fixture, ui] = [tempoInput, fixtureInput, uiInput].map(path => resolve(path));
const { chromium } = await import(process.env.TEMPO_PLAYWRIGHT || "playwright");
const directory = await mkdtemp(join(tmpdir(), "tempo-detector-browser-"));
const database = join(directory, "disposable.sqlite");
let child;
let browser;
let base;
let diagnostics;

async function start(scenario) {
  child = scenario
    ? spawn(fixture, [database, ui, "0", scenario])
    : spawn(tempo, ["serve", database, ui, "0"]);
  diagnostics = "";
  child.stderr.on("data", data => { diagnostics += data; });
  base = await new Promise((resolve, reject) => {
    let stdout = "";
    const startup = setTimeout(() => reject(new Error(`Detector host did not start. ${diagnostics}`)), 8000);
    child.stdout.on("data", data => {
      stdout += data;
      const match = /^Tempo study at (http:\/\/127\.0\.0\.1:\d+)$/m.exec(stdout);
      if (match) {
        clearTimeout(startup);
        resolve(match[1]);
      }
    });
    child.once("error", error => { clearTimeout(startup); reject(error); });
    child.once("exit", code => { clearTimeout(startup); reject(new Error(`Host exited (${code}). ${diagnostics}`)); });
  });
}

async function stop() {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exit = once(child, "exit");
    child.kill();
    await exit;
  }
  child = undefined;
}

async function api(route, payload) {
  const response = await fetch(base + "/api/" + route, payload === undefined ? {} : {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const value = await response.json();
  assert.equal(response.status, 200, JSON.stringify(value));
  return value;
}

// Observe requests rather than substituting any route. Node requests above
// are only fixture initialization or independent state checks.
const detectorRoutes = new Set(["/api/games/detectors", "/api/games/detection", "/api/games/detection-result"]);
const commands = [];

async function games() {
  const page = await browser.newPage();
  page.setDefaultTimeout(6000);
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/")) {
      commands.push({
        path, method: request.method(),
        body: request.method() === "POST" ? request.postDataJSON() : undefined,
      });
    }
  });
  await page.goto(base);
  await page.getByRole("button", { name: "Games", exact: true }).click();
  return page;
}

function panel(page) {
  return page.getByRole("region", { name: "Game detector" });
}

async function select(page, learner) {
  await page.locator(".game-results > li").filter({ hasText: learner.toLowerCase() })
    .getByRole("button", { name: "Analyze this game", exact: true }).click();
}

function terminal(page, timeout = 4000) {
  return page.waitForResponse(async response => {
    if (new URL(response.url()).pathname !== "/api/games/detection-result") return false;
    return (await response.json()).status !== "running";
  }, { timeout }).then(response => response.json());
}

async function run(page, message) {
  const outcome = terminal(page);
  await panel(page).getByRole("button", { name: "Run detector" }).click();
  await panel(page).getByText(message, { exact: true }).waitFor();
  return outcome;
}

function onlyDetectorRequestsSince(startIndex) {
  const emitted = commands.slice(startIndex).filter(request => request.method === "POST");
  assert.ok(emitted.some(request => request.path === "/api/games/detection"));
  for (const request of emitted) {
    assert.ok(detectorRoutes.has(request.path), `Unexpected request during detection: ${JSON.stringify(request)}`);
  }
}

try {
  execFileSync(tempo, ["init", database]);
  await start();
  const { dataset_id } = await api("repertoires", { command: "list" });
  const book = { dataset_id, name: "Fixture repertoire", pgn: "1. e4 e5 2. Nf3 *", learner_color: "white" };
  const preview = await api("repertoires", { command: "preview", ...book });
  const saved = await api("repertoires", { command: "save", token: preview.token, ...book });
  const repertoire = saved.repertoires.find(item => item.name === book.name);
  assert.ok(repertoire);

  // A has repeated canonical positions and starts with Black at fullmove 12.
  const gameA = '[White "North"]\n[Black "South"]\n[Result "0-1"]\n[SetUp "1"]\n'
    + '[FEN "4k1n1/4p3/8/8/8/8/4P3/4K1N1 b - - 7 12"]\n'
    + '12...Nf6 13.Nf3 Ng8 14.Ng1 e5 15.e4 0-1\n';
  const gameB = '[White "East"]\n[Black "West"]\n[Result "0-1"]\n[SetUp "1"]\n'
    + '[FEN "4k3/4p3/8/8/8/8/4P3/4K3 b - - 1 13"]\n13...e5 14.e4 0-1\n';
  for (const [learner, pgn] of [["South", gameA], ["West", gameB]]) {
    const report = await api("games/import", { dataset_id, command_id: `seed-${learner}`, learner, pgn });
    assert.equal(report.new_games, 1, JSON.stringify(report));
  }
  const { results } = await api("games");
  const accepted = learner => results.find(item => item.learner === learner.toLowerCase());
  assert.ok(accepted("South") && accepted("West"), JSON.stringify(results));
  const study = await api("study", { command: "next" });
  assert.ok(study.attempt_id, JSON.stringify(study));

  browser = await chromium.launch({ channel: "chrome", headless: true });
  let page = await games();
  await select(page, "South");
  await panel(page).getByText("Game detectors are not configured.", { exact: true }).waitFor();
  assert.equal(await panel(page).getByRole("button", { name: "Run detector" }).count(), 0);
  await page.close();
  await stop();

  await start("delayed");
  let before = databaseRows(database);
  page = await games();
  await select(page, "South");
  await panel(page).getByRole("combobox", { name: "Detector", exact: true }).selectOption("contract-fixture");
  let mark = commands.length;
  const black = await run(page, "Half-move 0 · Black to move");
  assert.equal(black.findings[0].candidate_move.uci, "g8f6");
  assert.match(black.findings[0].fen, /b - - 7 12$/);
  const board = panel(page).getByRole("group", { name: "Detector finding position" });
  assert.equal(await board.getAttribute("data-fen"), black.findings[0].fen);
  assert.equal(await board.getAttribute("data-orientation"), "black");
  assert.equal(await board.getAttribute("aria-disabled"), "true");
  assert.equal(black.occurrence_count, 7);
  assert.equal(black.game_id, accepted("South").game_id);
  assert.equal(black.source, accepted("South").source);
  assert.equal(black.dataset_id, dataset_id);
  await panel(page).getByText("First played move by the selected learner.", { exact: true }).waitFor();
  onlyDetectorRequestsSince(mark);
  assert.match(diagnostics, /"learner":"black"/);
  assert.match(diagnostics, /"occurrence_count":7/);
  assert.deepEqual(databaseRows(database), before);

  await panel(page).getByLabel("Player perspective").fill("North");
  const white = await run(page, "Half-move 1 · White to move");
  assert.equal(white.learner_color, "white");
  assert.notEqual(white.input_key, black.input_key);

  await panel(page).getByRole("combobox", { name: "Detector", exact: true }).selectOption("contract-alternate");
  const alternate = await run(page, "Half-move 1 · White to move");
  assert.equal(alternate.input_key, white.input_key);
  assert.notEqual(alternate.analysis_key, white.analysis_key);
  assert.notEqual(alternate.findings[0].finding_id, white.findings[0].finding_id);
  assert.deepEqual(databaseRows(database), before);
  await page.close();

  await api("repertoires", { command: "rename", dataset_id, repertoire_id: repertoire.id, name: "Renamed fixture" });
  before = databaseRows(database);
  page = await games();
  await select(page, "South");
  await panel(page).getByRole("combobox", { name: "Detector", exact: true }).selectOption("contract-fixture");
  const renamed = await run(page, "Half-move 0 · Black to move");
  assert.equal(renamed.analysis_key, black.analysis_key);
  assert.equal(renamed.findings[0].finding_id, black.findings[0].finding_id);
  assert.deepEqual(databaseRows(database), before);
  await page.close();
  await stop();

  for (const [scenario, message] of [
    ["empty", "The selected detector reported no observations."],
    ["unsupported", "This detector does not support this game."],
    ["failed", "The detector could not complete this game."],
    ["invalid", "Tempo rejected an invalid detector result."],
    ["slow", "The detector ran out of time."],
  ]) {
    await start(scenario);
    before = databaseRows(database);
    page = await games();
    await select(page, "South");
    await panel(page).getByRole("combobox", { name: "Detector", exact: true }).selectOption("contract-fixture");
    await run(page, message);
    assert.equal(await panel(page).getByText("Half-move", { exact: false }).count(), 0, scenario);
    assert.deepEqual(databaseRows(database), before);
    await page.close();
    await stop();
  }

  await start("delayed");
  before = databaseRows(database);
  page = await games();
  await select(page, "South");
  await panel(page).getByRole("combobox", { name: "Detector", exact: true }).selectOption("contract-fixture");
  mark = commands.length;
  const started = page.waitForResponse(response => response.url().endsWith("/api/games/detection")
    && response.status() === 202);
  await panel(page).getByRole("button", { name: "Run detector" }).click();
  await started;
  await select(page, "West");
  await panel(page).getByRole("combobox", { name: "Detector", exact: true }).selectOption("contract-fixture");
  await panel(page).getByRole("button", { name: "Run detector" }).click();
  await panel(page).getByText("A detector is still working. Try again in a moment.", { exact: true }).waitFor();
  await pause(1400);
  assert.equal(await panel(page).getByText("Half-move", { exact: false }).count(), 0);
  const west = await run(page, "Half-move 0 · Black to move");
  assert.equal(west.game_id, accepted("West").game_id);
  assert.equal(west.findings[0].candidate_move.uci, "e7e5");
  onlyDetectorRequestsSince(mark);

  await select(page, "South");
  await panel(page).getByRole("combobox", { name: "Detector", exact: true }).selectOption("contract-fixture");
  const startedAgain = page.waitForResponse(response => response.url().endsWith("/api/games/detection")
    && response.status() === 202);
  await panel(page).getByRole("button", { name: "Run detector" }).click();
  await startedAgain;
  const studyContinues = page.waitForResponse(async response =>
    response.url().endsWith("/api/study") && (await response.json()).attempt_id === study.attempt_id);
  await page.getByRole("button", { name: "Study", exact: true }).click();
  await studyContinues;
  const clientPolls = commands.filter(request => request.path === "/api/games/detection-result").length;
  await pause(1400);
  assert.equal(commands.filter(request => request.path === "/api/games/detection-result").length, clientPolls);
  assert.equal(await panel(page).count(), 0);
  assert.deepEqual(databaseRows(database), before);
  assert.ok(commands.every(request => !["answer", "acknowledge"].includes(request.body?.command)));
  await page.close();
  console.log("Browser verified real detector discovery, addressed findings, outcomes, ownership and preserved durable state.");
} catch (error) {
  for (const context of browser?.contexts() ?? []) {
    for (const page of context.pages()) {
      const panelText = await panel(page).allTextContents();
      if (panelText.length) console.error("Detector panel at failure:", panelText);
    }
  }
  throw error;
} finally {
  await browser?.close();
  await stop();
  await rm(directory, { force: true, recursive: true });
}
