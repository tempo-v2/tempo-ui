import { useRef, useState } from "react";
import { boundedRead } from "./bounded_read.js";
import { commandRecovery, postCommand } from "./content_transport.js";
import { validateStudyView } from "./validate_study_view.js";

const reviewMarkPath = "/api/study/review-mark";
export const savedReviewsPath = "/api/study/saved-reviews";

export const reviewMarkRecovery = commandRecovery("tempo-pending-review-mark");
export const reviewRemoveRecovery = commandRecovery("tempo-pending-review-remove");

class ReviewRejection extends Error {}

export async function readReviewCommand(path, command, owner) {
  const reply = await boundedRead(owner, (signal) => postCommand(path, command, signal));
  if (reply?.status === "error") {
    const error = validateStudyView(reply);
    if (!error.retryable) throw new ReviewRejection(error.message);
    throw new Error(error.message);
  }
  return reply;
}

export function useReviewWrite(path, recovery, expectedStatus, onAccepted) {
  const [pending, setPending] = useState(() => recovery.hasPending());
  const [message, setMessage] = useState(null);
  const flight = useRef(false);
  const [busy, setBusy] = useState(false);

  async function send(intent) {
    if (flight.current) return;
    flight.current = true;
    setBusy(true);
    setMessage(null);
    try {
      let command;
      if (intent) {
        command = { ...intent, submission_id: crypto.randomUUID() };
        await recovery.save(command);
        setPending(true);
      } else {
        command = await recovery.load();
      }
      if (!command) return;
      const reply = await readReviewCommand(path, command);
      if (reply?.status !== expectedStatus || reply.submission_id !== command.submission_id ||
          !Number.isSafeInteger(reply.id) || reply.id < 1 ||
          (command.id != null && command.id !== reply.id)) {
        throw new Error("Tempo could not verify the review reply.");
      }
      await recovery.save(null);
      setPending(false);
      onAccepted?.(reply);
      setMessage({ text: expectedStatus === "saved" ? "Saved for review." : "Removed from saved reviews." });
    } catch (error) {
      if (error instanceof ReviewRejection) {
        try {
          await recovery.save(null);
        } catch {
          setMessage({ text: "The review command was rejected. Its saved retry could not be cleared.", error: true });
          return;
        }
      }
      setPending(recovery.hasPending());
      setMessage({ text: error.message || "Could not update saved reviews.", error: true });
    } finally {
      setBusy(false);
      flight.current = false;
    }
  }

  return { pending, busy, message, send, retry: () => void send() };
}

function reviewAddress(view, position) {
  if (!view?.attempt_id) return null;
  const { dataset_id, attempt_id, content_version } = view;
  return { dataset_id, attempt_id, content_version, position };
}

export function completedReviewAddress(view) {
  return view?.status === "complete" ? reviewAddress(view, { kind: "completed_response" }) : null;
}

export function studyReviewAddresses(view, lastCompleted) {
  const current = view?.status === "ready" && view.prompt
    ? reviewAddress(view, { kind: "decision", index: view.prompt.decision_index })
    : completedReviewAddress(view);
  const justAnswered = view?.status === "ready" && view.feedback?.correct && view.prompt?.decision_index > 0;
  const previous = justAnswered
    ? reviewAddress(view, { kind: "decision", index: view.prompt.decision_index - 1 })
    : lastCompleted?.dataset_id === view?.dataset_id && lastCompleted?.attempt_id !== view?.attempt_id
      ? lastCompleted : null;
  return { current, previous };
}

export function useReviewMark() {
  return useReviewWrite(reviewMarkPath, reviewMarkRecovery, "saved");
}
