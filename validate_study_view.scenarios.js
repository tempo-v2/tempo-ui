// Usage scenarios for src/validate_study_view.js, exercised through the public package barrel.
import assert from "node:assert/strict";
import test from "node:test";
import { validateStudyView } from "./index.js";
import { ready, complete } from "./view_fixtures.js";

test("external replies have a strict versioned schema and become immutable copies", () => {
  const original = ready();
  const view = validateStudyView(original);
  assert.deepEqual(view, original);
  assert.notEqual(view, original);
  assert.ok(Object.isFrozen(view.prompt));
  original.prompt.instruction = "changed elsewhere";
  assert.equal(view.prompt.instruction, "Find the move");
  assert.deepEqual(
    validateStudyView({
      schema_version: 4, status: "empty", dataset_id: "d", done: true,
      outstanding: 0, repertoire_remaining: 0, tactics_remaining: 20,
    }),
    {
      schema_version: 4,
      status: "empty",
      dataset_id: "d",
      done: true,
      outstanding: 0,
      repertoire_remaining: 0,
      tactics_remaining: 20,
    },
  );
  assert.equal(validateStudyView(complete()).status, "complete");
  assert.equal(
    validateStudyView(complete({ status: "abandoned", assessment: null }))
      .status,
    "abandoned",
  );
  assert.equal(
    validateStudyView({
      schema_version: 4,
      status: "error",
      code: "offline",
      message: "Retry",
      retryable: true,
    }).retryable,
    true,
  );
});

test("only teaching may include a lesson and it cannot emit a review grade", () => {
  const lesson = { move_uci: "e2e4", move_san: "e4", comments: ["Play the center."] };
  assert.deepEqual(validateStudyView(ready({ activity: "teach", lesson })).lesson, lesson);
  assert.throws(() => validateStudyView(ready({ lesson })), /teaching/);
  assert.throws(() => validateStudyView(ready({ activity: "teach", lesson, assessment: "good" })), /grade/);
});

test("malformed or unsupported replies are rejected, including extra solution fields", () => {
  const malformed = [
    null,
    [],
    {},
    ready({ schema_version: 1 }),
    ready({ schema_version: 2 }),
    ready({ status: "unknown" }),
    ready({ dataset_id: 1 }),
    ready({ revision: -1 }),
    ready({ revision: 0.5 }),
    ready({ content_version: 0 }),
    ready({ prompt: null }),
    ready({ prompt: { ...ready().prompt, decision_index: 2 } }),
    ready({ feedback: { correct: "true", message: "x", autoplay: [] } }),
    ready({ feedback: { correct: true, message: "x", autoplay: ["e7e5"] } }),
    ready({ assessment: "partial" }),
    ready({ solution: ["e2e4"] }),
    complete({ prompt: ready().prompt }),
    { schema_version: 4, status: "empty" },
    {
      schema_version: 4,
      status: "error",
      code: "bad",
      message: "x",
      retryable: "yes",
    },
  ];
  malformed.forEach((value) =>
    assert.throws(() => validateStudyView(value), TypeError),
  );
});

test("a correction belongs only to a legal wrong-answer reply", () => {
  const feedback = { correct: false, message: "Incorrect", autoplay: [], correction_uci: "e2e4" };
  const legal_moves = ["e2e4"];
  assert.equal(validateStudyView(ready({ feedback, legal_moves })).feedback.correction_uci, "e2e4");
  for (const invalid of [
    { correct: false, message: "Incorrect", autoplay: [] },
    { ...feedback, correct: true },
    { ...feedback, correction_uci: "a1h8" },
  ]) {
    assert.throws(() => validateStudyView(ready({ feedback: invalid, legal_moves })), TypeError);
  }
});
