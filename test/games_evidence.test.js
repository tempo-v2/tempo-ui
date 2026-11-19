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

function clockFor(window) {
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
  window.setTimeout = (callback, delay, ...args) => delay < 1000
    ? nativeSet(callback, delay, ...args)
    : schedule(() => callback(...args), delay, "poll");
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

const model = status => ({
  status, profile: "Maia Rapid 1500", completed: status === "running" ? 1 : 2, total: 2,
});

const backfill = status => ({
  status,
  job_id: "history-fixture",
  active_window: status === "running" ? 0 : 1,
  incomplete_windows: 0,
  pending_windows: status === "running" ? 1 : 0,
  windows: [{
    status,
    learner: "example",
    source: "lichess",
    from_ms: Date.UTC(2026, 10, 9),
    to_ms: Date.UTC(2026, 10, 10),
    notes: [],
    received: 1,
    accepted: status === "running" ? 0 : 1,
  }],
});

const gapPage = (move, more = false) => ({
  dataset_id: "evidence-fixture",
  more,
  gaps: move ? [{
    repertoire_id: "book", actual_move: move, position: "fixture", document_revision: 8, games: 1,
  }] : [],
});

const retryLabel = "Retry evidence reads";
const analyzeLabel = "Analyze Maia probabilities";
const backfillLabel = "Start historical backfill";
const gapLabel = "Open response editor";
const emptyGaps = "No confirmed opponent gaps";
const response = (body, status = 200) => ({ status, ok: status < 400, json: async () => body });
const failure = message => response({ message }, 503);
const hang = signal => new Promise((_, reject) => {
  signal.addEventListener("abort", () => reject(signal.reason), { once: true });
});

async function openGames(t, handlers, { pending } = {}) {
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
  const clock = clockFor(window);
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
    "POST /api/repertoires": () => response({
      schema_version: 4, status: "repertoires", dataset_id: "evidence-fixture",
      repertoires: [{ id: "book", name: "Book", learner_color: "white", positions: 2 }],
    }),
    "GET /api/games": () => response({ results: [], last_successful_refresh_ms: null }),
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
  assert.match(page.text(), /a7a6 · 1 game/);

  phase = "failure";
  await page.advance(2000);
  assert.match(page.text(), /complete · 2 of 2 positions/);
  assert.equal(page.button(analyzeLabel).disabled, false);
  assert.match(page.text(), /Temporary gap read failure/);
  assert.match(page.text(), /a7a6 · 1 game/);
  assert.ok(page.button(retryLabel));
  assert.equal(page.count("GET /api/games"), historyReads + 1);

  phase = "recovered";
  await page.advance(1999);
  assert.equal(page.count("GET /api/games/gaps"), gapReads + 1);
  await page.advance(1);
  assert.match(page.text(), /c7c6 · 1 game/);
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
    "GET /api/games/backfill": () => response(backfill(status)),
    "POST /api/games/backfill": ({ body }) => {
      assert.equal(body, JSON.stringify(payload));
      status = "complete";
      return response(backfill(status));
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
  assert.match(page.text(), /h7h6 · 1 game/);
  status = "complete";
  await page.advance(2000);
  assert.match(page.text(), /1 complete · 0 incomplete · 0 pending/);
  assert.equal(page.count("GET /api/games/model"), 1);
  await page.advance(2999);
  assert.equal(hungSignal.aborted, false);
  assert.equal(page.button(retryLabel), undefined);
  await page.advance(1);
  assert.equal(hungSignal.aborted, true);
  assert.match(page.text(), /Maia run status · The evidence read timed out/);
  assert.ok(page.button(retryLabel));
  await page.advance(1999);
  assert.equal(page.count("GET /api/games/model"), 1);
  await page.advance(1);
  assert.equal(page.count("GET /api/games/model"), 2);
  assert.match(page.text(), /complete · 2 of 2 positions/);
  assert.equal(page.button(retryLabel), undefined);
});

test("initial gaps failure stays unknown and manual read retry preserves pending command bytes", async t => {
  let failGaps = true;
  let failModel = true;
  const pending = '{ "kind":"choose","payload":{"command_id":"saved-command","dataset_id":"evidence-fixture","ply":3} }';
  const page = await openGames(t, {
    "GET /api/games/gaps": () => failGaps ? failure("Gaps temporarily unavailable") : response(gapPage()),
    "GET /api/games/model": () => failModel ? failure("Maia temporarily unavailable") : response(model("idle")),
  }, { pending });
  assert.match(page.text(), /Gaps temporarily unavailable/);
  assert.doesNotMatch(page.text(), new RegExp(emptyGaps));
  assert.ok(page.button("Retry same request"));
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
  assert.match(page.text(), /1 complete · 0 incomplete · 0 pending/);
  assert.match(page.text(), /Maia Rapid 1500 · running/);
  assert.equal(page.count("GET /api/games"), historyReads + 1);
  assert.match(page.text(), /Next gap page unavailable/);
  assert.doesNotMatch(page.text(), /a7a6|No confirmed opponent gaps/);
  const beforeRetry = page.calls.length;
  await page.click(retryLabel);
  assert.deepEqual(page.calls.slice(beforeRetry).map(call => call.endpoint).sort(), [
    "GET /api/games/backfill", "GET /api/games/model", "POST /api/games/gaps",
  ]);
  assert.match(page.text(), /b7b6 · 1 game/);
  await page.flush(() => resolveOldPage(response(gapPage("a7a5"))));
  assert.match(page.text(), /b7b6 · 1 game/);
  assert.doesNotMatch(page.text(), /a7a5/);
  await page.advance(2000);
  assert.equal(unresolvedPage.aborted, false);
  assert.ok(page.pollTimers() > 0);
  const beforeUnmount = page.calls.length;
  await page.unmount();
  assert.equal(unresolvedPage.aborted, true);
  assert.equal(page.pollTimers(), 0);
  await page.advance(10000);
  assert.equal(page.calls.length, beforeUnmount);
});

test("successful background reads retain gap action errors and show optional projection freshness", async t => {
  let modelReply = model("running");
  const page = await openGames(t, {
    "GET /api/games/model": () => response(modelReply),
    "GET /api/games/gaps": () => response(gapPage("e7e6")),
    "POST /api/games/gap-draft": () => response({ message: "The repertoire document changed." }, 409),
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
