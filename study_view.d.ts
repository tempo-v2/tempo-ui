/** Whole-attempt result supplied by the application; never computed by the UI. */
export type Assessment = "good" | "again" | null;
export type Activity = "teach" | "test" | "practice";
export interface Lesson {
  readonly move_uci: string;
  readonly move_san: string;
  readonly comments: readonly string[];
  readonly previous_move?: string;
}
/** The displayed learner decision, with no expected move or answer key. */
export interface Prompt {
  readonly fen: string;
  readonly instruction: string;
  readonly decision_index: number;
  readonly decision_count: number;
}
interface TacticPiece {
  readonly square: string;
  readonly role: "pawn" | "knight" | "bishop" | "rook" | "queen" | "king";
  readonly color: "white" | "black";
}
type TacticRay = {
  readonly attacker: TacticPiece;
  readonly front: TacticPiece;
  readonly rear: TacticPiece;
};
export type TacticExplanation =
  | (TacticRay & { readonly kind: "pin" | "skewer" })
  | (TacticRay & { readonly kind: "pin_capture"; readonly captured: TacticPiece })
  | { readonly kind: "fork"; readonly attacker: TacticPiece; readonly targets: readonly [TacticPiece, TacticPiece] }
  | { readonly kind: "discovered_attack" | "discovered_check"; readonly attacker: TacticPiece; readonly target: TacticPiece }
  | { readonly kind: "hanging_piece"; readonly captured: TacticPiece }
  | { readonly kind: "mating_line" }
  | { readonly kind: "mate_in_one"; readonly king: TacticPiece; readonly checkers: readonly TacticPiece[] };
/** Feedback and automatic replies produced by the server-side grader. */
export type Feedback = {
  readonly message: string;
  readonly autoplay: readonly { readonly uci: string }[];
} & (
  | { readonly correct: true }
  | {
      readonly correct: false;
      readonly correction_uci: string;
      readonly correction_san?: string;
      readonly tactic_explanation?: TacticExplanation;
    }
);
/** Server identities copied into later answer/abandon commands. */
export interface RevealedLine {
  readonly start_fen: string;
  readonly moves: readonly { readonly notation: string; readonly fen: string }[];
}
export interface AttemptViewBase {
  readonly schema_version: 5;
  readonly display_fen: string;
  readonly learner_color: "white" | "black";
  readonly legal_moves: readonly string[];
  readonly in_check: boolean;
  readonly dataset_id: string;
  readonly attempt_id: string;
  readonly target_id: string;
  readonly content_version: number;
  readonly revision: number;
  readonly feedback: Feedback | null;
  readonly assessment: Assessment;
  readonly activity: Activity;
  readonly corrective_repair?: boolean;
  /** Optional public display text for any kind of exercise. */
  readonly exercise_name?: string;
  readonly history?: RevealedLine;
  readonly opponent_move?: { readonly uci: string; readonly before_fen?: string };
  readonly repertoire_context?: "warmup";
}
/** Use the prompt to render the current decision and accept a user move. */
export interface ReadyView extends AttemptViewBase {
  readonly status: "ready";
  readonly prompt: Prompt;
  readonly lesson?: Lesson;
}
/** No further answer is accepted through this displayed attempt. */
export interface FinishedView extends AttemptViewBase {
  readonly status: "complete" | "abandoned";
  readonly prompt: null;
}
/** Nothing eligible now; Next can be requested again after conditions change. */
export interface EmptyView {
  readonly schema_version: 5;
  readonly status: "empty";
  readonly dataset_id: string;
  readonly done: boolean;
  readonly corrective_recalls_remaining?: number;
  readonly outstanding: number;
  readonly repertoire_remaining: number;
  readonly tactics_remaining: number;
  readonly can_practice_tactics?: boolean;
  readonly can_learn_more_tactics?: boolean;
  readonly learn_more_count?: number;
}
/** Whether to retain a command for retry is supplied by the application. */
export interface ErrorView {
  readonly schema_version: 5;
  readonly status: "error";
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}
/** Branch on status when consuming the validated application reply. */
export type StudyView = ReadyView | FinishedView | EmptyView | ErrorView;
