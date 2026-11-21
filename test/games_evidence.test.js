import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const pendingKey = "tempo.games.pending.v1";
const bundle = await build({
  stdin: {
    contents: `
      import React, { act } from "react";
      import { createRoot } from "react-dom/client";
      import { GamesPage } from "./GamesPage.jsx";
      const root = createRoot(document.getElementById("root"));
      globalThis.mountGames = () => act(() => {
        root.render(<GamesPage onStudy={() => {}} onRepertoires={() => {}} onGap={() => {}} />);
      });
      globalThis.unmountGames = () => act(() => root.unmount());
      globalThis.runBrowser = callback => act(async () => { callback(); });
    `,
    resolveDir: fileURLToPath(new URL("..", import.meta.url)),
    loader: "jsx",
  },
  bundle: true,
  format: "iife",
  write: false,
  outdir: "unused",
  loader: { ".svg": "dataurl" },
});
const script = bundle.outputFiles.find(file => file.path.endsWith(".js")).text;

function clockFor(window, simulateRecovery = false) {
  const timers = new Map();
  let now = 0;
  let nextId = 0;
  function schedule(callback, delay, kind) {
    const id = --nextId;
    timers.set(id, { callback, due: now + delay, kind });
    return id;
  }
  const nativeSet = window.setTimeout.bind(window);
  const nativeClear = window.clearTimeout.bind(window);
  // Keep React's short scheduler tasks real. Advance polling and deadlines by hand.
  window.setTimeout = (callback, delay, ...args) => delay >= 1000 || (simulateRecovery && delay === 0)
    ? schedule(() => callback(...args), delay, "poll")
    : nativeSet(callback, delay, ...args);
  window.clearTimeout = id => id < 0 ? timers.delete(id) : nativeClear(id);
  window.AbortController = AbortController;
  window.AbortSignal = {
    any: AbortSignal.any,
    timeout(delay) {
      const controller = new AbortController();
      schedule(() => controller.abort(new DOMException("Deadline reached", "TimeoutError")), delay);
      return controller.signal;
    },
  };
  async function advance(elapsed) {
    const until = now + elapsed;
    while (timers.size > 0) {
      const due = Math.min(...Array.from(timers.values(), timer => timer.due));
      if (due > until) break;
      now = due;
      await window.runBrowser(() => {
        for (const [id, timer] of timers) {
          if (timer.due !== due) continue;
          timers.delete(id);
          timer.callback();
        }
      });
    }
    now = until;
  }
  return {
    advance,
    pollTimers: () => [...timers.values()].filter(timer => timer.kind === "poll").length,
  };
}

const model = (status, dataset = "evidence-fixture") => ({
  status, ...(status === "idle" ? {} : { dataset_id: dataset }), profile: "Maia Rapid 1500", completed: status === "running" ? 1 : 2, total: 2,
});

const backfill = (status, jobId = "history-fixture", datasetId = "evidence-fixture") => ({
  status,
  job_id: jobId,
  request: { command_id: jobId, dataset_id: datasetId },
  active_window: status === "running" ? 0 : 1,
  incomplete_windows: 0,
  pending_windows: status === "running" ? 1 : 0,
  windows: [{
    status,
    learner: jobId,
    source: "lichess",
    from_ms: Date.UTC(2026, 10, 9),
    to_ms: Date.UTC(2026, 10, 10),
    notes: [],
    attempt: 0,
    received: 1,
    accepted: status === "running" ? 0 : 1,
  }],
});

const gapPage = (move, more = false) => ({
  dataset_id: "evidence-fixture",
  more,
  gaps: move ? [{
    repertoire_id: "book", actual_move: move, actual_san: move.slice(2), position: "fixture", document_revision: 8, games: 1,
  }] : [],
});

const retryLabel = "Retry evidence reads";
const analyzeLabel = "Analyze Maia probabilities";
const backfillLabel = "Start historical backfill";
const gapLabel = "Fix response";
const emptyGaps = "No confirmed opponent gaps";
const response = (body, status = 200) => ({ status, ok: status < 400, json: async () => body });
const failure = message => response({ status: "error", code: "fixture_unavailable", retryable: true, message }, 503);
const catalog = () => response({
  schema_version: 4, status: "repertoires", dataset_id: "evidence-fixture",
  repertoires: [{ id: "book", name: "Book", learner_color: "white", positions: 2 }],
});
const hang = signal => new Promise((_, reject) => {
  signal.throwIfAborted();
  signal.addEventListener("abort", () => reject(signal.reason), { once: true });
});

async function openGames(t, handlers, { pending, gapContinuation, setup } = {}) {
  const { window } = new JSDOM('<!DOCTYPE html><div id="root"></div>', {
    url: "http://tempo.test/", runScripts: "outside-only", pretendToBeVisual: true,
  });
  window.IS_REACT_ACT_ENVIRONMENT = true;
  window.TextEncoder = TextEncoder;
  // React's act uses a MessageChannel to drain tasks in a browser.
  window.MessageChannel = class {
    port1 = {};
    port2 = { postMessage: () => setImmediate(() => this.port1.onmessage()) };
  };
  const clock = clockFor(window, !!gapContinuation);
  const calls = [];
  const errors = [];
  let mounted = true;
  const unmount = async () => {
    if (!mounted) return;
    mounted = false;
    await window.unmountGames();
  };
  t.after(async () => {
    await unmount();
    window.close();
    assert.deepEqual(errors, []);
  });
  const defaults = {
    "POST /api/repertoires": catalog,
    "GET /api/games": () => response({ results: [], last_successful_refresh_ms: null }),
    "POST /api/games/library": ({payload}) => response({dataset_id:payload.dataset_id, through:0, next_before:null, entries:[]}),
    "POST /api/games/tactics": ({payload}) => response({schema_version:1,dataset_id:payload.dataset_id,status:"unavailable",message:"Stockfish is unavailable."}),
    "GET /api/games/job": () => response({ status: "idle" }),
    "GET /api/games/backfill": () => response({ status: "idle" }),
    "GET /api/games/model": () => response(model("idle")),
    "GET /api/games/gaps": () => response(gapPage()),
  };
  window.fetch = async (url, { method = "GET", body, signal } = {}) => {
    const path = new URL(url, window.location.href).pathname;
    const endpoint = `${method} ${path}`;
    const request = { endpoint, signal, body, payload: body === undefined ? undefined : JSON.parse(body) };
    calls.push(request);
    const handle = handlers[endpoint] ?? defaults[endpoint];
    if (handle) return handle(request);
    errors.push(`Unexpected request to ${endpoint}`);
    return failure("Unexpected request");
  };
  window.addEventListener("error", event => errors.push(event.message));
  if (pending !== undefined) window.sessionStorage.setItem(pendingKey, pending);
  if (gapContinuation) {
    window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    window.HTMLDialogElement.prototype.close = function () { this.open = false; };
    window.sessionStorage.setItem("tempo-gap-save-continuation-v1", JSON.stringify(gapContinuation));
  }
  setup?.(window);
  window.eval(script);
  await window.mountGames();
  const button = label => [...window.document.querySelectorAll("button")].find(item => item.textContent === label);
  return {
    ...clock,
    button,
    calls,
    count: endpoint => calls.filter(call => call.endpoint === endpoint).length,
    text: () => window.document.body.textContent.replace(/\s+/g, " "),
    click: label => window.runBrowser(() => button(label).click()),
    flush: window.runBrowser,
    stored: () => window.sessionStorage.getItem(pendingKey),
    submitRefresh: () => window.runBrowser(() => {
      window.document.querySelector('input[name="learner"]').value = "learner";
      button("Refresh games").click();
    }),
    unmount,
  };
}

