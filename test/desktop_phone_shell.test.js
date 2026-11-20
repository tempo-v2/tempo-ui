import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

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

async function shell(t, phone) {
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
  window.history.pushState(null, "", "#games");
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

test("phone ignores desktop game links and exposes only Study navigation", async t => {
  const { window, calls } = await shell(t, true);
  assert.equal(window.document.querySelector("h1").textContent, "Study");
  assert.equal(window.document.querySelector('nav[aria-label="Tempo sections"]'), null);
  assert(calls.every(call => call.path === "/api/study" || call.path === "/api/study-progress"));
  await window.runShell(() => window.dispatchEvent(new window.PopStateEvent("popstate")));
  assert.equal(window.document.querySelector("h1").textContent, "Study");
  assert.deepEqual(calls.filter(call => call.path === "/api/study").map(call => call.command.command), ["next"]);
});
