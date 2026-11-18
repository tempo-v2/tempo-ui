// Usage scenarios for src/study_controller.js, exercised through the public package barrel.
import assert from "node:assert/strict";
import test from "node:test";
import { createStudyController } from "./index.js";
import { ready, complete } from "./view_fixtures.js";

test("controller forwards only command data with the server's expected revision", async () => {
  const sent = [];
  const rendered = [];
  let id = 0;
  const controller = createStudyController({
    storage: { load: () => null, save() {} },
    transport: {
      send: async (command) => {
        sent.push(command);
        return command.command === "answer"
          ? complete({ revision: 8 })
          : ready({ revision: 7 });
      },
    },
    render: (view, state) => rendered.push({ view, state }),
    makeSubmissionId: () => `submission-${++id}`,
  });
  await controller.next();
  await controller.answer("e2e4");
  assert.deepEqual(sent, [
    { command: "next" },
    {
      command: "answer",
      dataset_id: "dataset-1",
      attempt_id: "attempt-1",
      submission_id: "submission-1",
      expected_revision: 7,
      answer: { uci: "e2e4" },
    },
  ]);
  assert.equal(controller.getState().view.assessment, "good");
  assert.ok(rendered.some(({ state }) => state.busy));
  await assert.rejects(controller.answer("d2d4"), /ready exercise/);
  assert.equal(sent.length, 2);
});

test("resume and abandonment are separate commands with no client-side assessment", async () => {
  const sent = [];
  const controller = createStudyController({
    storage: { load: () => null, save() {} },
    transport: {
      send: async (command) => {
        sent.push(command);
        return command.command === "abandon"
          ? complete({ status: "abandoned", assessment: null, revision: 4 })
          : ready({ revision: 3 });
      },
    },
    render: () => {},
    makeSubmissionId: () => "abandon-1",
  });
  await controller.resume("attempt-1");
  await controller.abandon();
  assert.deepEqual(sent, [
    { command: "resume", attempt_id: "attempt-1" },
    {
      command: "abandon",
      dataset_id: "dataset-1",
      attempt_id: "attempt-1",
      submission_id: "abandon-1",
      expected_revision: 3,
    },
  ]);
  assert.equal(controller.getState().view.status, "abandoned");
});

test("transport failure retries the identical command and submission ID", async () => {
  const sent = [];
  let fail = true;
  let ids = 0;
  const controller = createStudyController({
    storage: { load: () => null, save() {} },
    transport: {
      send: async (command) => {
        sent.push(command);
        if (command.command === "next") return ready();
        if (fail) {
          fail = false;
          throw new Error("response lost after commit");
        }
        return complete({ revision: 1 });
      },
    },
    render: () => {},
    makeSubmissionId: () => `s-${++ids}`,
  });
  await controller.next();
  await assert.rejects(controller.answer("e2e4"), /response lost/);
  assert.equal(controller.getState().canRetry, true);
  await assert.rejects(controller.next(), /unresolved command/);
  await controller.retry();
  assert.equal(sent[1], sent[2]);
  assert.ok(Object.isFrozen(sent[1].answer));
  assert.equal(ids, 1);
  assert.equal(controller.getState().canRetry, false);
  await assert.rejects(controller.retry(), /no unresolved command/);
});

test("a malformed reply retains the original command because its commit is unknown", async () => {
  let invalid = false;
  const sent = [];
  const controller = createStudyController({
    storage: { load: () => null, save() {} },
    transport: {
      send: async (command) => {
        sent.push(command);
        if (command.command === "next") return ready();
        if (!invalid) {
          invalid = true;
          return { broken: true };
        }
        return complete();
      },
    },
    render: () => {},
    makeSubmissionId: () => "s-1",
  });
  await controller.next();
  await assert.rejects(controller.answer("e2e4"), TypeError);
  await controller.retry();
  assert.equal(sent[1], sent[2]);
});

test("retryable application errors retain the command; final errors release it", async () => {
  const commands = [];
  const responses = [
    {
      schema_version: 4,
      status: "error",
      code: "busy",
      message: "Try again",
      retryable: true,
    },
    {
      schema_version: 4,
      status: "error",
      code: "stale",
      message: "Request is stale",
      retryable: false,
    },
    ready(),
  ];
  const controller = createStudyController({
    storage: { load: () => null, save() {} },
    transport: {
      send: async (command) => {
        commands.push(command);
        return responses.shift();
      },
    },
    render: () => {},
    makeSubmissionId: () => "s-1",
  });
  await controller.next();
  assert.equal(controller.getState().canRetry, true);
  await controller.retry();
  assert.equal(commands[0], commands[1]);
  assert.equal(controller.getState().canRetry, false);
  await controller.next();
  assert.equal(controller.getState().view.status, "ready");
});

test("busy guard suppresses concurrent submission without allocating another ID", async () => {
  let release;
  let ids = 0;
  const commands = [];
  const controller = createStudyController({
    storage: { load: () => null, save() {} },
    transport: {
      send: (command) => {
        commands.push(command);
        if (command.command === "next") return Promise.resolve(ready());
        return new Promise((resolve) => {
          release = () => resolve(complete());
        });
      },
    },
    render: () => {},
    makeSubmissionId: () => `s-${++ids}`,
  });
  await controller.next();
  const first = controller.answer("e2e4");
  assert.equal(controller.getState().busy, true);
  assert.equal(await controller.answer("d2d4"), null);
  assert.equal(await controller.retry(), null);
  assert.equal(ids, 1);
  assert.equal(commands.length, 2);
  release();
  await first;
  assert.equal(controller.getState().busy, false);
});

test("lesson acknowledgement replays the reproduced move with no recall grade", async () => {
  const lesson = { move_uci: "e2e4", move_san: "e4", comments: [] };
  const requests = [];
  let saved;
  const create = () => createStudyController({
    storage: {
      load: () => saved,
      save: (envelope) => { saved = structuredClone(envelope); },
    },
    transport: {
      async send(command) {
        if (command.command === "next") return ready({ activity: "teach", lesson });
        requests.push(command);
        if (requests.length === 1) throw new Error("acknowledgement reply lost");
        return complete({ activity: "teach", assessment: null });
      },
    },
    render() {},
    makeSubmissionId: () => "lesson-1",
  });
  let controller = create();
  await controller.start();
  await assert.rejects(controller.acknowledge("d2d4"), /Reproduce/);
  assert.equal(requests.length, 0);
  await assert.rejects(controller.acknowledge("e2e4"), /reply lost/);
  assert.deepEqual(saved.pending.answer, { uci: "e2e4" });
  controller = create();
  await controller.start();
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(requests[1].submission_id, "lesson-1");
  assert.equal(controller.getState().view.assessment, null);
  assert.equal(saved.pending, null);
});