test("model completion survives a failed gaps refresh and gaps retry after two seconds", async t => {
  let phase = "running";
  const page = await openGames(t, {
    "GET /api/games/model": () => response(model(phase === "running" ? "running" : "complete")),
    "GET /api/games/gaps": () => {
      if (phase === "failure") return failure("Temporary gap read failure");
      return response(gapPage(phase === "running" ? "a7a6" : "c7c6"));
    },
  });
  const gapReads = page.count("GET /api/games/gaps");
  const historyReads = page.count("GET /api/games");
  assert.match(page.text(), /running · 1 of 2 positions/);
  assert.equal(page.button(analyzeLabel).disabled, true);
  assert.match(page.text(), /a6 · 1 game/);

  phase = "failure";
  await page.advance(2000);
  assert.match(page.text(), /complete · 2 of 2 positions/);
  assert.equal(page.button(analyzeLabel).disabled, false);
  assert.match(page.text(), /Temporary gap read failure/);
  assert.match(page.text(), /a6 · 1 game/);
  assert.ok(page.button(retryLabel));
  assert.equal(page.count("GET /api/games"), historyReads + 1);

  phase = "recovered";
  await page.advance(1999);
  assert.equal(page.count("GET /api/games/gaps"), gapReads + 1);
  await page.advance(1);
  assert.match(page.text(), /c6 · 1 game/);
  assert.doesNotMatch(page.text(), /Temporary gap read failure|a7a6/);
  assert.equal(page.button(retryLabel), undefined);
  const settledReads = page.calls.length;
  await page.advance(6000);
  assert.equal(page.calls.length, settledReads);
});

test("historical backfill settles despite a failed Maia status read", async t => {
  let status = "running";
  const page = await openGames(t, {
    "GET /api/games/backfill": () => response(backfill(status)),
    "GET /api/games/model": () => failure("Maia status unavailable"),
  });
  const historyReads = page.count("GET /api/games");
  assert.match(page.text(), /0 complete · 0 incomplete · 1 pending/);
  assert.equal(page.button(backfillLabel).closest("fieldset").disabled, true);
  assert.match(page.text(), /Maia status unavailable/);
  status = "complete";
  await page.advance(2000);
  assert.match(page.text(), /1 complete · 0 incomplete · 0 pending/);
  assert.equal(page.button(backfillLabel).closest("fieldset").disabled, false);
  assert.match(page.text(), /Maia status unavailable/);
  assert.equal(page.count("GET /api/games"), historyReads + 1);
});

test("replaying an accepted backfill request can observe completion and refresh history once", async t => {
  let status = "running";
  const payload = {
    command_id: "accepted-backfill", dataset_id: "evidence-fixture",
    lichess: "example", chess_com: null, from_ms: Date.UTC(2026, 10, 9), to_ms: Date.UTC(2026, 10, 10),
  };
  const pending = JSON.stringify({ kind: "backfill", payload });
  const page = await openGames(t, {
    "GET /api/games/backfill": () => response(backfill(status, payload.command_id)),
    "POST /api/games/backfill": ({ body }) => {
      assert.equal(body, JSON.stringify(payload));
      status = "complete";
      return response(backfill(status, payload.command_id));
    },
  }, { pending });
  assert.match(page.text(), /0 complete · 0 incomplete · 1 pending/);
  const historyReads = page.count("GET /api/games");
  await page.click("Retry same request");
  assert.match(page.text(), /1 complete · 0 incomplete · 0 pending/);
  assert.equal(page.count("POST /api/games/backfill"), 1);
  assert.equal(page.stored(), null);
  assert.equal(page.count("GET /api/games"), historyReads + 1);
  await page.advance(6000);
  assert.equal(page.count("GET /api/games"), historyReads + 1);
});

test("a current backfill that finishes between acknowledgement and status read refreshes history once", async t => {
  const payload = { command_id: "fast", dataset_id: "evidence-fixture" };
  let started = false;
  const page = await openGames(t, {
    "GET /api/games/backfill": () => response(started ? backfill("complete", "fast") : { status: "idle" }),
    "GET /api/games": () => started ? gameHistory("fast-game") : gameHistory(),
    "POST /api/games/backfill": () => {
      started = true;
      return response(backfill("running", "fast"));
    },
  }, { pending: JSON.stringify({ kind: "backfill", payload }) });
  const historyReads = page.count("GET /api/games");
  await page.click("Retry same request");
  assert.match(page.text(), /1 complete · 0 incomplete · 0 pending/);
  assert.match(page.text(), /fast-game · Book/);
  assert.equal(page.stored(), null);
  await page.advance(6000);
  assert.equal(page.count("GET /api/games"), historyReads + 1);
});

test("historical Retry clears only an acknowledgement for the pending job and preserves current status", async t => {
  const payload = { command_id: "retry-a", dataset_id: "evidence-fixture", job_id: "job-a" };
  const pending = `{ "kind":"backfill-retry", "payload":${JSON.stringify(payload)} }`;
  const replies = [
    backfill("complete", "job-b"),
    backfill("complete", "job-a", "different-dataset"),
    backfill("complete", "job-a"),
  ];
  let holdCurrentRead = false;
  const page = await openGames(t, {
    "GET /api/games/backfill": ({ signal }) =>
      holdCurrentRead ? hang(signal) : response(backfill("running", "job-b")),
    "POST /api/games/backfill/retry": ({ body }) => {
      assert.equal(body, JSON.stringify(payload));
      return response(replies.shift());
    },
  }, { pending });
  assert.match(page.text(), /Processing Lichess · job-b/);
  for (let i = 0; i < 2; i++) {
    await page.click("Retry same request");
    assert.equal(page.stored(), pending);
    assert.match(page.text(), /reply belongs to a different job or dataset/);
    assert.match(page.text(), /Processing Lichess · job-b/);
  }
  holdCurrentRead = true;
  const historyReads = page.count("GET /api/games");
  await page.click("Retry same request");
  assert.equal(page.stored(), null);
  assert.match(page.text(), /Processing Lichess · job-b/);
  assert.doesNotMatch(page.text(), /job-a/);
  assert.equal(page.count("GET /api/games"), historyReads);
});

