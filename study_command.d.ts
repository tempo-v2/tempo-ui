/**
 * UI intents sent by StudyTransport. Copy server identities and revisions from
 * the latest ready view. Each new mutation gets one submission ID; retry reuses it.
 */
export interface AttemptCommandBase {
  readonly dataset_id: string;
  readonly attempt_id: string;
  readonly submission_id: string;
  readonly expected_revision: number;
}
export type StudyCommand =
  | { readonly command: "next" }
  | { readonly command: "resume_skipped" }
  | { readonly command: "resume"; readonly attempt_id: string }
  | (AttemptCommandBase & {
      readonly command: "answer" | "acknowledge";
      readonly answer: { readonly uci: string };
    })
  | (AttemptCommandBase & { readonly command: "abandon" | "skip" | "give_up" });
