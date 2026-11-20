import assert from "node:assert/strict";
import test from "node:test";
import { requestJson, postCommand } from "../content_transport.js";
import { clearDiagnostics, diagnosticsSnapshot, recordDiagnostic } from "../diagnostics.js";

const end = () => diagnosticsSnapshot().events.findLast(event => event.event === "request_end");
const settle = () => new Promise(resolve => setImmediate(resolve));

test("transport correlation is per delivery and export excludes commands, answers, paths and messages", async t => {
  clearDiagnostics();
  const commands = [];
  const ids = [];
  const command = { command: "answer", submission_id: "private-command", answer: "private-answer", pgn: "private-pgn" };
  const reply = { status: "error", code: "private-code", message: "private-server-message", retryable: true };
  t.mock.method(globalThis, "fetch", async (path, init) => {
    commands.push(init.body);
    ids.push(init.headers["X-Tempo-Request-Id"]);
    assert.equal(path, "/api/study?token=private-query#private-fragment");
    assert.equal(init.headers.Authorization, "private-credential");
    assert.equal(init.headers["x-tempo-request-id"], undefined);
    return new Response(JSON.stringify(reply), { headers: {
      "X-Tempo-Request-Id": ids.at(-1), "X-Tempo-Run-Id": "19ac2-123-a8f",
      "Server-Timing": "tempo;dur=123.5",
    } });
  });
  for (let count = 0; count < 2; count++) {
    assert.deepEqual(await postCommand("/api/study?token=private-query#private-fragment", command, undefined,
      { Authorization: "private-credential", "x-tempo-request-id": "private-caller-id" }), reply);
    const event = end();
    assert.equal(event.route, "/api/study");
    assert.equal(event.request_id, ids.at(-1));
    assert.equal(event.run_id, "19ac2-123-a8f");
    assert.equal(event.server_request_matches, true);
    assert.equal(event.server_ms, 123.5);
    assert.equal(event.application_error, true);
    assert.equal(event.outcome, "received");
  }
  assert.deepEqual(commands, [JSON.stringify(command), JSON.stringify(command)]);
  assert.notEqual(ids[0], ids[1]);
  assert.doesNotMatch(JSON.stringify(diagnosticsSnapshot()), /private-/);
});

test("noncooperative fetch timeout identifies delivery and deadline delay without claiming acceptance", async t => {
  clearDiagnostics();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let clock = 100;
  t.mock.method(performance, "now", () => clock);
  const entered = Promise.withResolvers();
  const late = Promise.withResolvers();
  let signal;
  let id;
  t.mock.method(globalThis, "fetch", (_, init) => {
    signal = init.signal;
    id = init.headers["X-Tempo-Request-Id"];
    entered.resolve();
    return late.promise;
  });
  const request = requestJson("/api/games/job", { timeoutMs: 5000 });
  await entered.promise;
  const rejection = assert.rejects(request, error => {
    assert.equal(error, signal.reason);
    assert.equal(error.name, "TimeoutError");
    assert.ok(error.message.includes(id));
    return true;
  });
  clock = 6250;
  t.mock.timers.tick(5000);
  await rejection;
  assert.equal(end().phase, "fetch");
  assert.equal(end().outcome, "timeout");
  assert.equal(end().budget_ms, 5000);
  assert.equal(end().elapsed_ms, 6150);
  assert.equal(end().deadline_delay_ms, 1150);
  assert.equal(end().stop_source, "deadline");
  assert.equal(end().http_status, undefined);
  late.resolve(new Response("{\"late\":true}"));
  await settle();
  const events = diagnosticsSnapshot().events;
  assert.equal(events.filter(event => event.event === "request_end").length, 1);
  assert.equal(events.at(-1).event, "late_response");
  assert.equal(end().outcome, "timeout");
});

test("a stalled JSON body is distinct from waiting for response headers", async t => {
  clearDiagnostics();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let clock = 0;
  t.mock.method(performance, "now", () => clock);
  const parsing = Promise.withResolvers();
  const late = Promise.withResolvers();
  t.mock.method(globalThis, "fetch", async () => {
    clock = 125;
    return { ok: true, status: 200, json() { parsing.resolve(); return late.promise; } };
  });
  const request = requestJson("/api/study-progress", { timeoutMs: 5000 });
  await parsing.promise;
  clock = 5000;
  const rejection = assert.rejects(request, { name: "TimeoutError" });
  t.mock.timers.tick(5000);
  await rejection;
  assert.equal(end().phase, "body");
  assert.equal(end().fetch_ms, 125);
  assert.equal(end().body_ms, 4875);
  assert.equal(end().http_status, 200);
  assert.equal(end().outcome, "timeout");
  late.resolve({ status: "complete", hidden_answer: "private-answer" });
  await settle();
  assert.equal(diagnosticsSnapshot().events.at(-1).event, "late_body");
  assert.equal(end().outcome, "timeout");
  assert.doesNotMatch(JSON.stringify(diagnosticsSnapshot()), /private-answer/);
});

