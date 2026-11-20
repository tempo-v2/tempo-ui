import assert from "node:assert/strict";
import test from "node:test";
import { SMALL_READ_TIMEOUT_MS } from "../bounded_read.js";
import { JsonHttpError } from "../content_transport.js";
import { phoneStudyTransport } from "../phone_study_transport.js";
import { createStudyController } from "../study_controller.js";
import { complete, ready } from "../view_fixtures.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test("phone guidance preserves server error facts and labels only an unavailable connection", async t => {
  const details = { status: "error", code: "busy", message: "Retry this command.", retryable: true };
  const fetch = t.mock.method(globalThis, "fetch", async () => json(details, 503));
  await assert.rejects(phoneStudyTransport.send({ command: "study_status" }), error =>
    error instanceof JsonHttpError && error.status === 503 && error.code === "busy" &&
    error.retryable === true && error.message === details.message && error.details.code === "busy");

  fetch.mock.mockImplementation(async () => new Response(null, { status: 503 }));
  await assert.rejects(phoneStudyTransport.send({ command: "study_status" }), error =>
    error instanceof JsonHttpError && error.status === 503 && error.details === undefined &&
    /Check Tailscale/.test(error.message));
});

test("phone reply parsing uses the shared deadline even when a response ignores cancellation", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const arrived = Promise.withResolvers();
  const late = Promise.withResolvers();
  let signal;
  t.mock.method(globalThis, "fetch", async (_, options) => {
    signal = options.signal;
    return { ok: true, json() { arrived.resolve(); return late.promise; } };
  });
  const pending = phoneStudyTransport.send({ command: "study_status" });
  await arrived.promise;
  const expired = assert.rejects(pending, error =>
    error.name === "TimeoutError" && /Check Tailscale/.test(error.message));
  t.mock.timers.tick(SMALL_READ_TIMEOUT_MS);
  await expired;
  assert.equal(signal.aborted, true);
  late.resolve({ status: "empty" });
});

test("phone retries the original answer and retries only Next after an accepted answer", async t => {
  let saved;
  let submission = 0;
  const requests = [];
  const replies = [json(ready()), new Response(null, { status: 503 }),
    json(complete({ revision: 1 })), new Response(null, { status: 503 }),
    json(ready({ attempt_id: "next-attempt" }))];
  t.mock.method(globalThis, "fetch", async (path, options) => {
    assert.equal(path, "/api/study");
    assert.equal(options.headers["X-Tempo-Move-Details"], "1");
    requests.push(options.body);
    return replies.shift();
  });
  const controller = createStudyController({
    transport: phoneStudyTransport,
    storage: { load: () => null, save(value) { saved = structuredClone(value); } },
    render() {},
    makeSubmissionId: () => `phone-${++submission}`,
  });
  await controller.start();
  await assert.rejects(controller.answer("e2e4"), /Check Tailscale/);
  assert.equal(saved.pending.submission_id, "phone-1");
  await controller.retry();
  assert.equal(requests[1], requests[2]);
  assert.equal(controller.getState().view.assessment, "good");
  await assert.rejects(controller.next(), /Check Tailscale/);
  assert.equal(controller.getState().retryingNext, true);
  await controller.retry();
  assert.deepEqual(requests.map(body => JSON.parse(body).command),
    ["next", "answer", "answer", "next", "next"]);
  assert.equal(controller.getState().view.attempt_id, "next-attempt");
});
