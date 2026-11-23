import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { Chess } from "chess.js";
import { ready } from "../view_fixtures.js";

const bundle = await build({
  stdin: {
    contents: `
      import React, { act } from "react";
      import { createRoot } from "react-dom/client";
      import { App } from "./App.jsx";
      import { TacticsCapturePage } from "./TacticsCapturePage.jsx";
      import { DesktopApp } from "./DesktopApp.jsx";
      import { PhoneApp } from "./PhoneApp.jsx";
      const root = createRoot(document.getElementById("root"));
      globalThis.mountShell = (phone, capture) => act(() => root.render(capture
        ? <App initialPage="capture" renderSection={() => <TacticsCapturePage />} />
        : phone ? <PhoneApp /> : <DesktopApp />));
      globalThis.unmountShell = () => act(() => root.unmount());
      globalThis.runShell = callback => act(callback);
    `,
    resolveDir: fileURLToPath(new URL("..", import.meta.url)),
    loader: "jsx",
  },
  bundle: true, format: "iife", write: false, outdir: "unused",
  loader: { ".svg": "dataurl" },
});
const script = bundle.outputFiles.find(file => file.path.endsWith(".js")).text;

async function shell(t, phone, { hash = "#games", responses: overrides = {}, stored = {}, capture = false } = {}) {
  const { window } = new JSDOM('<!doctype html><div id="root"></div>', {
    url: "http://tempo.test/", runScripts: "outside-only", pretendToBeVisual: true,
  });
  window.IS_REACT_ACT_ENVIRONMENT = true;
  window.TextEncoder = TextEncoder;
  window.AbortController = AbortController;
  window.AbortSignal = AbortSignal;
  window.MessageChannel = class {
    port1 = {};
    port2 = { postMessage: () => setImmediate(() => this.port1.onmessage()) };
  };
  window.localStorage.setItem("tempo-v2-board-sounds", "false");
  for (const [key, value] of Object.entries(stored)) window.sessionStorage.setItem(key, JSON.stringify(value));
  if (hash) window.history.pushState(null, "", hash);
  const calls = [];
  const errors = [];
  const dataset = "shell-fixture";
  const responses = {
    "/api/context": { status: "ready", dataset_id: dataset, schema_version: 22 },
    "/api/repertoires": { schema_version: 4, status: "repertoires", dataset_id: dataset, repertoires: [] },
    "/api/games": { results: [], last_successful_refresh_ms: null },
    "/api/games/library": { dataset_id: dataset, through: 0, next_before: null, entries: [] },
    "/api/games/job": { status: "idle" },
    "/api/games/backfill": { status: "idle" },
    "/api/games/model": { status: "idle", profile: "Fixture", completed: 0, total: 0 },
    "/api/games/gaps": { dataset_id: dataset, more: false, gaps: [] },
    "/api/study": { schema_version: 5, status: "empty", dataset_id: dataset, done: true,
      outstanding: 0, repertoire_remaining: 0, tactics_remaining: 0 },
    "/api/study-progress": { status: "error", message: "No progress fixture" },
    "/api/study/presence": { status: "accepted" },
    "/api/study/relevance": { reason: "Practice fixture" },
    ...overrides,
  };
  window.fetch = async (path, options = {}) => {
    calls.push({ path, method: options.method, command: options.body && JSON.parse(options.body), raw: options.body });
    if (!Object.hasOwn(responses, path)) errors.push("Unexpected endpoint " + path);
    const reply = responses[path];
    return typeof reply === "function"
      ? reply()
      : { ok: true, status: 200, json: async () => reply };
  };
  window.addEventListener("error", event => errors.push(event.message));
  window.eval(script);
  t.after(async () => {
    await window.unmountShell();
    window.close();
    assert.deepEqual(errors, []);
  });
  await window.mountShell(phone, capture);
  return { window, calls };
}