test("owner cancellation preserves its reason and does not invent a local deadline", async t => {
  clearDiagnostics();
  const entered = Promise.withResolvers();
  const owner = new AbortController();
  const reason = new DOMException("private-owner-reason", "TimeoutError");
  t.mock.method(globalThis, "fetch", () => { entered.resolve(); return new Promise(() => {}); });
  const request = requestJson("/api/games/gap-draft", { signal: owner.signal });
  await entered.promise;
  const rejection = assert.rejects(request, error => error === reason);
  owner.abort(reason);
  await rejection;
  assert.equal(end().stop_source, "owner");
  assert.equal(end().deadline_delay_ms, undefined);
  assert.equal(end().budget_ms, undefined);
  assert.equal(end().outcome, "timeout");
  assert.doesNotMatch(JSON.stringify(diagnosticsSnapshot()), /private-owner/);
});

test("the first cancellation source wins and an already cancelled owner never sends", async t => {
  clearDiagnostics();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const owner = new AbortController();
  const entered = Promise.withResolvers();
  const fetch = t.mock.method(globalThis, "fetch", () => { entered.resolve(); return new Promise(() => {}); });
  const request = requestJson("/api/study-progress", { signal: owner.signal, timeoutMs: 5000 });
  await entered.promise;
  const rejection = assert.rejects(request, { name: "TimeoutError" });
  t.mock.timers.tick(5000);
  owner.abort(new DOMException("private-owner", "AbortError"));
  await rejection;
  assert.equal(end().stop_source, "deadline");
  await assert.rejects(requestJson("/api/study-progress", { signal: owner.signal }), error => error === owner.signal.reason);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(end().phase, "not_started");
  assert.equal(end().stop_source, "owner");
  assert.equal(end().outcome, "cancelled");
});

test("the ring and every event are bounded and reject unrecognized fields", () => {
  clearDiagnostics();
  for (let i = 0; i < 520; i++) recordDiagnostic({
    event: "request_start", route: "/private-user", method: "private-method", at_ms: i,
    request_id: "private-user", run_id: "private-user", body: { pgn: "private-pgn" },
    elapsed_ms: Infinity, error_name: "private-error", budget_ms: "private-budget",
  });
  const snapshot = diagnosticsSnapshot();
  assert.equal(snapshot.events.length, 500);
  assert.equal(snapshot.discarded_events, 20);
  assert.equal(snapshot.events[0].at_ms, 20);
  assert.deepEqual(Object.keys(snapshot.events[0]).sort(), ["at_ms", "event"]);
  snapshot.events[0].body = "private-added-by-reader";
  assert.doesNotMatch(JSON.stringify(diagnosticsSnapshot()), /private-/);
  assert.ok(JSON.stringify(diagnosticsSnapshot()).length < 500 * 1000);
});

test("recorder failure and malformed diagnostic headers cannot change transport results", async t => {
  clearDiagnostics();
  const push = Array.prototype.push;
  Array.prototype.push = function (...items) {
    if (items[0]?.event) throw new Error("fixture full recorder");
    return push.apply(this, items);
  };
  t.after(() => { Array.prototype.push = push; });
  const reply = { status: "complete", value: 9 };
  t.mock.method(globalThis, "fetch", async () => ({
    ok: true, status: 200,
    get headers() { throw new Error("fixture unavailable headers"); },
    json: async () => reply,
  }));
  assert.doesNotThrow(() => recordDiagnostic(new Proxy({}, { get() { throw new Error("unreadable"); } })));
  assert.equal(await requestJson("/api/study"), reply);
  assert.ok(diagnosticsSnapshot().discarded_events >= 3);
  assert.deepEqual(diagnosticsSnapshot().events, []);
});

test("unknown routes and server IDs are omitted while a header mismatch remains observable", async t => {
  clearDiagnostics();
  t.mock.method(globalThis, "fetch", async () => new Response("{}", { headers: {
    "X-Tempo-Request-Id": "private-untrusted-id", "X-Tempo-Run-Id": "private-run-id",
    "Server-Timing": 'tempo;desc="private-timing"',
  } }));
  await requestJson("/api/private-user?token=private-token");
  assert.equal(end().route, "other");
  assert.equal(end().server_request_matches, false);
  assert.equal(end().run_id, undefined);
  assert.equal(end().server_ms, undefined);
  assert.doesNotMatch(JSON.stringify(diagnosticsSnapshot()), /private-/);
});

test("fallback request IDs remain compatible and a falsy rejection is still a failure", async t => {
  clearDiagnostics();
  t.mock.method(crypto, "randomUUID", () => { throw new Error("fixture no randomUUID"); });
  const ids = [];
  t.mock.method(globalThis, "fetch", (_, init) => { ids.push(init.headers["X-Tempo-Request-Id"]); return Promise.reject(null); });
  for (let i = 0; i < 2; i++) {
    await assert.rejects(requestJson("/api/study"), error => error === null);
    assert.equal(end().outcome, "failed");
    assert.equal(end().error_name, "Other");
  }
  assert.notEqual(ids[0], ids[1]);
  assert.ok(ids.every(id => /^[0-9a-fA-F-]{8,64}$/.test(id)));
});
