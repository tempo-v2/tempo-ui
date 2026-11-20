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
      import { DesktopApp } from "./DesktopApp.jsx";
      import { App } from "./App.jsx";
      import { phoneStudyTransport } from "./phone_study_transport.js";
      const root = createRoot(document.getElementById("root"));
      globalThis.mountShell = phone => act(() => root.render(phone
        ? <App transport={phoneStudyTransport} boardContinuation /> : <DesktopApp />));
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

async function shell(t, phone, { hash = "#games", responses: overrides = {} } = {}) {
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
  if (hash) window.history.pushState(null, "", hash);
  const calls = [];
  const errors = [];
  const dataset = "shell-fixture";
  const responses = {
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
    "/api/study/relevance": { reason: "Practice fixture" },
    ...overrides,
  };
  window.fetch = async (path, options = {}) => {
    calls.push({ path, command: options.body && JSON.parse(options.body) });
    if (!Object.hasOwn(responses, path)) errors.push("Unexpected endpoint " + path);
    return { ok: true, status: 200, json: async () => responses[path] };
  };
  window.addEventListener("error", event => errors.push(event.message));
  window.eval(script);
  t.after(async () => {
    await window.unmountShell();
    window.close();
    assert.deepEqual(errors, []);
  });
  await window.mountShell(phone);
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
  assert(calls.every(call => ["/api/study", "/api/study-progress", "/api/study/relevance"].includes(call.path)));
});

test("phone ignores desktop game links and exposes only Study navigation", async t => {
  const { window, calls } = await shell(t, true);
  assert.equal(window.document.querySelector("h1").textContent, "Study");
  assert.equal(window.document.querySelector('nav[aria-label="Tempo sections"]'), null);
  assert(calls.every(call => call.path === "/api/study" || call.path === "/api/study-progress"));
  await window.runShell(() => window.dispatchEvent(new window.PopStateEvent("popstate")));
  assert.equal(window.document.querySelector("h1").textContent, "Study");
  assert.deepEqual(calls.filter(call => call.path === "/api/study").map(call => call.command.command), ["next"]);
});
