import test from "node:test";
import assert from "node:assert/strict";
import { createStudyController } from "../study_controller.js";
const ready = {
  schema_version: 5,
  status: "ready",
  activity: "test",
  dataset_id: "d",
  attempt_id: "a",
  target_id: "t",
  content_version: 1,
  revision: 0,
  prompt: {
    fen: "fen w - - 0 1",
    instruction: "Move",
    decision_index: 0,
    decision_count: 1,
  },
  feedback: null,
  assessment: null,
  display_fen: "fen w - - 0 1",
  learner_color: "white",
  legal_moves: ["e2e4"],
  in_check: false,
};
test("persist before send and replay exact command after loss", async () => {
  let saved = null,
    lose = true;
  const calls = [];
  const storage = {
    load: () => saved,
    save: (v) => {
      saved = structuredClone(v);
    },
  };
  const transport = {
    send: async (c) => {
      calls.push(c);
      if (c.command === "answer" && lose) {
        lose = false;
        throw Error("lost");
      }
      return ready;
    },
  };
  const make = () =>
    createStudyController({
      storage,
      transport,
      render() {},
      makeSubmissionId: () => "id",
    });
  let ui = make();
  await ui.start();
  await assert.rejects(ui.answer("e2e4"));
  assert.equal(saved.pending.submission_id, "id");
  ui = make();
  await ui.start();
  assert.deepEqual(calls[1], calls[2]);
  assert.equal(saved.pending, null);
});
test("storage failure prevents sending a new answer", async () => {
  let fail = false,
    calls = 0;
  const ui = createStudyController({
    storage: {
      load: () => null,
      save() {
        if (fail) throw Error("storage");
      },
    },
    transport: {
      async send() {
        calls++;
        return ready;
      },
    },
    render() {},
    makeSubmissionId: () => "id",
  });
  await ui.start();
  fail = true;
  await assert.rejects(ui.answer("e2e4"));
  assert.equal(calls, 1);
});
test("failed resolution keeps the committed command for receipt replay", async () => {
  let saved = null,
    fail = false;
  const commands = [];
  const storage = {
    load: () => saved,
    save(v) {
      if (fail && !v.pending) throw Error("disk full");
      saved = structuredClone(v);
    },
  };
  const transport = {
    async send(c) {
      commands.push(c);
      return ready;
    },
  };
  const ui = createStudyController({
    storage,
    transport,
    render() {},
    makeSubmissionId: () => "id",
  });
  await ui.start();
  fail = true;
  await assert.rejects(ui.answer("e2e4"), /disk full/);
  assert.equal(ui.getState().canRetry, true);
  await assert.rejects(ui.answer("e2e4"), /unresolved/);
  fail = false;
  await ui.retry();
  assert.deepEqual(commands[1], commands[2]);
  assert.equal(saved.pending, null);
});
test("unavailable recovery storage blocks startup and mutation", async () => {
  let sends = 0,
    observed;
  const ui = createStudyController({
    storage: {
      load() {
        throw Error("denied");
      },
      save() {},
    },
    transport: {
      async send() {
        sends++;
        return ready;
      },
    },
    render(_v, s) {
      observed = s;
    },
    makeSubmissionId: () => "id",
  });
  await assert.rejects(ui.start(), /Recovery storage/);
  await assert.rejects(ui.next(), /Recovery storage/);
  assert.match(observed.issue, /Recovery storage/);
  assert.equal(sends, 0);
});
test("concurrent startup does not replay twice", async () => {
  let release,
    sends = 0;
  const pending = {
    command: "answer",
    dataset_id: "d",
    attempt_id: "a",
    submission_id: "s",
    expected_revision: 0,
    answer: { uci: "e2e4" },
  };
  const ui = createStudyController({
    storage: { load: () => ({ pending }), save() {} },
    transport: {
      send() {
        sends++;
        return new Promise((r) => (release = r));
      },
    },
    render() {},
    makeSubmissionId: () => "id",
  });
  const first = ui.start();
  assert.equal(await ui.start(), null);
  release(ready);
  await first;
  assert.equal(sends, 1);
});
test("stale revision blocks repeated mutations until refresh succeeds", async () => {
  const commands = [];
  const stale = {
    schema_version: 5,
    status: "error",
    code: "stale_revision",
    message: "stale",
    retryable: false,
  };
  const ui = createStudyController({
    storage: { load: () => null, save() {} },
    transport: {
      async send(c) {
        commands.push(c);
        return c.command === "answer" ? stale : ready;
      },
    },
    render() {},
    makeSubmissionId: () => "id",
  });
  await ui.start();
  await ui.answer("e2e4");
  await assert.rejects(ui.abandon(), /refresh/);
  await assert.rejects(ui.abandon(), /refresh/);
  assert.equal(ui.getState().issue, "refresh");
  assert.equal(commands.length, 2);
  await ui.refresh();
  await ui.abandon();
  assert.equal(commands.at(-1).command, "abandon");
});
