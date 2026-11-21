import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { blackTacticalObservation, changedSolutionObservation, tacticalObservation, tacticalReport } from "./tactical_history_fixture.js";

const bundle = await build({
  stdin: { contents: `
    import React, { act } from "react";
    import { createRoot } from "react-dom/client";
    import { TacticalHistory } from "./TacticalHistory.jsx";
    const root = createRoot(document.getElementById("root"));
    globalThis.renderTactics = dataset => act(() => root.render(<TacticalHistory dataset={dataset} onOpen={address => globalThis.openedGame = address} />));
    globalThis.unmountTactics = () => act(() => root.unmount());
    globalThis.runBrowser = callback => act(async () => { callback(); });
  `, resolveDir: fileURLToPath(new URL("..", import.meta.url)), loader: "jsx" },
  bundle: true, format: "iife", write: false, outdir: "unused", loader: { ".svg": "dataurl" },
});
const script = bundle.outputFiles.find(file => file.path.endsWith(".js")).text;
const response = value => ({ ok: true, status: 200, json: async () => value });

async function mounted(t, handler) {
  const { window } = new JSDOM('<!DOCTYPE html><div id="root"></div>', { url: "http://tempo.test/", runScripts: "outside-only", pretendToBeVisual: true });
  window.IS_REACT_ACT_ENVIRONMENT = true;
  window.TextEncoder = TextEncoder;
  window.AbortController = AbortController;
  window.MessageChannel = class { port1 = {}; port2 = { postMessage: () => setImmediate(() => this.port1.onmessage()) }; };
  const timers = new Map();
  let now = 0;
  let id = 0;
  const nativeSet = window.setTimeout.bind(window);
  const nativeClear = window.clearTimeout.bind(window);
  window.setTimeout = (callback, delay, ...args) => {
    if (delay < 1000 && delay !== 120) return nativeSet(callback, delay, ...args);
    const key = --id;
    timers.set(key, { callback: () => callback(...args), at: now + delay });
    return key;
  };
  window.clearTimeout = id => id < 0 ? timers.delete(id) : nativeClear(id);
  const calls = [];
  window.fetch = async (url, options) => {
    const call = { url, payload: JSON.parse(options.body), headers: options.headers, signal: options.signal };
    calls.push(call);
    assert.ok(["/api/games/tactics", "/api/games/tactics/command", "/api/games/tactics/report",
      "/api/games/tactics/position"].includes(url));
    assert.equal(options.method, "POST");
    return handler(call, calls.length);
  };
  const errors = [];
  window.addEventListener("error", error => errors.push(error.message));
  window.eval(script);
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    await window.unmountTactics();
  }
  t.after(async () => { await close(); window.close(); assert.deepEqual(errors, []); });
  await window.renderTactics("tactics-fixture");
  async function advance(ms) {
    const until = now + ms;
    while (timers.size) {
      const next = Math.min(...Array.from(timers.values(), value => value.at));
      if (next > until) break;
      now = next;
      await window.runBrowser(() => {
        for (const [key, value] of timers) if (value.at === next) { timers.delete(key); value.callback(); }
      });
    }
    now = until;
  }
  const button = label => [...window.document.querySelectorAll("button")].find(button => button.textContent === label);
  return { window, calls, close, advance, timers, button, text: () => window.document.body.textContent,
    click: label => window.runBrowser(() => { assert.ok(button(label), label); button(label).click(); }) };
}

test("mounted history shows measured outcomes and the single chosen puzzle without Study commands", async t => {
  const page = await mounted(t, () => response(tacticalReport()));
  assert.match(page.text(), /4 games checked · 40 decisions scanned/);
  assert.match(page.text(), /Missed capture/);
  assert.match(page.text(), /Selected capture \(current analysis\): Rxa7/);
  assert.match(page.text(), /Recorded Study card: Prioritized in Study/);
  assert.match(page.text(), /You played Kg2/);
  const board = page.window.document.querySelector('[aria-label="Hanging-piece opportunity position"]');
  assert.equal(board.getAttribute("aria-disabled"), "true");
  assert.equal(board.getAttribute("data-orientation"), "white");
  await page.click("Open source game");
  assert.equal(page.window.openedGame.ply, 0);
  assert.equal(page.window.openedGame.game_id, "game-3");
  await page.window.runBrowser(() => {
    [...page.window.document.querySelectorAll('.tactical-list button')].find(button => button.textContent.includes("Declined an inferior capture")).click();
  });
  assert.match(page.text(), /Kept for comparison. This analysis does not add a new puzzle/);
  assert.match(page.window.document.querySelector('.tactical-comparison').textContent, /Best or equivalent moves: Kg2 \(\+10\.00\)/);
  assert.doesNotMatch(page.window.document.querySelector('.tactical-comparison').textContent, /Selected capture|Study card:/);
  assert.ok(page.calls.every(call => call.url === "/api/games/tactics"));
});

