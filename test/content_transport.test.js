import assert from "node:assert/strict";
import test from "node:test";
import { SHORT_ACK_TIMEOUT_MS, SMALL_READ_TIMEOUT_MS } from "../bounded_read.js";
import { commandRecovery, JsonHttpError, postCommand, requestJson } from "../content_transport.js";
import { sendRepertoireCommand } from "../repertoire_commands.js";
import { createStudyController } from "../study_controller.js";
import { studyTransport } from "../study_transport.js";
import { sendTacticCommand } from "../tactic_commands.js";
import { complete, ready } from "../view_fixtures.js";

function json(reply, status = 200) {
  return new Response(JSON.stringify(reply), { status });
}

test("non-success JSON preserves structured code, message, retryability and status", async t => {
  const body = { schema_version: 1, status: "error", code: "conflict", message: "Version changed.", retryable: false };
  const get = t.mock.method(globalThis, "fetch", async () => json(body, 409));
  await assert.rejects(requestJson("/example"), error => {
    assert.ok(error instanceof JsonHttpError);
    assert.equal(error.status, 409);
    assert.equal(error.code, body.code);
    assert.equal(error.message, body.message);
    assert.equal(error.retryable, false);
    assert.deepEqual(error.details, body);
    return true;
  });
  get.mock.mockImplementation(async () => json({
    schema_version: 1, status: "error", code: "expired", request_id: "r", dataset_id: "d",
  }, 404));
  await assert.rejects(requestJson("/result"), error =>
    error.status === 404 && error.retryable === undefined && error.code === "expired" &&
    error.details.request_id === "r" && error.details.dataset_id === "d");
});

test("HTML, empty replies and malformed error bodies preserve delivery uncertainty", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response("<html>", { status: 502 }));
  const fallback = error => error instanceof JsonHttpError && error.status === 502 &&
    error.details === undefined && error.code === undefined && error.retryable === undefined &&
    /502/.test(error.message);
  await assert.rejects(requestJson("/example"), fallback);
  fetch.mock.mockImplementation(async () => new Response(null, { status: 502 }));
  await assert.rejects(requestJson("/example"), fallback);
  fetch.mock.mockImplementation(async () => json({
    status: "error", code: "busy", message: "Wait.", retryable: "false",
  }, 502));
  await assert.rejects(requestJson("/example"), fallback);
  fetch.mock.mockImplementation(async () => json({ status: "complete" }));
  await assert.rejects(requestJson("/example", { expectedStatus: 202 }), error =>
    error instanceof JsonHttpError && error.status === 200);
});

test("HTTP 200 typed error reaches existing Study, repertoire and tactic consumers", async t => {
  const errorBody = { schema_version: 4, status: "error", code: "conflict", message: "Version changed.", retryable: false };
  t.mock.method(globalThis, "fetch", async path => json(
    path === "/api/study" ? { ...errorBody, schema_version: 5 } : errorBody));
  const { controller, stored } = studyHarness();
  assert.deepEqual(await controller.start(), { ...errorBody, schema_version: 5 });
  assert.equal(controller.getState().canRetry, false);
  assert.equal(stored().pending, null);
  assert.deepEqual(await sendRepertoireCommand({ command: "preview" }), errorBody);
  assert.deepEqual(await sendTacticCommand({ command: "save" }), errorBody);
});

test("the reply deadline covers noncooperative fetch and body parsing", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let arrived = Promise.withResolvers();
  let late = Promise.withResolvers();
  let signal;
  const fetch = t.mock.method(globalThis, "fetch", async (_, init) => {
    signal = init.signal;
    arrived.resolve();
    return late.promise;
  });
  const first = requestJson("/progress", { timeoutMs: SMALL_READ_TIMEOUT_MS });
  await arrived.promise;
  t.mock.timers.tick(SMALL_READ_TIMEOUT_MS);
  await assert.rejects(first, { name: "TimeoutError" });
  assert.equal(signal.aborted, true);
  late.resolve(json({ stale: true }));

  arrived = Promise.withResolvers();
  late = Promise.withResolvers();
  fetch.mock.mockImplementation(async (_, init) => {
    signal = init.signal;
    return {
      ok: true,
      json() {
        arrived.resolve();
        return late.promise;
      },
    };
  });
  const second = requestJson("/progress", { timeoutMs: SMALL_READ_TIMEOUT_MS });
  await arrived.promise;
  t.mock.timers.tick(SMALL_READ_TIMEOUT_MS);
  await assert.rejects(second, { name: "TimeoutError" });
  assert.equal(signal.aborted, true);
  late.resolve({ stale: true });
});

