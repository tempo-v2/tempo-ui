import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { Chess } from "chess.js";

const pendingKey = "tempo.games.pending.v1";
const bundle = await build({
  stdin: {
    contents: `
      import React, { act } from "react";
      import { createRoot } from "react-dom/client";
      import { GamesPage } from "./GamesPage.jsx";
      import { ApplicationContext, useApplicationContextReader } from "./application_context.js";
      function GamesFixture() {
        const context = useApplicationContextReader();
        globalThis.refreshGamesContext = context.refresh;
        return <ApplicationContext.Provider value={context}>
          <GamesPage onStudy={() => {}} />
        </ApplicationContext.Provider>;
      }
      const root = createRoot(document.getElementById("root"));
      globalThis.mountGames = () => act(() => {
        root.render(<GamesFixture />);
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
  };
}


const gapPage = (move, more = false) => ({
  dataset_id: "evidence-fixture",
  more,
  gaps: move ? [{
    repertoire_id: "book", actual_move: move, actual_san: move.slice(2), position: "fixture", document_revision: 8, games: 1,
  }] : [],
});

const retryLabel = "Retry evidence reads";
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
    "GET /api/context": () => response({ status: "ready", dataset_id: "evidence-fixture", schema_version: 22 }),
    "POST /api/repertoires": catalog,
    "GET /api/games": () => response({ results: [], last_successful_refresh_ms: null }),
    "POST /api/games/library": ({payload}) => response({dataset_id:payload.dataset_id, through:0, next_before:null, entries:[]}),
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
  const button = label => [...window.document.querySelectorAll("button")]
    .find(item => (item.getAttribute("aria-label") ?? item.textContent) === label);
  return {
    ...clock,
    button,
    calls,
    count: endpoint => calls.filter(call => call.endpoint === endpoint).length,
    text: () => window.document.body.textContent.replace(/\s+/g, " "),
    click: label => window.runBrowser(() => button(label).click()),
    flush: window.runBrowser,
    refreshContext: () => window.runBrowser(window.refreshGamesContext),
    stored: () => window.sessionStorage.getItem(pendingKey),
    submitImport: pgn => window.runBrowser(() => {
      window.document.querySelector('input[name="learner"]').value = "learner";
      window.document.querySelector('textarea[name="pgn"]').value = pgn;
      button("Import games").click();
    }),
    unmount,
  };
}

test("Games has no model polling or new reprocess admission", async t => {
  const page = await openGames(t, {
    "GET /api/games/gaps": () => failure("Temporary gap read failure"),
  });
  assert.match(page.text(), /Temporary gap read failure/);
  assert.doesNotMatch(page.text(), /Analyze Maia probabilities|Reprocess saved games|Compare completed games/);
  const reads = page.calls.length;
  await page.advance(6000);
  assert.equal(page.calls.length, reads);
  assert.equal(page.count("GET /api/games/model"), 0);
  assert.equal(page.count("POST /api/games/model"), 0);
  assert.equal(page.count("POST /api/games/reprocess"), 0);
});

test("context timeout leaves history available and reload enables dataset-dependent actions", async t => {
  let stalled = true;
  const page = await openGames(t, {
    "GET /api/context": ({ payload, signal }) => {
      assert.equal(payload, undefined);
      return stalled ? hang(signal) : response({ status: "ready", dataset_id: "evidence-fixture", schema_version: 22 });
    },
  });
  assert.match(page.text(), /No games recorded yet/);
  assert.equal(page.button("Import games").closest("fieldset").disabled, true);
  await page.advance(4999);
  assert.equal(page.button("Reload Games"), undefined);
  await page.advance(1);
  assert.match(page.text(), /Could not identify the current Tempo data/);
  assert.equal(page.calls.find(call => call.endpoint === "GET /api/context").signal.reason.name, "TimeoutError");
  stalled = false;
  await page.click("Reload Games");
  assert.equal(page.button("Import games").closest("fieldset").disabled, false);
  assert.equal(page.button("Reload Games"), undefined);
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
  await page.advance(5000);
  assert.match(page.text(), /Tempo did not respond before the wait ended/);
  assert.doesNotMatch(page.text(), /Loading game evidence|Unexpected Games response/);
  stalled = false;
  await page.click("Reload game evidence");
  assert.match(page.text(), /restored-player · [Bb]ook/);
  assert.match(page.text(), /5 matched · 0 learner misses/);
  assert.equal(page.button("Reload game evidence"), undefined);
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
  const pending = '{ "kind":"choose","payload":{"command_id":"saved-command","dataset_id":"evidence-fixture","ply":3} }';
  const page = await openGames(t, {
    "GET /api/games/gaps": () => failGaps ? failure("Gaps temporarily unavailable") : response(gapPage()),
  }, { pending });
  assert.match(page.text(), /Gaps temporarily unavailable/);
  assert.doesNotMatch(page.text(), new RegExp(emptyGaps));
  assert.ok(page.button("Retry same request"));
  const beforeRetry = page.calls.length;
  failGaps = false;
  await page.click(retryLabel);
  assert.match(page.text(), new RegExp(emptyGaps));
  assert.doesNotMatch(page.text(), /Gaps temporarily unavailable/);
  assert.deepEqual(page.calls.slice(beforeRetry).map(call => call.endpoint), ["GET /api/games/gaps"]);
  assert.equal(page.button(retryLabel), undefined);
  assert.equal(page.stored(), pending);
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

test("retry reads only the current gap page and unmount aborts an outstanding read", async t => {
  let initialSignal;
  let initialReads = 0;
  let pageReads = 0;
  const page = await openGames(t, {
    "GET /api/games/gaps": ({ signal }) => {
      if (initialReads++ === 0) return response(gapPage("a7a6", true));
      initialSignal = signal;
      return hang(signal);
    },
    "POST /api/games/gaps": ({ payload }) => {
      assert.deepEqual(payload, { offset: 100 });
      if (pageReads++ === 0) return failure("Next gap page unavailable");
      return response(gapPage("b7b6"));
    },
  });
  const historyReads = page.count("GET /api/games");
  await page.click("Next gaps");
  assert.equal(page.count("GET /api/games"), historyReads);
  assert.match(page.text(), /Next gap page unavailable/);
  assert.doesNotMatch(page.text(), /a6|No confirmed opponent gaps/);
  const beforeRetry = page.calls.length;
  await page.click(retryLabel);
  assert.deepEqual(page.calls.slice(beforeRetry).map(call => call.endpoint), ["POST /api/games/gaps"]);
  assert.match(page.text(), /b6 · 1 game/);
  await page.click("Previous gaps");
  assert.equal(initialSignal.aborted, false);
  await page.unmount();
  assert.equal(initialSignal.aborted, true);
  assert.equal(initialSignal.reason.name, "AbortError");
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

test("changing dataset aborts pending Games reads and ignores late replies", async t => {
  const oldHistory = deferred();
  const oldGaps = deferred();
  let changed = false;
  let oldHistorySignal;
  let oldGapSignal;
  const page = await openGames(t, {
    "GET /api/context": () => response({
      status: "ready", dataset_id: changed ? "next-dataset" : "evidence-fixture", schema_version: 22,
    }),
    "GET /api/games/gaps": ({ signal }) => {
      if (changed) return response({ ...gapPage("h7h6"), dataset_id: "next-dataset" });
      oldGapSignal = signal;
      return oldGaps.promise;
    },
    "GET /api/games": ({ signal }) => {
      if (changed) return gameHistory("new-dataset-game");
      oldHistorySignal = signal;
      return oldHistory.promise;
    },
  });
  assert.equal(oldHistorySignal.aborted, false);
  assert.equal(oldGapSignal.aborted, false);
  changed = true;
  await page.refreshContext();
  assert.equal(oldHistorySignal.aborted, true);
  assert.equal(oldGapSignal.aborted, true);
  await page.flush(() => {
    oldHistory.resolve(gameHistory("obsolete-game"));
    oldGaps.resolve(response(gapPage("a7a6")));
  });
  assert.match(page.text(), /new-dataset-game · book/);
  assert.match(page.text(), /h6 · 1 game/);
  assert.doesNotMatch(page.text(), /obsolete-game|a6 · 1 game|different dataset/);
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

test("Games persists a manual PGN import before delivery even when the first storage write fails", async t => {
  const importEndpoint = "POST /api/games/import";
  let failSave = true;
  let savedAtDelivery;
  let storage;
  const page = await openGames(t, {
    [importEndpoint]: () => {
      savedAtDelivery = storage.getItem(pendingKey);
      return response(refreshReport());
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
  await page.submitImport("1. e4 1-0");
  assert.equal(page.count(importEndpoint), 0);
  assert.equal(page.stored(), null);
  assert.match(page.text(), /could not save this Games request for recovery\. Nothing was sent/);
  assert.ok(page.button("Retry same request"));

  failSave = false;
  await page.click("Retry same request");
  assert.equal(page.count(importEndpoint), 1);
  const sent = page.calls.find(call => call.endpoint === importEndpoint);
  assert.deepEqual(JSON.parse(savedAtDelivery), { kind: "import", payload: sent.payload });
  assert.equal(page.stored(), null);
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
  await page.submitImport("1. e4 1-0");
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
  await page.submitImport("1. e4 1-0");
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
  assert.equal(page.button("Import games").closest("fieldset").disabled, false);
  assert.equal(page.count(refreshEndpoint), 1);
});

test("accepted legacy Refresh recovers exactly, and Games reads no job status", async t => {
  const page = await openGames(t, {
    [refreshEndpoint]: ({ body }) => {
      assert.equal(body, JSON.stringify(refreshPayload));
      return response(refreshJob("complete"), 202);
    },
  }, { pending: savedRefreshBytes });
  assert.equal(page.button("Import games").closest("fieldset").disabled, true);
  await page.click("Retry same request");
  assert.equal(page.stored(), null);
  assert.match(page.text(), /Recovered refresh results.*Report for refresh-a/);
  assert.equal(page.count("GET /api/games/job"), 0);
  assert.equal(page.count(refreshEndpoint), 1);
  assert.equal(page.button("Import games").closest("fieldset").disabled, false);
});

for (const [fixture, acknowledgement, status] of [
  ["foreign dataset", refreshJob("complete", "refresh-a", "other"), 202],
  ["unrelated command", refreshJob("complete", "refresh-b"), 202],
  ["missing report", { ...refreshJob("complete"), report: undefined }, 202],
  ["unaddressed", undefined, 202],
  ["obsolete acknowledgement", refreshJob("running"), 202],
  ["foreign retirement", { ...refreshJob("complete", "other"), status: "error", code: "retired_feature", retryable: false }, 410],
  ["temporary busy", { status: "error", code: "request_busy", retryable: true }, 503],
]) {
  test(`invalid Refresh recovery (${fixture}) preserves the pending request`, async t => {
    const page = await openGames(t, {
      [refreshEndpoint]: () => response(acknowledgement, status),
    }, { pending: savedRefreshBytes });
    await page.click("Retry same request");
    assert.equal(page.count(refreshEndpoint), 1);
    assert.equal(page.stored(), savedRefreshBytes);
    assert.doesNotMatch(page.text(), /Recovered refresh results|Report for refresh-a/);
  });
}

test("known undelivered legacy Refresh retires after an addressed terminal response", async t => {
  const page = await openGames(t, {
    [refreshEndpoint]: ({ body, payload }) => {
      assert.equal(body, JSON.stringify(refreshPayload));
      return response({
        status: "error", code: "retired_feature", retryable: false, message: "Remote refresh retired.",
        dataset_id: payload.dataset_id, command_id: payload.command_id,
      }, 410);
    },
  }, { pending: savedRefreshBytes });
  await page.click("Retry same request");
  assert.equal(page.stored(), null);
  assert.match(page.text(), /Remote refresh retired/);
  assert.doesNotMatch(page.text(), /Recovered refresh results/);
  assert.equal(page.count("GET /api/games/job"), 0);
});




for (const outcome of ["accepted", "retired", "foreign retirement"]) {
  test(`historical reprocess recovery handles ${outcome} without new admission`, async t => {
    const payload = {
      command_id: "reprocess-a", dataset_id: refreshDataset, learner: "learner",
      from_ms: Date.UTC(2026, 10, 9), to_ms: Date.UTC(2026, 10, 10),
    };
    const pending = JSON.stringify({ kind: "reprocess", payload });
    const route = "POST /api/games/reprocess";
    const page = await openGames(t, {
      [route]: ({ body }) => {
        assert.equal(body, JSON.stringify(payload));
        if (outcome === "accepted") return response(refreshReport());
        return response({
          status: "error", code: "retired_feature", retryable: false, message: "Reprocessing retired.",
          dataset_id: payload.dataset_id,
          command_id: outcome === "retired" ? payload.command_id : "other",
        }, 410);
      },
    }, { pending });
    assert.equal(page.count(route), 0);
    await page.click("Retry same request");
    assert.equal(page.count(route), 1);
    assert.equal(page.stored(), outcome === "foreign retirement" ? pending : null);
    if (outcome === "accepted") assert.match(page.text(), /Recovered reprocess results/);
    if (outcome === "retired") assert.match(page.text(), /Reprocessing retired/);
  });
}

test("plain library, replay and manual import do not request a repertoire catalog", async t => {
  const dataset = "games-context";
  const storedGame = {
    white: "White", black: "Black", learner: "learner", game_id: "one-game", source: "pgn",
    color: "white", opening: null, eco: null, moves: [], played_ms: null, repertoires: [
      { repertoire_id: "old-book", source_available: true, first_departure: null, reentry_ply: null },
    ],
  };
  const page = await openGames(t, {
    "GET /api/context": () => response({ status: "ready", dataset_id: dataset, schema_version: 22 }),
    "POST /api/repertoires": () => failure("Repertoires are unavailable."),
    "POST /api/games/library": ({ payload }) => {
      assert.equal(payload.dataset_id, dataset);
      return response({ dataset_id: dataset, through: 1, next_before: null, entries: [storedGame] });
    },
    "POST /api/games/review": ({ payload }) => {
      assert.deepEqual(payload, {
        dataset_id: dataset, learner: "learner", game_id: "one-game", source: "pgn", repertoire_id: null,
      });
      return response({
        ...payload, status: "review", white: "White", black: "Black", result: "1-0", learner_color: "white",
        comparison: null, document_id: null, revision: null, line: [],
        positions: [{ fen: new Chess().fen(), played_uci: null, prepared_uci: [],
          book_state: "unavailable", introduced: null, other_route: null }],
      });
    },
    "POST /api/games/import": ({ body, payload }) => {
      assert.equal(payload.dataset_id, dataset);
      assert.equal(payload.pgn, "1. e4 1-0");
      assert.equal(JSON.stringify(JSON.parse(page.stored()).payload), body);
      return response(refreshReport());
    },
  }, { setup: window => {
    window.sessionStorage.setItem("tempo.game-library.v1." + dataset, JSON.stringify({
      book: "missing-book", reason: "opponent_gap",
    }));
  } });
  assert.match(page.text(), /1 game/);
  await page.click("Review game");
  assert.match(page.text(), /White vs Black/);
  assert.equal(page.count("POST /api/games/review"), 1);
  await page.click("← Games");
  await page.click("Import PGN");
  assert.equal(page.button("Import games").disabled, false);
  await page.submitImport("1. e4 1-0");
  assert.equal(page.count("POST /api/games/import"), 1);
  assert.equal(page.stored(), null);
  assert.equal(page.count("POST /api/repertoires"), 0);
  assert.equal(page.count("POST /api/study"), 0);
  assert.doesNotMatch(page.text(), /Open tactics detector|Queue analysis/);
  for (const route of ["GET /api/games/detectors", "POST /api/games/detection", "POST /api/games/detection-result", "POST /api/games/tactics", "POST /api/games/tactics/command"]) {
    assert.equal(page.count(route), 0);
  }
});

test("an import for a different dataset stays pending and is never retargeted", async t => {
  const pending = JSON.stringify({ kind: "import", payload: {
    command_id: "older-upload", dataset_id: "other-dataset", learner: "learner", pgn: "1. e4 1-0",
  } });
  const page = await openGames(t, {}, { pending });
  await page.click("Review Games request");
  assert.equal(page.button("Retry same request").disabled, true);
  assert.equal(page.stored(), pending);
  assert.equal(page.count("POST /api/games/import"), 0);
  assert.equal(page.count("POST /api/repertoires"), 0);
});

test("a transitional Coverage visit owns and cancels its catalog lookup", async t => {
  let catalogSignal;
  const page = await openGames(t, {
    "POST /api/repertoires": ({ signal }) => {
      catalogSignal = signal;
      return hang(signal);
    },
  });
  assert.equal(page.count("POST /api/repertoires"), 0);
  await page.click("Coverage");
  assert.equal(page.count("POST /api/repertoires"), 1);
  assert.equal(catalogSignal.aborted, false);
  await page.click("Library");
  assert.equal(catalogSignal.aborted, true);
  assert.equal(page.count("GET /api/context"), 1);
});

for (const unavailable of ["failure", "deadline"]) {
  test(`a saved import retries its exact request after context ${unavailable}`, async t => {
    const payload = {
      command_id: "saved-import", dataset_id: "saved-dataset", learner: "learner", pgn: "1. e4 1-0",
    };
    const pending = JSON.stringify({ kind: "import", payload });
    let attempts = 0;
    const page = await openGames(t, {
      "GET /api/context": ({ signal }) => unavailable === "deadline" ? hang(signal) : failure("Unavailable"),
      "POST /api/games/import": ({ body }) => {
        assert.equal(body, JSON.stringify(payload));
        if (++attempts === 1) throw new TypeError("Delivery interrupted.");
        return response(refreshReport());
      },
    }, { pending });
    await page.click("Review Games request");
    if (unavailable === "deadline") {
      assert.equal(page.button("Retry same request").disabled, true);
      await page.advance(5000);
    }
    assert.equal(page.button("Retry same request").disabled, false);
    await page.click("Retry same request");
    assert.equal(page.stored(), pending);
    assert.match(page.text(), /Delivery interrupted/);
    await page.click("Retry same request");
    assert.equal(page.stored(), null);
    assert.match(page.text(), /Games import confirmed/);
    assert.equal(page.count("POST /api/games/import"), 2);
    assert.equal(page.button("Import games").closest("fieldset").disabled, true);
    assert.equal(page.count("POST /api/repertoires"), 0);
  });
}

for (const kind of ["backfill", "backfill-retry"]) {
  const dataset_id = "evidence-fixture";
  const job_id = "original-backfill";
  const payload = kind === "backfill"
    ? { command_id: job_id, dataset_id, lichess: "Original", chess_com: null,
        from_ms: 86400000, to_ms: 172800000 }
    : { command_id: "original-retry", dataset_id, job_id };
  const endpoint = kind === "backfill" ? "POST /api/games/backfill" : "POST /api/games/backfill/retry";
  const pending = JSON.stringify({ kind, payload });
  const reply = {
    status: "incomplete", execution: "retired", request: { dataset_id },
    job_id, command_id: payload.command_id, pending_windows: 2, incomplete_windows: 1,
  };

  test(`legacy ${kind} readback preserves identity and explicitly stops pending windows`, async t => {
    const page = await openGames(t, {
      [endpoint]: ({ body }) => {
        assert.equal(body, JSON.stringify(payload));
        return response(reply);
      },
    }, { pending });
    const historyReads = page.count("GET /api/games");
    await page.click("Retry same request");
    assert.equal(page.stored(), null);
    assert.match(page.text(), /Historical Games request was accepted and is archived\. Stopped windows: 2\. Incomplete windows: 1\./);
    assert.equal(page.count("GET /api/games"), historyReads);
    assert.equal(page.count(endpoint), 1);
    await page.advance(6000);
    assert.equal(page.count("GET /api/games/backfill"), 0);
    assert.equal(page.button("Start historical backfill"), undefined);
    assert.equal(page.button("Retry remaining windows"), undefined);
    assert.equal(page.button("Import games").closest("fieldset").disabled, false);
  });

  test(`legacy ${kind} keeps ambiguous responses and clears exact terminal retirement`, async t => {
    let step = 0;
    const retired = {
      status: "error", code: "retired_feature", retryable: false, dataset_id, job_id,
      command_id: payload.command_id, message: "Historical Games backfill has been retired.",
    };
    const page = await openGames(t, {
      [endpoint]: ({ body }) => {
        assert.equal(body, JSON.stringify(payload));
        switch (++step) {
          case 1: return failure("Storage briefly unavailable");
          case 2: return response({ ...reply, command_id: "foreign" });
          case 3: return response({ ...retired, job_id: "foreign" }, 410);
          default: return response(retired, 410);
        }
      },
    }, { pending });
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.click("Retry same request");
      assert.equal(page.stored(), pending);
    }
    await page.click("Retry same request");
    assert.equal(page.stored(), null);
    assert.match(page.text(), /Historical Games backfill has been retired/);
    assert.doesNotMatch(page.text(), /request was accepted/);
    assert.equal(page.count(endpoint), 4);
    assert.equal(page.count("GET /api/games/backfill"), 0);
  });
}
