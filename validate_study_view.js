/** Validate version 5 replies without making grading or scheduling decisions. */
import { boolean, freeze, object, string, validateErrorView } from "./wire_values.js";

const ASSESSMENTS = new Set([null, "good", "again"]);
const ATTEMPT_STATUSES = new Set(["ready", "complete", "abandoned"]);
const ACTIVITIES = new Set(["teach", "test", "practice"]);
export const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

function integer(value, minimum, name) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be a safe integer >= ${minimum}`);
  }
  return value;
}

export function validateRevealedLine(line) {
  object(line, ["start_fen", "moves"], "revealed history");
  if (!Array.isArray(line.moves) || !line.moves.length)
    throw new TypeError("Expected a played move in history");
  return {
    start_fen: string(line.start_fen, "start position", true),
    moves: line.moves.map((move) => {
      object(move, ["notation", "fen"], "revealed move");
      return {
        notation: string(move.notation, "move notation", true),
        fen: string(move.fen, "revealed position", true),
      };
    }),
  };
}

/**
 * Use at the transport boundary before trusting a response as a Study view.
 * The server produces the wire value; rendering/controller code consumes the
 * immutable copy. Unknown fields (including accidental answer keys) are rejected.
 *
 * @example
 * const view = validateStudyView(JSON.parse(responseText));
 * // view.status selects the attempt, empty, or error presentation.
 */
export function validateStudyView(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    value.schema_version !== 5
  ) {
    throw new TypeError("Expected a Study wire view with schema_version 5");
  }
  if (value.status === "empty") {
    const optionalFlags = ["can_practice_tactics", "can_learn_more_tactics"];
    const optionalFields = [...optionalFlags, "learn_more_count", "corrective_recalls_remaining"]
      .filter((key) => Object.hasOwn(value, key));
    object(value, [
      "schema_version", "status", "dataset_id",
      "done", "outstanding", "repertoire_remaining", "tactics_remaining",
      ...optionalFields,
    ], "empty view");
    const done = boolean(value.done, "done");
    const outstanding = integer(value.outstanding, 0, "outstanding");
    if (done && outstanding) throw new TypeError("Done conflicts with outstanding work");
    return freeze({
      schema_version: 5,
      status: "empty",
      dataset_id: string(value.dataset_id, "dataset_id", true),
      done,
      outstanding,
      repertoire_remaining: integer(value.repertoire_remaining, 0, "repertoire_remaining"),
      tactics_remaining: integer(value.tactics_remaining, 0, "tactics_remaining"),
      ...Object.fromEntries(optionalFields.map((key) => [
        key,
        optionalFlags.includes(key) ? boolean(value[key], key) : integer(value[key], 0, key),
      ])),
    });
  }
  if (value.status === "error") return validateErrorView(value);
  if (!ATTEMPT_STATUSES.has(value.status))
    throw new TypeError("Unknown Study view status");
  object(
    value,
    [
      "schema_version",
      "status",
      "dataset_id",
      "attempt_id",
      "target_id",
      "content_version",
      "revision",
      "prompt",
      "feedback",
      "assessment",
      "display_fen",
      "learner_color",
      "legal_moves",
      "in_check",
      "activity",
      ...["lesson", "exercise_name", "history", "corrective_repair"].filter((key) => Object.hasOwn(value, key)),
    ],
    "attempt view",
  );
  if (!ASSESSMENTS.has(value.assessment))
    throw new TypeError("Invalid assessment");
  if (!ACTIVITIES.has(value.activity)) throw new TypeError("Unknown activity");
  if (value.activity === "teach" && value.assessment !== null)
    throw new TypeError("Teaching cannot carry a recall grade");
  if ((value.activity === "teach" && value.status === "ready") !== Object.hasOwn(value, "lesson"))
    throw new TypeError("Only a ready teaching activity may contain a lesson, and it must contain one");

  let prompt = null;
  if (value.prompt !== null) {
    object(
      value.prompt,
      ["fen", "instruction", "decision_index", "decision_count"],
      "prompt",
    );
    const index = integer(value.prompt.decision_index, 0, "decision_index");
    const count = integer(value.prompt.decision_count, 1, "decision_count");
    if (index >= count)
      throw new TypeError("decision_index must be less than decision_count");
    prompt = {
      fen: string(value.prompt.fen, "fen", true),
      instruction: string(value.prompt.instruction, "instruction"),
      decision_index: index,
      decision_count: count,
    };
  }
  if ((value.status === "ready") !== (prompt !== null)) {
    throw new TypeError(
      "Only a ready view may contain a prompt, and it must contain one",
    );
  }
  if (
    !Array.isArray(value.legal_moves) ||
    value.legal_moves.some((move) => typeof move !== "string" || !UCI.test(move))
  )
    throw new TypeError("Invalid legal moves");
  if (value.status !== "ready" && value.legal_moves.length)
    throw new TypeError("Terminal legal moves must be empty");

  const context = {};
  if (Object.hasOwn(value, "corrective_repair")) {
    if (value.activity !== "teach") throw new TypeError("A corrective repair must be guided");
    context.corrective_repair = boolean(value.corrective_repair, "corrective_repair");
  }
  if (Object.hasOwn(value, "history")) context.history = validateRevealedLine(value.history);
  if (Object.hasOwn(value, "exercise_name"))
    context.exercise_name = string(value.exercise_name, "exercise_name", true);
  if (value.lesson) {
    const lesson = value.lesson;
    const keys = ["move_uci", "move_san", "comments"];
    if (Object.hasOwn(lesson, "previous_move")) keys.push("previous_move");
    object(lesson, keys, "lesson");
    if (!value.legal_moves.includes(lesson.move_uci) || !Array.isArray(lesson.comments))
      throw new TypeError("Invalid lesson move or comments");
    context.lesson = {
      move_uci: lesson.move_uci,
      move_san: string(lesson.move_san, "lesson.move_san", true),
      comments: lesson.comments.map((comment) => string(comment, "lesson comment")),
    };
    if (Object.hasOwn(lesson, "previous_move")) {
      if (typeof lesson.previous_move !== "string" || !UCI.test(lesson.previous_move))
        throw new TypeError("Invalid previous move");
      context.lesson.previous_move = lesson.previous_move;
    }
  } else if (Object.hasOwn(value, "lesson")) {
    throw new TypeError("Invalid lesson");
  }

  let feedback = null;
  if (value.feedback !== null) {
    const correct = value.feedback?.correct;
    const keys = ["correct", "message", "autoplay"];
    if (correct === false) {
      keys.push("correction_uci");
      if (Object.hasOwn(value.feedback, "correction_san")) keys.push("correction_san");
    }
    object(value.feedback, keys, "feedback");
    if (!Array.isArray(value.feedback.autoplay))
      throw new TypeError("autoplay must be an array");
    feedback = {
      correct: boolean(value.feedback.correct, "feedback.correct"),
      message: string(value.feedback.message, "feedback.message"),
      autoplay: value.feedback.autoplay.map((move) => {
        object(move, ["uci"], "autoplay move");
        return { uci: string(move.uci, "autoplay.uci", true) };
      }),
    };
    if (!feedback.correct) {
      const correction = value.feedback.correction_uci;
      if (value.status !== "ready" || feedback.autoplay.length ||
          typeof correction !== "string" || !UCI.test(correction) ||
          !value.legal_moves.includes(correction))
        throw new TypeError("Invalid correction move");
      feedback.correction_uci = correction;
      if (Object.hasOwn(value.feedback, "correction_san"))
        feedback.correction_san = string(value.feedback.correction_san, "correction SAN", true);
    }
  }
  if (!["white", "black"].includes(value.learner_color))
    throw new TypeError("Invalid learner color");
  if (prompt && prompt.fen !== value.display_fen)
    throw new TypeError("Prompt and display FEN differ");
  return freeze({
    schema_version: 5,
    activity: value.activity,
    ...context,
    display_fen: string(value.display_fen, "display_fen", true),
    learner_color: value.learner_color,
    legal_moves: [...value.legal_moves],
    in_check: boolean(value.in_check, "in_check"),
    status: value.status,
    dataset_id: string(value.dataset_id, "dataset_id", true),
    attempt_id: string(value.attempt_id, "attempt_id", true),
    target_id: string(value.target_id, "target_id", true),
    content_version: integer(value.content_version, 1, "content_version"),
    revision: integer(value.revision, 0, "revision"),
    prompt,
    feedback,
    assessment: value.assessment,
  });
}