test("catalog timeout leaves history available and reload enables dataset-dependent actions", async t => {
  let stalled = true;
  const page = await openGames(t, {
    "POST /api/repertoires": ({ payload, signal }) => {
      assert.deepEqual(payload, { command: "list" });
      return stalled ? hang(signal) : catalog();
    },
  });
  assert.match(page.text(), /No games recorded yet/);
  assert.equal(page.button(analyzeLabel).disabled, true);
  assert.equal(page.button("Refresh games").closest("fieldset").disabled, true);
  await page.advance(4999);
  assert.equal(page.button("Reload Games"), undefined);
  await page.advance(1);
  assert.match(page.text(), /Tempo did not respond before the wait ended/);
  assert.equal(page.calls[0].signal.reason.name, "TimeoutError");
  stalled = false;
  await page.click("Reload Games");
  assert.equal(page.button(analyzeLabel).disabled, false);
  assert.equal(page.button("Refresh games").closest("fieldset").disabled, false);
  assert.equal(page.button("Reload Games"), undefined);
  assert.equal(page.pollTimers(), 0);
});

test("history deadline includes response body consumption and recovery publishes actual history", async t => {
  let stalled = true;
  const page = await openGames(t, {
    "GET /api/games": ({ signal }) => stalled
      ? { ...response(null), json: () => hang(signal) }
      : response({
          last_successful_refresh_ms: Date.UTC(2026, 10, 10),
          results: [{
            source: "lichess", game_id: "restored-game", url: null, repertoire_id: "book",
            learner: "restored-player", matches: 5, deviations: 0, first_deviation_ply: null,
            coverage_gaps: 0, opponent_deviations: 0, effect: "recorded_only",
          }],
        }),
  });
  assert.match(page.text(), /Loading game evidence/);
  assert.equal(page.button(analyzeLabel).disabled, false);
  await page.advance(5000);
  assert.match(page.text(), /Tempo did not respond before the wait ended/);
  assert.doesNotMatch(page.text(), /Loading game evidence|Unexpected Games response/);
  stalled = false;
  await page.click("Reload game evidence");
  assert.match(page.text(), /Last successful provider refresh/);
  assert.match(page.text(), /restored-player · Book/);
  assert.match(page.text(), /5 matched · 0 learner misses/);
  assert.equal(page.button("Reload game evidence"), undefined);
});

test("ordinary refresh status read times out and reload recovers without replaying pending work", async t => {
  let stalled = true;
  const pending = '{ "kind":"refresh","payload":{"command_id":"uncertain","dataset_id":"evidence-fixture"} }';
  const page = await openGames(t, {
    "GET /api/games/job": ({ signal }) => stalled ? hang(signal) : response({ status: "idle" }),
  }, { pending });
  await page.advance(5000);
  assert.match(page.text(), /Tempo did not respond before the wait ended/);
  const retryStart = page.calls.length;
  stalled = false;
  await page.click("Reload Games");
  assert.equal(page.stored(), pending);
  assert.equal(page.button("Reload Games"), undefined);
  const retryPosts = page.calls.slice(retryStart).filter(call => call.endpoint.startsWith("POST"));
  assert.deepEqual(retryPosts.map(call => [call.endpoint, call.payload]), [
    ["POST /api/repertoires", { command: "list" }],
    ["POST /api/games/library", { dataset_id:"evidence-fixture" }],
  ]);
});

test("historical status deadline leaves the other evidence available and recovers the running job", async t => {
  let stalled = true;
  const page = await openGames(t, {
    "GET /api/games/backfill": ({ signal }) => stalled ? hang(signal) : response(backfill("running")),
    "GET /api/games/gaps": () => response(gapPage("a7a6")),
  });
  assert.match(page.text(), /a6 · 1 game/);
  await page.advance(5000);
  assert.match(page.text(), /Historical backfill status · Tempo did not respond before the wait ended/);
  stalled = false;
  await page.click("Retry historical status");
  assert.match(page.text(), /Processing Lichess · history-fixture/);
  assert.equal(page.button("Retry historical status"), undefined);
});

test("a hung Maia read leaves other resources live and times out at five seconds", async t => {
  let status = "running";
  let hungSignal;
  const page = await openGames(t, {
    "GET /api/games/backfill": () => response(backfill(status)),
    "GET /api/games/gaps": () => response(gapPage("h7h6")),
    "GET /api/games/model": ({ signal }) => {
      if (hungSignal) return response(model("complete"));
      hungSignal = signal;
      return hang(signal);
    },
  });
  assert.match(page.text(), /h6 · 1 game/);
  status = "complete";
  await page.advance(2000);
  assert.match(page.text(), /1 complete · 0 incomplete · 0 pending/);
  assert.equal(page.count("GET /api/games/model"), 1);
  await page.advance(2999);
  assert.equal(hungSignal.aborted, false);
  assert.equal(page.button(retryLabel), undefined);
  await page.advance(1);
  assert.equal(hungSignal.aborted, true);
  assert.match(page.text(), /Maia run status · Tempo did not respond before the wait ended/);
  assert.ok(page.button(retryLabel));
  await page.advance(1999);
  assert.equal(page.count("GET /api/games/model"), 1);
  await page.advance(1);
  assert.equal(page.count("GET /api/games/model"), 2);
  assert.match(page.text(), /complete · 2 of 2 positions/);
  assert.equal(page.button(retryLabel), undefined);
});

test("Games rejects an explicit unknown gap kind and accepts a legacy row without one", async t => {
  let legacy = false;
  const page = await openGames(t, {
    "GET /api/games/gaps": () => {
      const reply = gapPage("a7a6");
      if (!legacy) reply.gaps[0].gap_kind = "future_kind";
      return response(reply);
    },
  });
  assert.match(page.text(), /Unsupported opponent gap kind/);
  assert.equal(page.button("Fix response"), undefined);
  assert.equal(page.count("POST /api/games/gap-draft"), 0);
  legacy = true;
  await page.click(retryLabel);
  assert.ok(page.button("Fix response"));
  assert.doesNotMatch(page.text(), /Unsupported opponent gap kind/);
});

test("initial gaps failure stays unknown and manual read retry preserves pending command bytes", async t => {
  let failGaps = true;
  let failModel = true;
  const pending = '{ "kind":"choose","payload":{"command_id":"saved-command","dataset_id":"evidence-fixture","ply":3} }';
  const page = await openGames(t, {
    "GET /api/games/gaps": () => failGaps ? failure("Gaps temporarily unavailable") : response(gapPage()),
    "GET /api/games/model": () => failModel ? failure("Maia temporarily unavailable") : response(model("idle")),
    "POST /api/games/model": () => failure("Could not start analysis"),
  }, { pending });
  assert.match(page.text(), /Gaps temporarily unavailable/);
  assert.doesNotMatch(page.text(), new RegExp(emptyGaps));
  assert.ok(page.button("Retry same request"));
  await page.click(analyzeLabel);
  assert.match(page.text(), /Could not start analysis/);
  const beforeRetry = page.calls.length;
  failGaps = false;
  await page.click(retryLabel);
  assert.match(page.text(), new RegExp(emptyGaps));
  assert.doesNotMatch(page.text(), /Gaps temporarily unavailable/);
  assert.match(page.text(), /Maia temporarily unavailable/);
  assert.deepEqual(page.calls.slice(beforeRetry).map(call => call.endpoint).sort(), [
    "GET /api/games/backfill", "GET /api/games/gaps", "GET /api/games/model",
  ]);
  failModel = false;
  const beforePoll = page.calls.length;
  await page.advance(2000);
  assert.deepEqual(page.calls.slice(beforePoll).map(call => call.endpoint), ["GET /api/games/model"]);
  assert.equal(page.button(retryLabel), undefined);
  assert.equal(page.stored(), pending);
  assert.match(page.text(), /Could not start analysis/);
});

