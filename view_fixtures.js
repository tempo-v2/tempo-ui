/** Wire-only examples: no grader, scheduler, or backend imports. */
export const ready = (changes = {}) => ({
  schema_version: 4,
  status: "ready",
  activity: "test",
  dataset_id: "dataset-1",
  attempt_id: "attempt-1",
  target_id: "tactic-1",
  content_version: 1,
  revision: 0,
  prompt: {
    fen: "fixture FEN",
    instruction: "Find the move",
    decision_index: 0,
    decision_count: 2,
  },
  feedback: null,
  assessment: null,
  display_fen: "fixture FEN",
  learner_color: "white",
  legal_moves: ["e2e4"],
  in_check: false,
  ...changes,
});
export const complete = (changes = {}) =>
  ready({
    status: "complete",
    prompt: null,
    assessment: "good",
    legal_moves: [],
    ...changes,
  });