test("ready transport status does not present pending or failed scans as up to date", async t => {
  const report = tacticalReport();
  report.statistics.pending_games = 2;
  report.statistics.failed_games = 1;
  const page = await mounted(t, () => response(structuredClone(report)));
  assert.match(page.text(), /Waiting to analyze saved games/);
  assert.doesNotMatch(page.text(), /Analysis up to date/);
  report.statistics.pending_games = 0;
  await page.advance(3000);
  assert.match(page.text(), /Analysis finished with gaps/);
  assert.doesNotMatch(page.text(), /Analysis up to date/);
});

test("revised findings keep earlier Study references separate from the current selected capture", async t => {
  const inferior = tacticalObservation(2, "declined_inferior_capture");
  inferior.puzzle = { target: "previously-issued-card", version: 1 };
  inferior.request_id = 2;
  const uncertain = tacticalObservation(1, "uncertain");
  uncertain.puzzle = { target: "previously-reviewed-card", version: 1 };
  uncertain.request_id = 1;
  uncertain.fulfilled = true;
  const page = await mounted(t, () => response(tacticalReport({ observations: [changedSolutionObservation(3), inferior, uncertain] })));
  assert.match(page.text(), /Selected capture \(current analysis\): Bxf4/);
  assert.match(page.text(), /Recorded Study card: Reviewed in Study/);
  assert.match(page.text(), /recorded Study card keeps its original answer if later analysis changes/);
  assert.doesNotMatch(page.text(), /Puzzle answer/);
  async function select(label) {
    await page.window.runBrowser(() => {
      [...page.window.document.querySelectorAll('.tactical-list button')].find(button => button.textContent.startsWith(label)).click();
    });
  }
  await select("Declined an inferior capture");
  assert.match(page.text(), /Earlier Study card: Prioritized in Study/);
  assert.doesNotMatch(page.text(), /Selected capture/);
  await select("Uncertain");
  assert.match(page.text(), /Earlier Study card: Reviewed in Study/);
  assert.match(page.text(), /This analysis does not add a new puzzle/);
  assert.doesNotMatch(page.text(), /Selected capture/);
});

test("poll failure and unavailability retain visibly stale good results without inventing zeros", async t => {
  let state = "ready";
  const page = await mounted(t, () => {
    if (state === "failed") throw new Error("offline");
    if (state === "unavailable") return response({ schema_version: 1, dataset_id: "tactics-fixture", status: "unavailable", message: "Stockfish is unavailable." });
    return response(tacticalReport());
  });
  state = "failed";
  await page.advance(3000);
  assert.match(page.text(), /latest tactical results could not be read.*last available results/);
  assert.match(page.text(), /4 games checked · 40 decisions scanned/);
  state = "unavailable";
  await page.advance(3000);
  assert.match(page.text(), /Stockfish is unavailable.*last available results/);
  assert.match(page.text(), /Selected capture \(current analysis\): Rxa7/);
  assert.equal(page.timers.size, 0);
  state = "ready";
  await page.click("Refresh tactics");
  assert.doesNotMatch(page.text(), /last available results|Stockfish is unavailable/);
});

test("a custom starting position keeps Black's move number and the original occurrence offset", async t => {
  const row = blackTacticalObservation(9);
  const page = await mounted(t, () => response(tacticalReport({ observations: [row] })));
  assert.match(page.text(), /Black to move · Before 12\.\.\. Kg7/);
  assert.match(page.text(), /Selected capture \(current analysis\): Rxa2/);
  const board = page.window.document.querySelector('[aria-label="Hanging-piece opportunity position"]');
  assert.equal(board.getAttribute("data-orientation"), "black");
  await page.click("Open source game");
  assert.equal(page.window.openedGame.ply, 0);
  assert.equal(page.window.openedGame.start, 0);
});

test("pagination reads a bounded earlier page and Latest returns to the first page", async t => {
  const page = await mounted(t, ({ payload }) => response(payload.before === undefined
    ? tacticalReport({ observations: [tacticalObservation(50)], nextBefore: 50 })
    : tacticalReport({ observations: [tacticalObservation(20, "took_good_capture")] })));
  await page.click("Earlier opportunities");
  assert.deepEqual(page.calls.at(-1).payload, { dataset_id: "tactics-fixture", before: 50 });
  assert.match(page.text(), /Game game-20/);
  await page.click("Latest opportunities");
  assert.deepEqual(page.calls.at(-1).payload, { dataset_id: "tactics-fixture" });
  assert.match(page.text(), /Game game-50/);
});