test("paginated gaps timeout ignores a noncooperative result and retries the same offset", async t => {
  let finishLate;
  let paginatedSignal;
  const page = await openGames(t, {
    "GET /api/games/gaps": () => response(gapPage("a7a6", true)),
    "POST /api/games/gaps": ({ payload, signal }) => {
      assert.deepEqual(payload, { offset: 100 });
      if (finishLate) return response(gapPage("b7b6"));
      paginatedSignal = signal;
      return new Promise(resolve => { finishLate = resolve; });
    },
  });
  await page.click("Next gaps");
  await page.advance(5000);
  assert.match(page.text(), /Opponent gaps · Tempo did not respond before the wait ended/);
  assert.equal(paginatedSignal.reason.name, "TimeoutError");
  await page.flush(() => finishLate(response(gapPage("c7c6"))));
  assert.doesNotMatch(page.text(), /c6 · 1 game/);
  assert.match(page.text(), /Opponent gaps · Tempo did not respond before the wait ended/);
  await page.click(retryLabel);
  assert.match(page.text(), /b6 · 1 game/);
  assert.equal(page.button(retryLabel), undefined);
});

test("paging aborts an old gap read and retry only reads the new page", async t => {
  let historical = "running";
  let initialReads = 0;
  let pageReads = 0;
  let resolveOldPage;
  let unresolvedPage;
  const page = await openGames(t, {
    "GET /api/games/backfill": () => response(backfill(historical)),
    "GET /api/games/model": () => response(model("running")),
    "GET /api/games/gaps": () => {
      if (initialReads++ === 0) return response(gapPage("a7a6", true));
      // Resolve an old response after abort to verify the component also rejects late publication.
      return new Promise(resolve => { resolveOldPage = resolve; });
    },
    "POST /api/games/gaps": ({ payload, signal }) => {
      assert.deepEqual(payload, { offset: 100 });
      pageReads++;
      if (pageReads === 1) return failure("Next gap page unavailable");
      if (pageReads === 2) return response(gapPage("b7b6"));
      unresolvedPage = signal;
      return hang(signal);
    },
  });
  await page.advance(2000);
  const oldRequest = page.calls.findLast(call => call.endpoint === "GET /api/games/gaps");
  assert.equal(oldRequest.signal.aborted, false);
  assert.equal(initialReads, 2);
  const historyReads = page.count("GET /api/games");
  historical = "complete";
  await page.click("Next gaps");
  assert.equal(oldRequest.signal.aborted, true);
  assert.equal(oldRequest.signal.reason.name, "AbortError");
  assert.match(page.text(), /1 complete · 0 incomplete · 0 pending/);
  assert.match(page.text(), /Maia Rapid 1500 · running/);
  assert.equal(page.count("GET /api/games"), historyReads + 1);
  assert.match(page.text(), /Next gap page unavailable/);
  assert.doesNotMatch(page.text(), /a6|No confirmed opponent gaps/);
  const beforeRetry = page.calls.length;
  await page.click(retryLabel);
  assert.deepEqual(page.calls.slice(beforeRetry).map(call => call.endpoint).sort(), [
    "GET /api/games/backfill", "GET /api/games/model", "POST /api/games/gaps",
  ]);
  assert.match(page.text(), /b6 · 1 game/);
  await page.flush(() => resolveOldPage(response(gapPage("a7a5"))));
  assert.match(page.text(), /b6 · 1 game/);
  assert.doesNotMatch(page.text(), /a5/);
  await page.advance(2000);
  assert.equal(unresolvedPage.aborted, false);
  assert.ok(page.pollTimers() > 0);
  const beforeUnmount = page.calls.length;
  await page.unmount();
  assert.equal(unresolvedPage.aborted, true);
  assert.equal(unresolvedPage.reason.name, "AbortError");
  assert.equal(page.pollTimers(), 0);
  await page.advance(10000);
  assert.equal(page.calls.length, beforeUnmount);
});