for (const phone of [false, true]) {
  test(`${phone ? "phone" : "desktop"} Study error exports local diagnostics without another request`, async t => {
    const { window, calls } = await shell(t, phone, { hash: "", responses: {
      "/api/study": { schema_version: 5, status: "error", code: "store_unavailable",
        message: "private-server-message", retryable: true },
    } });
    const button = [...window.document.querySelectorAll("button")]
      .find(button => button.textContent === "Download diagnostics");
    assert.ok(button);
    assert.equal(typeof window.tempoDiagnostics.snapshot, "function");
    let content;
    let filename;
    window.Blob = class { constructor(parts) { content = parts.join(""); } };
    window.URL.createObjectURL = () => "blob:diagnostics-fixture";
    window.URL.revokeObjectURL = () => {};
    window.HTMLAnchorElement.prototype.click = function () { filename = this.download; };
    const count = calls.length;
    await window.runShell(() => button.click());
    assert.equal(filename, "tempo-browser-diagnostics.json");
    assert.equal(calls.length, count);
    const exported = JSON.parse(content);
    assert.equal(exported.source, "tempo-ui");
    assert.ok(exported.events.some(event => event.route === "/api/study" && event.application_error));
    assert.doesNotMatch(content, /private-server-message/);
  });
}

test("desktop opens a game link and browser Back returns to Study through the shared controller", async t => {
  const { window, calls } = await shell(t, false);
  assert.equal(window.document.querySelector("h1").textContent, "Games");
  assert.equal(calls.filter(call => call.path === "/api/study").length, 0);
  await window.runShell(async () => {
    const moved = new Promise(resolve => window.addEventListener("popstate", resolve, { once: true }));
    window.history.back();
    await moved;
  });
  assert.equal(window.document.querySelector("h1").textContent, "Study");
  assert.deepEqual(calls.filter(call => call.path === "/api/study").map(call => call.command.command), ["next"]);
  assert(window.document.querySelector('nav[aria-label="Tempo sections"]'));
});

test("desktop opens Saved for review from Games without issuing a Study command", async t => {
  const { window, calls } = await shell(t, false, { responses: {
    "/api/study/saved-reviews": { status: "saved_reviews", rows: [], next: null },
    "/api/study/presence": { status: "accepted" },
  } });
  const navigation = window.document.querySelector(".tempo-nav-sections");
  await window.runShell(() => navigation.querySelector('[aria-label="Study shortcuts"]').click());
  const saved = [...navigation.querySelectorAll("button")].find(button => button.textContent === "Saved for review");
  assert.equal(saved.closest("ul").hidden, false);
  await window.runShell(() => saved.click());
  assert.equal(window.document.querySelector("h1").textContent, "Saved for review");
  assert.equal(window.location.hash, "");
  assert.deepEqual(calls.filter(call => call.path === "/api/study/saved-reviews").map(call => call.command), [
    { command: "list", dataset_id: "shell-fixture", before: null },
  ]);
  assert.equal(calls.some(call => call.path === "/api/study"), false);
  await window.runShell(() => navigation.querySelector('a[href="#"]').click());
  assert.equal(window.document.querySelector("h1").textContent, "Study");
  assert.deepEqual(calls.filter(call => call.path === "/api/study").map(call => call.command.command), ["next"]);
});

const position = new Chess();
const practice = ready({
  activity: "practice", assessment: "again", dataset_id: "shell-fixture",
  display_fen: position.fen(),
  prompt: { fen: position.fen(), instruction: "Practice", decision_index: 0, decision_count: 1 },
});

