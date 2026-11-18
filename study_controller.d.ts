import type { StudyView } from "./study_view.js";
import type { StudyCommand } from "./study_command.js";

export type MutationCommand = Extract<
  StudyCommand,
  { command: "answer" | "abandon" | "acknowledge" | "skip" | "give_up" | "learn_more_tactics" }
>;
export interface RecoveryEnvelope {
  readonly pending: MutationCommand | null;
}
export interface RecoveryStorage {
  load(): RecoveryEnvelope | null;
  save(envelope: RecoveryEnvelope): void;
}
export interface RenderState {
  readonly busy: boolean;
  readonly canRetry: boolean;
  readonly issue: string | null;
}
export interface ControllerState extends RenderState {
  readonly view: StudyView | null;
}
export interface StudyTransport {
  send(command: StudyCommand): Promise<unknown>;
}
export interface StudyController {
  getState(): ControllerState;
  start(): Promise<StudyView | null>;
  next(): Promise<StudyView | null>;
  resume(attemptId: string): Promise<StudyView | null>;
  refresh(): Promise<StudyView | null>;
  answer(uci: string): Promise<StudyView | null>;
  acknowledge(uci: string): Promise<StudyView | null>;
  skip(): Promise<StudyView | null>;
  giveUp(): Promise<StudyView | null>;
  resumeSkipped(): Promise<StudyView | null>;
  studyStatus(): Promise<StudyView | null>;
  practiceTactics(): Promise<StudyView | null>;
  learnMoreTactics(): Promise<StudyView | null>;
  abandon(): Promise<StudyView | null>;
  retry(): Promise<StudyView | null>;
}
export function createStudyController(options: {
  transport: StudyTransport;
  storage: RecoveryStorage;
  render(view: StudyView | null, state: RenderState): void;
  makeSubmissionId(): string;
}): StudyController;