test("successful background reads retain gap action errors and show optional projection freshness", async t => {
  let modelReply = model("running");
  const page = await openGames(t, {
    "GET /api/games/model": () => response(modelReply),
    "GET /api/games/gaps": () => response(gapPage("e7e6")),
    "POST /api/games/gap-draft": () => response({ status: "error", code: "stale_document", message: "The repertoire document changed." }, 409),
  });
  assert.match(page.text(), /Maia Rapid 1500 · running/);
  assert.doesNotMatch(page.text(), /Modeled reach/);
  assert.match(page.text(), /Accounts entered here stay recognized\. Leave a provider blank to skip it for this import\./);
  await page.click(gapLabel);
  assert.match(page.text(), /The repertoire document changed/);

  const projection = {
    dataset_id: "evidence-fixture", complete_current: 2, partial_current: 1, unavailable: 3, pending: 1,
  };
  modelReply = { ...model("complete"), projection };
  await page.advance(2000);
  assert.match(page.text(), /The repertoire document changed/);
  assert.match(page.text(), /Maia Rapid 1500 · complete/);
  assert.match(page.text(), /Modeled reach · 2 complete · 1 partial · 3 unavailable · 1 pending/);
  assert.equal(page.button(retryLabel), undefined);

  modelReply = { ...model("idle"), projection: { ...projection, partial_current: 2, pending: 0 } };
  await page.advance(2000);
  assert.doesNotMatch(page.text(), /Maia Rapid 1500/);
  assert.match(page.text(), /Modeled reach · 2 complete · 2 partial · 3 unavailable · 0 pending/);
  assert.match(page.text(), /The repertoire document changed/);
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function gameHistory(...learners) {
  return response({
    last_successful_refresh_ms: null,
    results: learners.map(learner => ({
      comparison_id: learner, source: "lichess", game_id: learner, url: null, repertoire_id: "book",
      learner, matches: 5, deviations: 0, first_deviation_ply: null, coverage_gaps: 0,
      opponent_deviations: 0, effect: "recorded_only",
    })),
  });
}

for (const replay of [true, false]) {
  test(`first terminal historical status refreshes actual history ${replay ? "with old Retry" : "without pending work"}`, async t => {
    const status = deferred();
    const payload = { command_id: "retry-a", dataset_id: "evidence-fixture", job_id: "job-a" };
    const pending = JSON.stringify({ kind: "backfill-retry", payload });
    let completed = false;
    const page = await openGames(t, {
      "GET /api/games": () => completed ? gameHistory("game-from-B") : gameHistory(),
      "GET /api/games/backfill": () => status.promise,
      "POST /api/games/backfill/retry": ({ body }) => {
        assert.equal(body, JSON.stringify(payload));
        return response(backfill("complete", "job-a"));
      },
    }, replay ? { pending } : {});
    assert.match(page.text(), /No games recorded yet/);
    const reads = page.count("GET /api/games");
    completed = true;
    await page.flush(() => status.resolve(response(backfill("complete", "job-b"))));
    if (replay) {
      assert.equal(page.stored(), pending);
      await page.click("Retry same request");
    }
    await page.advance(10000);
    assert.equal(page.stored(), null);
    assert.match(page.text(), /Lichess · job-b/);
    assert.doesNotMatch(page.text(), /job-a/);
    assert.match(page.text(), /game-from-B · Book/, JSON.stringify({
      historyBefore: reads, historyAfter: page.count("GET /api/games"),
      status: page.count("GET /api/games/backfill"), gaps: page.count("GET /api/games/gaps"),
      pending: page.stored(), text: page.text(),
    }));
    assert.equal(page.count("GET /api/games"), reads + 1);
    assert.equal(page.count("POST /api/games/backfill/retry"), Number(replay));
  });
}

test("foreign historical status is a recoverable read error scoped to Games", async t => {
  const pending = JSON.stringify({ kind: "backfill-retry", payload: {
    command_id: "retry-a", dataset_id: "evidence-fixture", job_id: "job-a",
  } });
  let foreign = true;
  const page = await openGames(t, {
    "GET /api/games/backfill": () => response(foreign
      ? backfill("complete", "foreign-job", "other") : { status: "idle" }),
    "GET /api/games/gaps": () => response(gapPage("h7h6")),
    "GET /api/games": () => gameHistory("local-game"),
  }, { pending });
  assert.doesNotMatch(page.text(), /foreign-job/);
  assert.match(page.text(), /Historical backfill status · .*different dataset/);
  assert.match(page.text(), /local-game · Book/);
  assert.match(page.text(), /h6 · 1 game/);
  assert.equal(page.stored(), pending);
  const reads = page.count("GET /api/games");
  foreign = false;
  await page.click("Retry historical status");
  assert.equal(page.button("Retry historical status"), undefined);
  assert.equal(page.count("GET /api/games"), reads);
  assert.equal(page.stored(), pending);
  assert.equal(page.count("POST /api/games/backfill/retry"), 0);
});

test("accepted old Retry leaves the current running job polling until its history is available", async t => {
  let settled = false;
  const payload = { command_id: "retry-a", dataset_id: "evidence-fixture", job_id: "job-a" };
  const pending = JSON.stringify({ kind: "backfill-retry", payload });
  const page = await openGames(t, {
    "GET /api/games/backfill": () => response(backfill(settled ? "complete" : "running", "job-b")),
    "GET /api/games": () => settled ? gameHistory("job-b-game") : gameHistory(),
    "POST /api/games/backfill/retry": ({ body }) => {
      assert.equal(body, JSON.stringify(payload));
      return response(backfill("complete", "job-a"));
    },
  }, { pending });
  const reads = page.count("GET /api/games");
  const statusReads = page.count("GET /api/games/backfill");
  await page.click("Retry same request");
  assert.equal(page.stored(), null);
  assert.match(page.text(), /Processing Lichess · job-b/);
  assert.equal(page.count("GET /api/games"), reads);
  settled = true;
  await page.advance(2000);
  assert.ok(page.count("GET /api/games/backfill") >= statusReads + 2);
  assert.match(page.text(), /job-b-game · Book/);
  assert.doesNotMatch(page.text(), /job-a/);
  await page.advance(10000);
  assert.equal(page.count("GET /api/games"), reads + 1);
  assert.equal(page.count("POST /api/games/backfill/retry"), 1);
});

test("same historical job settles again when another window retries below the maximum attempt", async t => {
  let retried = false;
  let notes = [];
  const job = () => {
    const value = backfill("incomplete", "same-job");
    value.incomplete_windows = 1;
    const [window] = value.windows;
    value.windows = [
      { ...window, attempt: 2, status: "complete", notes },
      { ...window, source: "pgn", attempt: retried ? 1 : 0, accepted: retried ? 1 : 0 },
    ];
    return value;
  };
  const page = await openGames(t, {
    "GET /api/games/backfill": () => response(job()),
    "GET /api/games/model": () => response(model("running")),
    "GET /api/games": () => gameHistory(retried ? "second-batch" : "first-batch"),
    "POST /api/games/backfill/retry": ({ payload }) => {
      assert.equal(payload.job_id, "same-job");
      retried = true;
      return response(job());
    },
  });
  assert.match(page.text(), /first-batch · Book/);
  const reads = page.count("GET /api/games");
  const statusReads = page.count("GET /api/games/backfill");
  notes = ["Changed display note"];
  await page.advance(4000);
  assert.ok(page.count("GET /api/games/backfill") > statusReads);
  assert.equal(page.count("GET /api/games"), reads);
  await page.click("Retry remaining windows");
  assert.match(page.text(), /second-batch · Book/);
  assert.equal(page.count("GET /api/games"), reads + 1);
  await page.advance(10000);
  assert.equal(page.count("GET /api/games"), reads + 1);
  assert.equal(page.count("POST /api/games/backfill/retry"), 1);
});

test("settled history supersedes a late response and a timed-out replacement remains retryable", async t => {
  const status = deferred();
  const old = deferred();
  let oldSignal;
  let phase = "initial";
  const page = await openGames(t, {
    "GET /api/games/backfill": () => status.promise,
    "GET /api/games": ({ signal }) => {
      if (phase === "initial") {
        oldSignal = signal;
        return old.promise; // The underlying transport deliberately ignores cancellation.
      }
      if (phase === "settled") return hang(signal);
      return gameHistory("current-game");
    },
  });
  phase = "settled";
  await page.flush(() => status.resolve(response(backfill("complete"))));
  assert.equal(oldSignal.aborted, true);
  await page.flush(() => old.resolve(gameHistory("obsolete-game")));
  assert.doesNotMatch(page.text(), /obsolete-game/);
  await page.advance(5000);
  assert.match(page.text(), /Tempo did not respond before the wait ended/);
  phase = "recovered";
  await page.click("Reload game evidence");
  assert.match(page.text(), /current-game · Book/);
  assert.doesNotMatch(page.text(), /obsolete-game|Tempo did not respond before the wait ended/);
  assert.equal(page.count("POST /api/games/backfill/retry"), 0);
});

test("paused historical work may expose durable rows before a window completes", async t => {
  let state = "paused";
  let later = false;
  const page = await openGames(t, {
    "GET /api/games/backfill": () => {
      const value = backfill(state);
      value.windows[0].status = "pending";
      value.pending_windows = 1;
      value.error = state === "paused" ? "Paused after applying a batch" : undefined;
      return response(value);
    },
    "GET /api/games/model": () => response(model("running")),
    "GET /api/games": () => gameHistory(later ? "after-resume" : "before-resume"),
  });
  assert.match(page.text(), /before-resume · Book/);
  const reads = page.count("GET /api/games");
  await page.advance(2000);
  assert.equal(page.count("GET /api/games"), reads);
  state = "running";
  await page.advance(2000);
  later = true;
  state = "paused";
  await page.advance(2000);
  assert.match(page.text(), /after-resume · Book/);
  await page.advance(4000);
  assert.equal(page.count("GET /api/games"), reads + 1);
});

for (const interruptedRead of ["none", "failed", "timed out", "foreign", "cancelled"]) {
  test(`same-tab acknowledged paused Retry refreshes history with identical status (${interruptedRead})`, async t => {
    const paused = backfill("paused", "same-job");
    paused.pending_windows = 1;
    paused.windows[0] = { ...paused.windows[0], status: "pending", received: 0, accepted: 0 };
    delete paused.active_window;
    paused.error = "Paused after applying a batch";
    const staleRead = deferred();
    const ownedRead = deferred();
    let staleSignal;
    let retried = false;
    let recover = false;
    const page = await openGames(t, {
      "GET /api/games/backfill": ({ signal }) => {
        if (retried && !recover) {
          if (interruptedRead === "failed") return failure("Status unavailable");
          if (interruptedRead === "timed out") return hang(signal);
          if (interruptedRead === "foreign") {
            return response({ ...paused, request: { ...paused.request, dataset_id: "foreign" } });
          }
          if (interruptedRead === "cancelled") {
            staleSignal = signal;
            return staleRead.promise;
          }
        }
        if (recover && interruptedRead === "cancelled") return ownedRead.promise;
        return response(structuredClone(paused));
      },
      "GET /api/games/model": () => response(model("running")),
      "GET /api/games/gaps": () => response(gapPage("a7a6", true)),
      "POST /api/games/gaps": () => response(gapPage("h7h6")),
      "GET /api/games": () => gameHistory(retried ? "later-48-games" : "first-24-games"),
      "POST /api/games/backfill/retry": ({ payload }) => {
        assert.equal(payload.job_id, "same-job");
        assert.equal(payload.dataset_id, "evidence-fixture");
        retried = true;
        return response({ ...paused, status: "running", error: undefined });
      },
    });
    assert.match(page.text(), /first-24-games · Book/);
    const reads = page.count("GET /api/games");
    const statusReads = page.count("GET /api/games/backfill");
    await page.click("Retry remaining windows");
    assert.equal(page.stored(), null);
    if (interruptedRead !== "none") {
      if (interruptedRead === "timed out") await page.advance(5000);
      assert.match(page.text(), /first-24-games · Book/);
      assert.equal(page.count("GET /api/games"), reads);
      recover = true;
      if (interruptedRead === "cancelled") {
        await page.click("Next gaps");
        assert.equal(staleSignal.aborted, true);
        await page.flush(() => staleRead.resolve(response(structuredClone(paused))));
        assert.equal(page.count("GET /api/games"), reads);
        await page.flush(() => ownedRead.resolve(response(structuredClone(paused))));
      } else {
        await page.advance(2000);
      }
    }
    assert.match(page.text(), /later-48-games · Book/);
    assert.doesNotMatch(page.text(), /first-24-games/);
    assert.ok(page.button("Retry remaining windows"));
    await page.advance(10000);
    assert.ok(page.count("GET /api/games/backfill") > statusReads + 1);
    assert.equal(page.count("GET /api/games"), reads + 1);
    assert.equal(page.count("POST /api/games/backfill/retry"), 1);
  });
}

test("changing dataset while Games reads are pending clears old rows and ignores late replies", async t => {
  const oldHistory = deferred();
  const oldStatus = deferred();
  const newHistory = deferred();
  let changed = false;
  let modelState = "running";
  let oldHistorySignal;
  let oldStatusSignal;
  let historyReads = 0;
  const page = await openGames(t, {
    "POST /api/repertoires": () => changed
      ? response({ schema_version: 4, status: "repertoires", dataset_id: "next-dataset", repertoires: [] })
      : catalog(),
    "GET /api/games/job": () => changed ? response({ status: "idle" }) : failure("Fixture refresh unavailable"),
    "GET /api/games/model": () => response(model(modelState, changed ? "next-dataset" : "evidence-fixture")),
    "GET /api/games/backfill": ({ signal }) => {
      if (changed) return response(backfill("complete", "next-job", "next-dataset"));
      oldStatusSignal = signal;
      return oldStatus.promise;
    },
    "GET /api/games/gaps": () => response({ ...gapPage(), dataset_id: changed ? "next-dataset" : "evidence-fixture" }),
    "GET /api/games": ({ signal }) => {
      if (changed) return newHistory.promise;
      if (++historyReads === 1) return gameHistory("old-dataset-game");
      oldHistorySignal = signal;
      return oldHistory.promise;
    },
  });
  assert.match(page.text(), /old-dataset-game · Book/);
  modelState = "complete";
  await page.advance(2000);
  assert.equal(oldHistorySignal.aborted, false);
  assert.equal(oldStatusSignal.aborted, false);
  changed = true;
  await page.click("Reload Games");
  assert.equal(oldHistorySignal.aborted, true);
  assert.equal(oldStatusSignal.aborted, true);
  assert.doesNotMatch(page.text(), /old-dataset-game/);
  await page.flush(() => {
    oldHistory.resolve(gameHistory("obsolete-game"));
    oldStatus.resolve(response(backfill("complete", "old-job")));
    newHistory.resolve(gameHistory("new-dataset-game"));
  });
  assert.match(page.text(), /new-dataset-game · book/);
  assert.match(page.text(), /Lichess · next-job/);
  assert.doesNotMatch(page.text(), /old-dataset-game|obsolete-game|old-job|different dataset/);
});

for (const stall of ["fetch", "body"]) {
  test(`accepted gap Save recovers a successor ${stall} timeout without replaying Save`, async t => {
    const gapContinuation = {
      token: "accepted-save", accepted: true, response: "e2e4",
      gap: {
        address: {
          dataset_id: "evidence-fixture", repertoire_id: "book", position: "fixture", actual_move: "h7h6",
        },
        details: {
          learner_color: "white", actual_san: "h6", response_move_labels: { e2e4: "e4" },
          draft: { fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", legal_moves: ["e2e4"] },
        },
        passed: [], offset: 100,
      },
    };
    let succeed = false;
    let successorSignal;
    const nextGaps = ({ signal, payload }) => {
      assert.equal(payload, undefined);
      if (succeed) return response(gapPage());
      // The initial independent Games gap read can succeed. Hold the editor's read.
      if (successorSignal === undefined) {
        successorSignal = signal;
        return stall === "fetch" ? hang(signal) : { ...response(null), json: () => hang(signal) };
      }
      return response(gapPage());
    };
    // The recovered editor starts the newly ranked list from the top.
    const page = await openGames(t, {
      "POST /api/games/gaps": () => response(gapPage()),
      "GET /api/games/gaps": nextGaps,
    }, { gapContinuation });
    await page.advance(0);
    assert.ok(successorSignal);
    assert.match(page.text(), /Saved e4/);
    await page.advance(4999);
    assert.equal(successorSignal.aborted, false);
    await page.advance(1);
    assert.match(page.text(), /Tempo did not respond before the wait ended/);
    assert.match(page.text(), /Saved e4/);
    succeed = true;
    const retryStart = page.calls.length;
    await page.click("Retry loading next gap");
    assert.equal(page.button("Retry loading next gap"), undefined);
    assert.doesNotMatch(page.text(), /Tempo did not respond before the wait ended/);
    assert.match(page.text(), /Saved e4/);
    assert.ok(page.calls.slice(retryStart).some(call => call.endpoint === "GET /api/games/gaps"));
    assert.equal(page.calls.filter(call => call.endpoint === "POST /api/repertoires" &&
      call.payload.command === "save").length, 0);
  });
}

const refreshDataset = "evidence-fixture";
const refreshPayload = {
  command_id: "refresh-a",
  dataset_id: refreshDataset,
  source: "lichess",
  account: "learner",
  from_ms: Date.UTC(2026, 10, 9),
  to_ms: Date.UTC(2026, 10, 10),
};
const savedRefresh = { kind: "refresh", payload: refreshPayload };
const savedRefreshBytes = JSON.stringify(savedRefresh);
const externalKey = `${pendingKey}-external`;
const refreshEndpoint = "POST /api/games/refresh";

function refreshReport(note) {
  return {
    fetched: 0, new_games: 0, duplicates: 0, matches: 0, deviations: 0,
    errors: note ? [note] : [], results: [],
  };
}

function refreshJob(status, commandId = refreshPayload.command_id, datasetId = refreshDataset) {
  return {
    status, dataset_id: datasetId, command_id: commandId,
    ...(status === "complete" ? { report: refreshReport(`Report for ${commandId}`) } : {}),
  };
}

test("Games persists a new Refresh before delivery even when the first storage write fails", async t => {
  let failSave = true;
  let savedAtDelivery;
  let storage;
  const page = await openGames(t, {
    [refreshEndpoint]: ({ payload }) => {
      savedAtDelivery = storage.getItem(pendingKey);
      return response(refreshJob("running", payload.command_id), 202);
    },
  }, {
    setup(window) {
      storage = window.sessionStorage;
      const proto = window.Storage.prototype;
      const setItem = proto.setItem;
      proto.setItem = function (key, value) {
        if (key === pendingKey && failSave) throw new Error("Storage denied");
        setItem.call(this, key, value);
      };
    },
  });
  await page.submitRefresh();
  assert.equal(page.count(refreshEndpoint), 0);
  assert.equal(page.stored(), null);
  assert.match(page.text(), /could not save this Games request for recovery\. Nothing was sent/);
  assert.ok(page.button("Retry same request"));

  failSave = false;
  await page.click("Retry same request");
  assert.equal(page.count(refreshEndpoint), 1);
  const sent = page.calls.find(call => call.endpoint === refreshEndpoint);
  assert.deepEqual(JSON.parse(savedAtDelivery), { kind: "refresh", payload: sent.payload });
  assert.equal(page.stored(), savedAtDelivery);
});

test("Games rereads recovery storage after a corrupt envelope and blocks mutations until it succeeds", async t => {
  let storage;
  const page = await openGames(t, {
    [refreshEndpoint]: ({ body }) => {
      assert.equal(body, JSON.stringify(refreshPayload));
      return response(refreshJob("complete"), 202);
    },
  }, {
    pending: "{unreadable",
    setup(window) { storage = window.sessionStorage; },
  });
  assert.match(page.text(), /could not read the pending Games request/);
  await page.submitRefresh();
  assert.equal(page.count(refreshEndpoint), 0);
  await page.click("Retry recovery");
  assert.match(page.text(), /could not read the pending Games request/);
  assert.equal(page.stored(), "{unreadable");

  storage.setItem(pendingKey, savedRefreshBytes);
  await page.click("Retry recovery");
  assert.doesNotMatch(page.text(), /could not read the pending Games request/);
  assert.equal(page.count(refreshEndpoint), 0);
  await page.click("Retry same request");
  assert.equal(page.count(refreshEndpoint), 1);
  assert.equal(page.stored(), null);
});

test("explicit dismissal keeps an unreadable pending envelope visible until detachment succeeds", async t => {
  let disallow = true;
  const page = await openGames(t, {}, {
    pending: "false",
    setup(window) {
      const proto = window.Storage.prototype;
      const removeItem = proto.removeItem;
      proto.removeItem = function (key) {
        if (key === pendingKey && disallow) throw new Error("Removal denied");
        removeItem.call(this, key);
      };
    },
  });
  assert.match(page.text(), /could not read the pending Games request/);
  await page.click("Dismiss pending request");
  assert.match(page.text(), /could not dismiss the saved Games request/);
  assert.equal(page.stored(), "false");
  disallow = false;
  await page.click("Dismiss pending request");
  assert.equal(page.stored(), null);
  assert.doesNotMatch(page.text(), /could not read|could not dismiss/);
  assert.equal(page.count(refreshEndpoint), 0);
});

function externalRecovery(window, { blob = savedRefresh, state }) {
  window.sessionStorage.setItem(externalKey, JSON.stringify({ id: "old-blob", identity: null }));
  // The previous release's per-tab pointer resolves asynchronously against
  // the IndexedDB command store. Use its existing schema in the mounted harness.
  window.indexedDB = {
    open(name, version) {
      assert.equal(name, "tempo-content-recovery");
      assert.equal(version, 1);
      const open = {};
      queueMicrotask(() => {
        if (state.failOpen) {
          open.error = new Error("Recovery database denied");
          open.onerror();
          return;
        }
        open.result = {
          close() {},
          transaction(name, mode) {
            assert.equal(name, "commands");
            const transaction = {
              objectStore() {
                function finish(id, result) {
                  assert.equal(id, "old-blob");
                  queueMicrotask(() => {
                    if (mode === "readwrite" && state.failDelete) {
                      transaction.error = new Error("Recovery blob deletion denied");
                      transaction.onabort();
                    } else transaction.oncomplete();
                  });
                  return { result };
                }
                return {
                  get(id) { return finish(id, blob); },
                  delete(id) { return finish(id); },
                };
              },
            };
            return transaction;
          },
        };
        open.onsuccess();
      });
      return open;
    },
  };
}

test("Games reloads a previous IndexedDB envelope after an unavailable recovery read", async t => {
  const state = { failOpen: true };
  let storage;
  const page = await openGames(t, {
    [refreshEndpoint]: ({ body }) => {
      assert.equal(body, JSON.stringify(refreshPayload));
      return response(refreshJob("complete"), 202);
    },
  }, {
    setup(window) {
      storage = window.sessionStorage;
      externalRecovery(window, { state });
    },
  });
  assert.match(page.text(), /could not read the pending Games request/);
  await page.submitRefresh();
  assert.equal(page.count(refreshEndpoint), 0);
  state.failOpen = false;
  await page.click("Retry recovery");
  await page.click("Retry same request");
  assert.equal(page.count(refreshEndpoint), 1);
  assert.equal(storage.getItem(externalKey), null);
});

test("Games retries accepted cleanup without resending, then detaches a blob even if deletion fails", async t => {
  const state = { failDelete: true };
  let failDetach = true;
  let storage;
  const page = await openGames(t, {
    [refreshEndpoint]: () => response(refreshJob("complete"), 202),
  }, {
    setup(window) {
      storage = window.sessionStorage;
      externalRecovery(window, { state });
      const proto = window.Storage.prototype;
      const removeItem = proto.removeItem;
      proto.removeItem = function (key) {
        if (key === externalKey && failDetach) throw new Error("Pointer deletion denied");
        removeItem.call(this, key);
      };
    },
  });
  await page.click("Retry same request");
  assert.match(page.text(), /Report for refresh-a/);
  assert.match(page.text(), /confirmed this Games request, but could not clear/);
  assert.ok(storage.getItem(externalKey));
  assert.equal(page.button("Retry same request"), undefined);

  failDetach = false;
  await page.click("Retry cleanup");
  assert.equal(storage.getItem(externalKey), null);
  assert.match(page.text(), /Report for refresh-a/);
  assert.match(page.text(), /unused storage could not be removed/);
  assert.equal(page.button("Retry cleanup"), undefined);
  assert.equal(page.button("Refresh games").closest("fieldset").disabled, false);
  assert.equal(page.count(refreshEndpoint), 1);
});

test("addressed Refresh replay resolves A while the running B slot keeps polling", async t => {
  let current = "running";
  const page = await openGames(t, {
    "GET /api/games/job": () => response(refreshJob(current, "refresh-b")),
    [refreshEndpoint]: ({ body }) => {
      assert.equal(body, JSON.stringify(refreshPayload));
      return response(refreshJob("complete"), 202);
    },
  }, { pending: savedRefreshBytes });
  assert.match(page.text(), /Refreshing games/);
  assert.equal(page.button("Refresh games").closest("fieldset").disabled, true);
  await page.click("Retry same request");
  assert.equal(page.stored(), null);
  assert.match(page.text(), /Recovered refresh results.*Report for refresh-a/);
  assert.doesNotMatch(page.text(), /Import results|Report for refresh-b/);
  assert.match(page.text(), /Refreshing games/);

  current = "complete";
  await page.advance(1000);
  assert.match(page.text(), /Report for refresh-a/);
  assert.match(page.text(), /Latest refresh.*Report for refresh-b/);
  assert.doesNotMatch(page.text(), /Refreshing games/);
  assert.equal(page.count(refreshEndpoint), 1);
});

for (const [fixture, acknowledgement, current] of [
  ["foreign dataset", refreshJob("complete", "refresh-a", "other"), refreshJob("complete", "refresh-a", "other")],
  ["unrelated command", refreshJob("complete", "refresh-b"), refreshJob("complete", "refresh-b")],
  ["missing report", { ...refreshJob("complete"), report: undefined }, { status: "idle" }],
  ["unaddressed", undefined, { status: "idle" }],
]) {
  test(`invalid Refresh acknowledgement (${fixture}) cannot clear the pending request`, async t => {
    const page = await openGames(t, {
      "GET /api/games/job": () => response(current),
      [refreshEndpoint]: () => response(acknowledgement, 202),
    }, { pending: savedRefreshBytes });
    assert.equal(page.stored(), savedRefreshBytes);
    await page.click("Retry same request");
    assert.equal(page.count(refreshEndpoint), 1);
    assert.equal(page.stored(), savedRefreshBytes);
    assert.doesNotMatch(page.text(), /Recovered refresh results|Report for refresh-a/);
  });
}

test("the normal addressed running Refresh keeps its envelope until the matching terminal poll", async t => {
  let current = { status: "idle" };
  const page = await openGames(t, {
    "GET /api/games/job": () => response(current),
    [refreshEndpoint]: () => {
      current = refreshJob("running");
      return response(current, 202);
    },
  }, { pending: savedRefreshBytes });
  await page.click("Retry same request");
  assert.equal(page.stored(), savedRefreshBytes);
  assert.equal(page.button("Retry same request"), undefined);
  assert.match(page.text(), /Refreshing games/);

  current = refreshJob("complete");
  await page.advance(1000);
  assert.equal(page.stored(), null);
  assert.match(page.text(), /Latest refresh.*Report for refresh-a/);
  assert.equal(page.count(refreshEndpoint), 1);
});

test("a lost Maia start acknowledgement waits for current model status before another start", async t => {
  const acknowledgement = deferred();
  const reconciliation = deferred();
  let state = "idle";
  const page = await openGames(t, {
    "GET /api/games/model": () => state === "unreadable" ? reconciliation.promise : response(model(state)),
    "POST /api/games/model": () => acknowledgement.promise,
  });
  await page.click(analyzeLabel);
  assert.equal(page.button(analyzeLabel).disabled, true);
  state = "unreadable";
  await page.advance(10000);
  assert.match(page.text(), /could not confirm the Maia start/);
  assert.equal(page.button(analyzeLabel).disabled, true);
  await page.click(analyzeLabel);
  assert.equal(page.count("POST /api/games/model"), 1);

  state = "running";
  await page.flush(() => reconciliation.resolve(response(model(state))));
  assert.match(page.text(), /Maia Rapid 1500 · running/);
  assert.equal(page.button(analyzeLabel).disabled, true);
  await page.flush(() => acknowledgement.resolve(response(model("complete"))));
  assert.match(page.text(), /Maia Rapid 1500 · running/);
  state = "complete";
  await page.advance(2000);
  assert.match(page.text(), /Maia Rapid 1500 · complete/);
  assert.equal(page.button(analyzeLabel).disabled, false);
  assert.equal(page.count("POST /api/games/model"), 1);
});


test("a foreign Maia run never takes ownership of current Games evidence", async t => {
  const page = await openGames(t, {
    "GET /api/games/model": () => response({
      ...model("running", "old-dataset"),
      projection: {
        dataset_id: "evidence-fixture", complete_current: 1,
        partial_current: 0, unavailable: 0, pending: 0,
      },
    }),
  });
  assert.match(page.text(), /Maia run status belongs to a different dataset/);
  assert.doesNotMatch(page.text(), /running · 1 of 2 positions/);
  assert.equal(page.button(analyzeLabel).disabled, false);
});