test("owner cancellation of an uncapped PGN request settles and fences a late body", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const arrived = Promise.withResolvers();
  const late = Promise.withResolvers();
  const owner = new AbortController();
  const payload = { command: "save", pgn: "{comment}".repeat(12_000) };
  const reason = new DOMException("Owner closed.", "AbortError");
  let signal;
  let delivered = false;
  t.mock.method(globalThis, "fetch", async (_, init) => {
    signal = init.signal;
    assert.deepEqual(JSON.parse(init.body), payload);
    return { ok: true, json() { arrived.resolve(); return late.promise; } };
  });
  const reply = postCommand("/content", payload, owner.signal).then(value => {
    delivered = true;
    return value;
  });
  await arrived.promise;
  t.mock.timers.tick(9 * SHORT_ACK_TIMEOUT_MS);
  assert.equal(signal.aborted, false);
  owner.abort(reason);
  await assert.rejects(reply, error => error === reason);
  assert.equal(signal.reason, reason);
  late.resolve({ status: "complete" });
  assert.equal(delivered, false);
});

function studyHarness() {
  let saved;
  let submission = 0;
  const controller = createStudyController({
    transport: studyTransport,
    storage: {
      load: () => null,
      save(value) { saved = structuredClone(value); },
    },
    render() {},
    makeSubmissionId: () => `submission-${++submission}`,
  });
  return { controller, stored: () => saved };
}

test("Study timeout replays the exact Answer and an interrupted Next only retries Next", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const arrive = Promise.withResolvers();
  const requests = [];
  const { controller, stored } = studyHarness();
  const fetch = t.mock.method(globalThis, "fetch", async (path, init) => {
    assert.equal(path, "/api/study");
    assert.equal(init.headers["X-Tempo-Move-Details"], "1");
    requests.push(init.body);
    if (requests.length === 1) return json(ready());
    const original = JSON.parse(init.body);
    assert.equal(stored().pending.submission_id, original.submission_id);
    arrive.resolve();
    return { ok: true, json: () => new Promise(() => {}) };
  });
  await controller.start();
  const firstAnswer = controller.answer("e2e4");
  await arrive.promise;
  const timeout = assert.rejects(firstAnswer, { name: "TimeoutError" });
  t.mock.timers.tick(SHORT_ACK_TIMEOUT_MS);
  await timeout;
  assert.equal(controller.getState().canRetry, true);
  assert.equal(stored().pending.submission_id, "submission-1");

  const nextStarted = Promise.withResolvers();
  fetch.mock.mockImplementation(async (_, init) => {
    requests.push(init.body);
    if (requests.length === 3) return json(complete({ revision: 1 }));
    if (requests.length === 4) {
      nextStarted.resolve();
      return new Promise(() => {});
    }
    return json(ready({ attempt_id: "next-attempt" }));
  });
  await controller.retry();
  assert.equal(requests[1], requests[2]);
  const next = controller.next();
  await nextStarted.promise;
  const nextTimeout = assert.rejects(next, { name: "TimeoutError" });
  t.mock.timers.tick(SHORT_ACK_TIMEOUT_MS);
  await nextTimeout;
  assert.equal(controller.getState().view.assessment, "good");
  assert.equal(controller.getState().retryingNext, true);
  await controller.retry();
  assert.deepEqual(requests.map(body => JSON.parse(body).command), [
    "next", "answer", "answer", "next", "next",
  ]);
  assert.equal(controller.getState().view.attempt_id, "next-attempt");
});

test("recovery clear keeps a live pointer on detach failure and distinguishes an orphan", async t => {
  const key = "recovery-test";
  const pointerKey = `${key}-external`;
  const external = JSON.stringify({ id: "blob", identity: { command: "save" } });
  const values = new Map([[pointerKey, external]]);
  let fail = true;
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const originalDatabase = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
    getItem: key => values.get(key) ?? null,
    removeItem(key) {
      if (fail && key === pointerKey) throw new Error("detach failed");
      values.delete(key);
    },
  } });
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: {
    open() {
      const request = { error: new Error("blob delete failed") };
      queueMicrotask(() => request.onerror());
      return request;
    },
  } });
  t.after(() => {
    if (originalStorage) Object.defineProperty(globalThis, "sessionStorage", originalStorage);
    else delete globalThis.sessionStorage;
    if (originalDatabase) Object.defineProperty(globalThis, "indexedDB", originalDatabase);
    else delete globalThis.indexedDB;
  });
  const recovery = commandRecovery(key);
  await assert.rejects(recovery.clear(), /detach failed/);
  assert.equal(values.get(pointerKey), external);
  fail = false;
  assert.deepEqual(await recovery.clear(), { orphaned: true });
  assert.equal(values.has(pointerKey), false);
  values.set(pointerKey, "null");
  await assert.rejects(recovery.load({ strict: true }), /Invalid saved command reference/);
  values.set(pointerKey, "{ corrupt");
  assert.deepEqual(await recovery.clear(), { orphaned: true });
  assert.equal(values.has(pointerKey), false);
  values.set(key, "false");
  await assert.rejects(recovery.load({ strict: true }), /Invalid saved command/);
  values.set(key, JSON.stringify({ command: "save" }));
  assert.deepEqual(await recovery.load({ strict: true }), { command: "save" });
  assert.deepEqual(await recovery.clear(), { orphaned: false });
  assert.equal(values.has(key), false);
});
