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
      schema_version: 5,
      status: "error",
      code: "busy",
      message: "Try again",
      retryable: true,
    },
    {
      schema_version: 5,
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
        if (command.command === "next") {
          if (requests.length >= 2) {
            requests.push(command);
            if (requests.length === 3) throw new Error("next reply lost");
            return ready();
          }
          return ready({ activity: "teach", lesson });
        }
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
  const accepted = await controller.start();
  assert.equal(accepted.status, "complete");
  assert.equal(controller.getState().retryingNext, true);
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(requests[1].submission_id, "lesson-1");
  assert.equal(controller.getState().view.activity, "teach");
  assert.equal(controller.getState().view.status, "complete");
  assert.equal(controller.getState().view.assessment, null);
  assert.equal(saved.pending, null);
  await controller.retry();
  assert.equal(requests[2], requests[3]);
  assert.equal(requests[3].command, "next");
  assert.equal(controller.getState().view.status, "ready");
});

test("an uncertain extra tactics allowance replays its exact command before asking for Next", async () => {
  const done = {
    schema_version: 5, status: "empty", dataset_id: "dataset-1", done: true,
    outstanding: 0, repertoire_remaining: 0, tactics_remaining: 0,
    can_practice_tactics: true, can_learn_more_tactics: true, learn_more_count: 4,
  };
  let saved;
  let lost = true;
  const requests = [];
  const create = () => createStudyController({
    storage: {
      load: () => saved,
      save: (envelope) => { saved = structuredClone(envelope); },
    },
    transport: {
      async send(command) {
        requests.push(command);
        if (command.command === "next") return requests.length === 1 ? done : ready();
        assert.equal(command.command, "learn_more_tactics");
        assert.deepEqual(command, saved.pending);
        if (lost) {
          lost = false;
          throw new Error("allowance reply lost");
        }
        return { ...done, done: false, outstanding: 4, tactics_remaining: 4 };
      },
    },
    render() {},
    makeSubmissionId: () => "extra-allowance",
  });
  const first = create();
  await first.start();
  await assert.rejects(first.learnMoreTactics(), /reply lost/);
  const reopened = create();
  await reopened.start();
  assert.deepEqual(requests[1], requests[2]);
  assert.deepEqual(requests[3], { command: "next" });
  assert.equal(reopened.getState().view.status, "ready");
  assert.equal(saved.pending, null);
});


test("analysis recovery replays an uncertain concession once and reopens the accepted position without Next", async () => {
  let saved, drop = true;
  const sent = [];
  const controller = () => createStudyController({
    storage: { load: () => structuredClone(saved), save: value => { saved = structuredClone(value); } },
    render() {}, makeSubmissionId: () => "concession",
    transport: { send: async command => {
      sent.push(JSON.stringify(command));
      if (command.command === "next") return ready();
      if (drop) { drop = false; throw new Error("reply was lost"); }
      return complete({ status: "abandoned", assessment: "again", revision: 1 });
    } },
  });
  const first = controller();
  await first.start();
  await assert.rejects(first.openAnalysis(), /reply was lost/);
  assert.equal(first.getState().analysis, null);
  assert.equal(saved.pending.command, "concede");
  const recovering = controller();
  await recovering.start();
  assert.equal(recovering.getState().analysis.revision, 1);
  assert.equal(sent[1], sent[2]);
  const reopened = controller();
  await reopened.start();
  assert.equal(sent.length, 3);
  assert.equal(reopened.getState().analysis.attempt_id, "attempt-1");
  await reopened.closeAnalysis();
  assert.deepEqual(sent.map(value => JSON.parse(value).command), ["next", "concede", "concede", "next"]);
  assert.deepEqual(saved, { pending: null });
});

test("guided analysis resumes its original attempt and practice accepts assistance before opening", async () => {
  for (const activity of ["teach", "practice"]) {
    const sent = [];
    const initial = ready({ activity, ...(activity === "teach" && { lesson: {
      move_uci: "e2e4", move_san: "e4", comments: [],
    } }) });
    const controller = createStudyController({
      storage: { load: () => null, save() {} }, render() {}, makeSubmissionId: () => "assist",
      transport: { send: async command => {
        sent.push(command.command);
        return command.command === "give_up" ? { ...initial, assessment: "again", revision: 1 } : initial;
      } },
    });
    await controller.start();
    await controller.openAnalysis();
    assert.equal(controller.getState().analysis.returnTo, "resume");
    await controller.closeAnalysis();
    assert.deepEqual(sent, activity === "teach" ? ["next", "resume"] : ["next", "give_up", "resume"]);
  }
});

test("a failed Next after analysis preserves the confirmed grade and reload retries only Next", async () => {
  let saved, failNext = false;
  const commands = [];
  const make = () => createStudyController({
    storage: { load: () => structuredClone(saved), save: value => { saved = structuredClone(value); } },
    render() {}, makeSubmissionId: () => "confirmed",
    transport: { send: async command => {
      commands.push(command.command);
      if (command.command === "concede") return complete({ status: "abandoned", assessment: "again", revision: 1 });
      if (failNext) throw new Error("Next unavailable");
      return ready();
    } },
  });
  const original = make();
  await original.start();
  await original.openAnalysis();
  failNext = true;
  await assert.rejects(original.closeAnalysis(), /Next unavailable/);
  assert.equal(original.getState().view.assessment, "again");
  assert.equal(original.getState().retryingNext, true);
  const recovered = make();
  assert.equal(recovered.getState().view.assessment, "again");
  failNext = false;
  await recovered.start();
  assert.deepEqual(commands, ["next", "concede", "next", "next"]);
});
