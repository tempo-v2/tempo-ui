import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const { outputFiles: [script] } = await build({
  stdin: {
    contents: `
      import React, { act } from "react";
      import { createRoot } from "react-dom/client";
      import { StudyProgress, useStudyProgress } from "./StudyProgress.jsx";
      function Progress() {
        const props = useStudyProgress({ dataset_id: "live", attempt_id: "a", status: "ready" }, false);
        return <StudyProgress {...props} />;
      }
      const root = createRoot(document.querySelector("#root"));
      globalThis.mount = () => act(async () => root.render(<Progress />));
      globalThis.unmount = () => act(async () => root.unmount());
      globalThis.advance = callback => act(async () => callback());
    `,
    resolveDir: fileURLToPath(new URL("..", import.meta.url)),
    loader: "jsx",
  },
  bundle: true,
  write: false,
});

test("mounted Study progress releases a hung read and ignores its stale reply", async () => {
  const { window } = new JSDOM("<div id='root'></div>", { runScripts: "outside-only" });
  window.IS_REACT_ACT_ENVIRONMENT = true;
  window.MessageChannel = class {
    port1 = {};
    port2 = { postMessage: () => queueMicrotask(() => this.port1.onmessage?.()) };
  };
  const nativeTimeout = window.setTimeout.bind(window);
  const nativeClear = window.clearTimeout.bind(window);
  const deadlines = new Map();
  let nextTimer = -1;
  window.setTimeout = (callback, delay, ...args) => {
    if (delay !== 5_000) return nativeTimeout(callback, delay, ...args);
    const id = nextTimer--;
    deadlines.set(id, callback);
    return id;
  };
  window.clearTimeout = id => id < 0 ? deadlines.delete(id) : nativeClear(id);
  let poll;
  window.setInterval = (cb, delay) => {
    assert.equal(delay, 60_000);
    poll = cb;
    return 1;
  };
  window.clearInterval = () => { poll = undefined; };
  const late = Promise.withResolvers();
  let sends = 0;
  const summary = {
    stamp: { dataset_id: "live" },
    due: 7,
    openings_introduced: 1,
    openings_limit: 10,
    tactics_introduced: 2,
    tactics_limit: 20,
  };
  window.fetch = async (path, init) => {
    assert.equal(path, "/api/study-progress");
    assert.equal(init.body, "null");
    sends++;
    return { ok: true, json: () => sends === 1 ? late.promise : summary };
  };
  window.eval(script.text);
  try {
    await window.mount();
    assert.equal(sends, 1);
    assert.equal(deadlines.size, 1);
    await window.advance([...deadlines.values()][0]);
    assert.match(window.document.body.textContent, /Daily progress unavailable/);
    await window.advance(poll);
    assert.equal(sends, 2);
    assert.match(window.document.body.textContent, /Due reviews7/);
    await window.advance(() => late.resolve({ ...summary, due: 99 }));
    assert.doesNotMatch(window.document.body.textContent, /99/);
    assert.equal(deadlines.size, 0);
  } finally {
    await window.unmount();
    window.close();
  }
});