test("unmount and dataset replacement abort polling and fence an ignored late response", async t => {
  let late;
  const page = await mounted(t, ({ payload }, count) => count === 1
    ? new Promise(resolve => { late = resolve; })
    : response(tacticalReport({ dataset: payload.dataset_id, observations: [tacticalObservation(7, "took_good_capture")] })));
  assert.match(page.text(), /Reading tactical results/);
  await page.window.renderTactics("replacement");
  assert.equal(page.calls[0].signal.aborted, true);
  await page.window.runBrowser(() => late(response(tacticalReport())));
  assert.match(page.text(), /Game game-7/);
  assert.doesNotMatch(page.text(), /Game game-3|Selected capture/);
  await page.close();
  const count = page.calls.length;
  await page.advance(6000);
  assert.equal(page.calls.length, count);
  assert.equal(page.timers.size, 0);
});

test("analysis controls pause, resume and retry through addressed commands", async t => {
  const report = tacticalReport();
  report.paused = false;
  report.waiting_for_idle = false;
  report.games = [
    {source: "pgn", game_id: "g1", white: "Learner", black: "Opponent",
      checked: 2, pending: 3, inconclusive: 1, preparing: false},
  ];
  report.statistics.pending_positions = 3;
  report.statistics.inconclusive_positions = 1;
  report.statistics.retryable_positions = 1;
  const page = await mounted(t, ({url, payload}) => {
    if (url === "/api/games/tactics") return response(structuredClone(report));
    assert.equal(payload.dataset_id, "tactics-fixture");
    if (payload.action === "pause") report.paused = true;
    else if (payload.action === "resume") report.paused = false;
    else if (payload.action === "retry") report.statistics.retryable_positions = 0;
    else assert.fail(payload.action);
    return response({accepted: true});
  });
  assert.match(page.text(), /Learner vs Opponent · 2 checked · 3 pending · 1 inconclusive/);
  await page.click("Pause analysis");
  assert.match(page.text(), /Analysis paused/);
  await page.click("Resume analysis");
  await page.click("Retry inconclusive positions");
  assert.ok(page.button("Retry inconclusive positions").disabled);
  assert.deepEqual(page.calls.filter(call => call.url.endsWith("/command")).map(call => call.payload.action),
    ["pause", "resume", "retry"]);
});

function personalStatus(dataset, completed) {
  const status = tacticalReport({dataset, observations: []});
  status.report_schema = 2;
  status.statistics.completed_games = completed;
  status.statistics.decisions_scanned = completed;
  return status;
}

function personalSnapshot(dataset, analyzed, nextBefore = null) {
  const results = {wins: 0, draws: 0, losses: 0};
  const pattern = {
    bands: [0, 1, 3, 5].map(min => ({min, results, opportunities: 0, misses: 0, days: 0})),
    possible_break: null,
  };
  return {
    schema_version: 2, dataset_id: dataset, archive_games: 10, filtered_games: 10,
    loss_comparison: {with_miss: results, without_miss: results, analyzed,
      opportunity_counts: Array.from({length: 3}, () => [results, results])},
    prior_today: pattern, prior_hour: pattern,
    games: nextBefore === null ? [] : [{
      id: nextBefore, ply: 0, motifs: ["fork"],
      game: {source: "pgn", learner: "white", id: "game-1", result: "win"},
    }],
    next_before: nextBefore, detail: null,
    clocks: [], sources: [], learner_bands: [], opponent_bands: [],
  };
}

test("personal report flags newer analysis but only reads another snapshot on refresh", async t => {
  let completed = 0;
  const page = await mounted(t, ({url, payload}) => response(url.endsWith("/report")
    ? personalSnapshot(payload.dataset_id, completed) : personalStatus(payload.dataset_id, completed)));
  const reportReads = () => page.calls.filter(call => call.url.endsWith("/report")).length;
  await page.advance(120);
  assert.match(page.text(), /Report snapshot/);
  assert.match(page.text(), /0 of 10 matching games fully analyzed/);
  assert.equal(reportReads(), 1);
  completed = 1;
  await page.advance(6100);
  assert.match(page.text(), /1 games checked/);
  assert.match(page.text(), /Newer analysis may be available/);
  assert.match(page.text(), /0 of 10 matching games fully analyzed/);
  assert.equal(reportReads(), 1);
  await page.click("Refresh report");
  assert.match(page.text(), /Reading your games/);
  await page.advance(120);
  assert.match(page.text(), /1 of 10 matching games fully analyzed/);
  assert.doesNotMatch(page.text(), /Newer analysis may be available/);
  assert.equal(reportReads(), 2);
});

