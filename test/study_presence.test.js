import assert from "node:assert/strict";
import test from "node:test";
import { watchStudyPresence } from "../use_study_presence.js";

function browser(t, surface) {
  const saved = { window: globalThis.window, document: globalThis.document };
  const window = new EventTarget();
  const document = new EventTarget();
  let focused = true;
  document.hasFocus = () => focused;
  document.visibilityState = "visible";
  globalThis.window = window;
  globalThis.document = document;
  t.mock.timers.enable({ apis: ["setInterval"] });
  const reports = [];
  const stop = watchStudyPresence(surface, report => reports.push(report));
  t.after(() => {
    stop();
    Object.assign(globalThis, saved);
  });
  return {
    reports,
    stop,
    focus(value) {
      focused = value;
      window.dispatchEvent(new Event(value ? "focus" : "blur"));
    },
    visibility(state) {
      document.visibilityState = state;
      document.dispatchEvent(new Event("visibilitychange"));
    },
    lifecycle(name) { window.dispatchEvent(new Event(name)); },
  };
}

test("desktop renews focused Study and releases on blur, hidden tab, or leaving Study", t => {
  const page = browser(t, "desktop");
  t.mock.timers.tick(10_000);
  page.focus(false);
  t.mock.timers.tick(10_000);
  page.focus(true);
  page.visibility("hidden");
  page.visibility("visible");
  page.stop();
  page.focus(false);
  t.mock.timers.tick(10_000);
  assert.deepEqual(page.reports.map(({ state, sequence }) => [state, sequence]), [
    ["active", 1], ["active", 2], ["inactive", 3], ["active", 4],
    ["inactive", 5], ["active", 6], ["inactive", 7],
  ]);
  assert.equal(new Set(page.reports.map(report => report.tab)).size, 1);
});

test("visible phone Study renews without window focus, and restores after pagehide", t => {
  const page = browser(t, "phone");
  page.focus(false);
  t.mock.timers.tick(10_000);
  page.lifecycle("pagehide");
  t.mock.timers.tick(10_000);
  page.lifecycle("pageshow");
  page.visibility("hidden");
  assert.deepEqual(page.reports.map(report => report.state), [
    "active", "active", "inactive", "active", "inactive",
  ]);
});
