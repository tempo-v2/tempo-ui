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
      schema_version: 5, status: "empty", dataset_id: "d", done: true,
      outstanding: 0, repertoire_remaining: 0, tactics_remaining: 20,
    }),
    {
      schema_version: 5,
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
      schema_version: 5,
      status: "error",
      code: "offline",
      message: "Retry",
      retryable: true,
    }).retryable,
    true,
  );
});

test("any exercise can have a display name", () => {
  for (const activity of ["test", "practice"]) {
    const view = ready({ activity, exercise_name: "A named exercise" });
    assert.equal(validateStudyView(view).exercise_name, "A named exercise");
  }
  assert.equal(validateStudyView(ready()).exercise_name, undefined);
  assert.throws(() => validateStudyView(ready({ exercise_name: "" })), TypeError);
  assert.throws(() => validateStudyView(ready({ repertoire_name: "Old name" })), TypeError);
});

test("a warm-up presentation requires an issued Practice", () => {
  assert.equal(validateStudyView(ready({ activity: "practice", repertoire_context: "warmup" })).repertoire_context, "warmup");
  assert.throws(() => validateStudyView(ready({ repertoire_context: "warmup" })), /warm-up/);
  assert.throws(() => validateStudyView(ready({ activity: "practice", repertoire_context: "future" })), /warm-up/);
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
    { schema_version: 5, status: "empty" },
    {
      schema_version: 5,
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

test("an optional opponent lead-in belongs only to an unplayed first decision", () => {
  const opponent_move = { before_fen: "8/8/8/8/8/8/8/8 b - - 0 1", uci: "e7e5" };
  assert.deepEqual(validateStudyView(ready({ opponent_move })).opponent_move, opponent_move);
  assert.throws(() => validateStudyView(ready({ revision: 1, opponent_move })), /opponent/);
  const earlierMove = { uci: opponent_move.uci };
  assert.deepEqual(validateStudyView(ready({ revision: 1, opponent_move: earlierMove })).opponent_move, earlierMove);
  assert.throws(() => validateStudyView(ready({ learner_color: "black", opponent_move })), /opponent/);
  assert.throws(() => validateStudyView(ready({
    opponent_move: { ...opponent_move, answer: "e2e4" },
  })), /opponent/);
});