test("personal report fences old filter, cursor and dataset results and exposes failed reads", async t => {
  const request = [];
  const page = await mounted(t, call => {
    if (!call.url.endsWith("/report")) return response(personalStatus(call.payload.dataset_id, 0));
    return new Promise((resolve, reject) => request.push({...call, resolve, reject}));
  });
  async function finish(index, analyzed, nextBefore) {
    const {resolve, payload} = request[index];
    await page.window.runBrowser(() => resolve(response(personalSnapshot(payload.dataset_id, analyzed, nextBefore))));
  }
  async function choose(value) {
    await page.window.runBrowser(() => {
      const select = page.window.document.querySelector(".tactical-filters select");
      select.value = value;
      select.dispatchEvent(new page.window.Event("change", {bubbles: true}));
    });
  }
  await page.advance(120);
  await finish(0, 2, 50);
  assert.match(page.text(), /2 of 10 matching games fully analyzed/);

  await page.click("Older");
  assert.match(page.text(), /Reading your games/);
  assert.doesNotMatch(page.text(), /matching games fully analyzed/);
  await page.advance(120);
  assert.equal(request[1].payload.before, 50);
  await choose("fork");
  assert.equal(request[1].signal.aborted, true);
  assert.match(page.text(), /Reading your games/);
  await page.advance(120);
  assert.deepEqual(request[2].payload, {dataset_id: "tactics-fixture", filters: {motif: "fork"}});
  await page.window.runBrowser(() => request[2].reject(new Error("Report unavailable")));
  assert.match(page.text(), /Unable to read the personal tactics report/);
  assert.doesNotMatch(page.text(), /matching games fully analyzed|No analyzed positions match/);
  await finish(1, 3);
  assert.match(page.text(), /Unable to read the personal tactics report/);

  await page.click("Refresh report");
  await page.advance(120);
  assert.deepEqual(request[3].payload, request[2].payload);
  await finish(3, 4);
  assert.match(page.text(), /4 of 10 matching games fully analyzed/);
  assert.match(page.text(), /No analyzed positions match these filters/);
  assert.doesNotMatch(page.text(), /Unable to read the personal tactics report/);

  await page.click("Refresh report");
  await page.advance(120);
  await page.window.renderTactics("replacement");
  assert.equal(request[4].signal.aborted, true);
  await page.advance(120);
  assert.deepEqual(request[5].payload, {dataset_id: "replacement", filters: {}});
  await finish(5, 5);
  await finish(4, 6);
  assert.match(page.text(), /5 of 10 matching games fully analyzed/);
  assert.doesNotMatch(page.text(), /6 of 10 matching games fully analyzed/);
});


test("same-count generation changes mark the snapshot stale and fence its page and detail requests", async t => {
  let generation = "personal:v2:7";
  let available = "personal:v2:6";
  const stale = {
    ok: false, status: 409, json: async () => ({status: "error", code: "report_changed"}),
  };
  const page = await mounted(t, ({url, payload, headers}) => {
    if (url === "/api/games/tactics") {
      assert.equal(headers["X-Tempo-Tactics-Report-Generation"], "1");
      return response({...personalStatus(payload.dataset_id, 10), report_generation: available});
    }
    if (payload.report_generation !== undefined && payload.report_generation !== generation) return stale;
    assert.equal(url, "/api/games/tactics/report");
    return response({...personalSnapshot(payload.dataset_id, 10, payload.before ? null : 50),
      report_generation: generation});
  });
  await page.advance(120);
  assert.match(page.text(), /10 of 10 matching games fully analyzed/);
  assert.doesNotMatch(page.text(), /Newer analysis may be available/);
  generation = available = "personal:v2:8";
  await page.advance(3000);
  assert.match(page.text(), /Newer analysis may be available/);
  assert.equal(page.calls.filter(call => call.url.endsWith("/report")).length, 1);

  await page.click("Fork / double attack · win");
  assert.deepEqual(page.calls.at(-1).payload, {
    dataset_id: "tactics-fixture", id: 50, report_generation: "personal:v2:7",
  });
  assert.match(page.text(), /Refresh the report to read the selected position/);
  assert.match(page.text(), /10 of 10 matching games fully analyzed/);

  await page.click("Older");
  await page.advance(120);
  assert.deepEqual(page.calls.at(-1).payload, {
    dataset_id: "tactics-fixture", filters: {}, before: 50, report_generation: "personal:v2:7",
  });
  assert.match(page.text(), /Refresh the report to continue/);
  assert.doesNotMatch(page.text(), /matching games fully analyzed/);

  await page.click("Refresh report");
  await page.advance(120);
  assert.deepEqual(page.calls.at(-1).payload, {dataset_id: "tactics-fixture", filters: {}, before: 50});
  assert.match(page.text(), /10 of 10 matching games fully analyzed/);
  assert.doesNotMatch(page.text(), /Newer analysis may be available|Refresh the report to continue/);
});