test("desktop forwards an explicit Lichess launch through the analysis shell", async t => {
  const lineBoard = new Chess();
  lineBoard.move("e4");
  const { window, calls } = await shell(t, false, { hash: "", responses: {
    "/api/study": practice,
    "/api/study/analysis-context": {
      datasetId: practice.dataset_id, attemptId: practice.attempt_id,
      contentVersion: practice.content_version, revision: practice.revision,
      fen: practice.display_fen, color: "white", repertoireId: null, name: null,
      prescribedUci: "e2e4", playedUci: null,
    },
    "/api/study/analysis-line": { scope: "full_line", line: {
      start_fen: practice.display_fen, moves: [{ notation: "1. e4", fen: lineBoard.fen() }],
    } },
  } });
  const destinations = [];
  const reserved = { closed: false, location: { href: "about:blank" },
    close() { this.closed = true; },
    document: { body: { append() {} }, createElement() {
      return { click() { destinations.push(this.href); reserved.location.href = this.href; } };
    } },
  };
  window.open = (url, target) => {
    assert.equal(url, "about:blank");
    assert.equal(target, "_blank");
    return reserved;
  };
  assert.equal(calls.some(call => call.path === "/api/study/analysis-line"), false);
  const launch = window.document.querySelector('button[aria-label="Analyze in Lichess"]');
  assert(launch);
  await window.runShell(async () => launch.click());
  assert.equal(window.document.querySelector("h1").textContent, "Analysis board");
  assert.equal(calls.filter(call => call.path === "/api/study/analysis-line").length, 1);
  assert.equal(calls.some(call => call.path.startsWith("/api/analysis/")), false);
  assert.equal(destinations.length, 1);
  assert.match(destinations[0], /^https:\/\/lichess\.org\/analysis\/pgn\//);
  assert.equal(reserved.opener, null);
  assert.equal(reserved.closed, false);
});

test("phone keeps an active exercise free of desktop analysis and Lichess controls", async t => {
  const { window, calls } = await shell(t, true, { responses: { "/api/study": practice } });
  assert.equal(window.document.querySelector("h1").textContent, "Practice");
  assert.equal(window.document.querySelector('button[aria-label="Analyze in Lichess"]'), null);
  assert.equal([...window.document.querySelectorAll("button")].some(button => button.textContent === "Analyze"), false);
  assert(calls.every(call => ["/api/context", "/api/study", "/api/study-progress", "/api/study/presence", "/api/study/relevance"].includes(call.path)));
});

test("phone ignores desktop game links and loads Build without issuing a Study command", async t => {
  const { window, calls } = await shell(t, true);
  assert.equal(window.document.querySelector("h1").textContent, "Study");
  assert.equal(window.document.querySelector('nav[aria-label="Tempo sections"]'), null);
  assert(calls.every(call => ["/api/context", "/api/study", "/api/study-progress", "/api/study/presence"].includes(call.path)));
  await window.runShell(() => window.dispatchEvent(new window.PopStateEvent("popstate")));
  assert.equal(window.document.querySelector("h1").textContent, "Study");
  assert.deepEqual(calls.filter(call => call.path === "/api/study").map(call => call.command.command), ["next"]);
  const nav = window.document.querySelector('nav[aria-label="Tempo phone sections"]');
  const build = [...nav.querySelectorAll("button")].find(button => button.textContent === "Build");
  await window.runShell(() => build.click());
  assert.equal(window.document.querySelector("h1").textContent, "Build repertoire");
  assert.equal(window.location.hash, "#build");
  assert.deepEqual(calls.filter(call => call.path === "/api/repertoires").map(call => call.command.command), ["list"]);
  assert.deepEqual(calls.filter(call => call.path === "/api/study").map(call => call.command.command), ["next"]);
});

async function submitCapturePreview(window, pgn) {
  const input = window.document.querySelector('input[type="file"]');
  Object.defineProperty(input, "files", { value: [{ text: async () => pgn }] });
  await window.runShell(() => input.dispatchEvent(new window.Event("change", { bubbles: true })));
  const preview = window.document.querySelector('.capture-import button[type="submit"]');
  assert.equal(preview.disabled, false);
  await window.runShell(() => preview.click());
}

test("Capture uses shell context with Study and Repertoire unavailable", async t => {
  const { window, calls } = await shell(t, false, { capture: true, responses: {
    "/api/tactics": { status: "tactics_preview", schema_version: 4, token: "preview-token", rows: [] },
  } });
  assert.equal(window.document.querySelector("h1").textContent, "Capture tactics");
  await submitCapturePreview(window, "1. e4 *");
  assert.deepEqual(calls.map(({ path, method, command }) => ({ path, method, command })), [
    { path: "/api/context", method: "GET", command: undefined },
    { path: "/api/tactics", method: "POST", command: { command: "preview", dataset_id: "shell-fixture", pgn: "1. e4 *" } },
  ]);
});

const pendingCapture = {
  command: "save", dataset_id: "old-dataset", pgn: "1. e4 *", token: "old-token", selected: [0],
};
const captureKey = "tempo-tactics-recovery-v4";

test("Capture replays an immutable pending save even while context is unavailable", async t => {
  const { window, calls } = await shell(t, false, { stored: { [captureKey]: pendingCapture }, responses: {
    "/api/context": () => ({ ok: false, status: 503, json: async () =>
      ({ status: "unavailable", code: "storage_unavailable" }) }),
    "/api/tactics": { status: "tactics_saved", schema_version: 4, count: 1 },
  } });
  assert.equal(window.document.querySelector("h1").textContent, "Capture tactics");
  assert.match(window.document.body.textContent, /Tempo storage is unavailable/);
  assert.match(window.document.body.textContent, /One tactic saved/);
  assert.deepEqual(calls.map(({ path }) => path).sort(), ["/api/context", "/api/tactics"]);
  assert.equal(calls.find(({ path }) => path === "/api/tactics").raw, JSON.stringify(pendingCapture));
  assert.equal(window.sessionStorage.getItem(captureKey), null);
});

test("An authoritative stale Capture save refreshes context without changing the old payload", async t => {
  let gets = 0;
  let captures = 0;
  const { window, calls } = await shell(t, false, { stored: { [captureKey]: pendingCapture }, responses: {
    "/api/context": () => ({ ok: true, status: 200, json: async () => ({
      status: "ready", dataset_id: ++gets === 1 ? "old-dataset" : "new-dataset", schema_version: 22,
    }) }),
    "/api/tactics": () => ({ ok: true, status: 200, json: async () => ++captures === 1
      ? { status: "error", schema_version: 4, code: "stale_dataset", message: "Dataset changed.", retryable: false }
      : { status: "tactics_preview", schema_version: 4, token: "fresh-preview", rows: [] } }),
  } });
  await submitCapturePreview(window, "1. e4 *");
  assert.deepEqual(calls.filter(({ path }) => path === "/api/tactics").map(({ command }) => command), [
    pendingCapture, { command: "preview", dataset_id: "new-dataset", pgn: "1. e4 *" },
  ]);
  assert.equal(calls.filter(({ path }) => path === "/api/context").length, 2);
  assert.equal(calls.some(({ path }) => path === "/api/repertoires" || path === "/api/study"), false);
});

test("An uncertain Capture delivery keeps the original save through context failure", async t => {
  let saves = 0;
  const { window, calls } = await shell(t, false, { stored: { [captureKey]: pendingCapture }, responses: {
    "/api/context": () => ({ ok: false, status: 503, json: async () =>
      ({ status: "unavailable", code: "storage_unavailable" }) }),
    "/api/tactics": () => {
      if (++saves === 1) throw new TypeError("Connection interrupted.");
      return { ok: true, status: 200, json: async () => ({
        status: "tactics_saved", schema_version: 4, count: 1,
      }) };
    },
  } });
  assert.equal(window.sessionStorage.getItem(captureKey), JSON.stringify(pendingCapture));
  const retry = [...window.document.querySelectorAll("button")].find(button => button.textContent === "Retry capture");
  assert.ok(retry);
  await window.runShell(() => retry.click());
  assert.deepEqual(calls.filter(({ path }) => path === "/api/tactics").map(({ raw }) => raw), [
    JSON.stringify(pendingCapture), JSON.stringify(pendingCapture),
  ]);
  assert.equal(window.sessionStorage.getItem(captureKey), null);
  assert.equal(calls.filter(({ path }) => path === "/api/context").length, 1);
});

test("a pending Games import keeps its original address through Study navigation", async t => {
  const key = "tempo.games.pending.v1";
  const pending = { kind: "import", payload: {
    command_id: "old-game-import", dataset_id: "shell-fixture", learner: "learner", pgn: "1. e4 1-0",
  }};
  const { window, calls } = await shell(t, false, { stored: { [key]: pending }, responses: {
    "/api/games/import": {
      fetched: 1, new_games: 1, duplicates: 0, matches: 0, deviations: 0, errors: [], results: [],
    },
  } });
  const button = label => [...window.document.querySelectorAll("button")].find(item => item.textContent === label);
  assert.equal(calls.filter(call => call.path === "/api/games/import").length, 0);
  await window.runShell(() => button("← Study").click());
  assert.equal(window.document.querySelector("h1").textContent, "Study");
  assert.equal(window.sessionStorage.getItem(key), JSON.stringify(pending));
  await window.runShell(async () => {
    const moved = new Promise(resolve => window.addEventListener("popstate", resolve, { once: true }));
    window.history.back();
    await moved;
  });
  assert.equal(window.document.querySelector("h1").textContent, "Games");
  const start = calls.length;
  await window.runShell(() => button("Review Games request").click());
  await window.runShell(() => button("Retry same request").click());
  assert.deepEqual(calls.slice(start).filter(call => call.path === "/api/games/import").map(call => call.raw), [
    JSON.stringify(pending.payload),
  ]);
  assert.equal(window.sessionStorage.getItem(key), null);
  assert.equal(calls.filter(call => call.path === "/api/context").length, 1);
  assert.equal(calls.filter(call => call.path === "/api/repertoires").length, 0);
});
