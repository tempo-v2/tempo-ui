import { validateStudyView } from "./validate_study_view.js";
import { freeze, string } from "./wire_values.js";

// One atomic tab-scoped envelope. Storage throws if the write cannot be made.
export function createStudyController({
  transport,
  storage,
  render,
  makeSubmissionId,
}) {
  let view = null,
    busy = false,
    issue = null;
  let refreshRequired = false;
  let pending = null;
  let storageUnavailable = false;
  try {
    pending = storage.load()?.pending ?? null;
  } catch {
    storageUnavailable = true;
    issue =
      "Recovery storage is unavailable. Restore storage access and reload this page.";
  }
  const notify = () =>
    render(view, { busy, canRetry: !!pending && !busy, issue });
  async function send(command) {
    busy = true;
    pending = command;
    issue = null;
    notify();
    try {
      const response = validateStudyView(await transport.send(command));
      if (response.status === "error" && response.retryable) {
        issue = refreshRequired ? "refresh" : response.message;
        return response;
      }
      // Leave the original command in memory and storage if resolution cannot be saved.
      storage.save({ pending: null });
      pending = null;
      if (response.status === "error") {
        refreshRequired ||= [
          "stale_revision",
          "stale_content",
          "stale_dataset",
          "unknown_attempt",
        ].includes(response.code);
        issue = refreshRequired ? "refresh" : response.message;
      } else {
        view = response;
        refreshRequired = false;
        issue = null;
      }
      return response;
    } catch (error) {
      issue = refreshRequired
        ? "refresh"
        : error.message || "Delivery uncertain";
      throw error;
    } finally {
      busy = false;
      notify();
    }
  }
  async function deliver(command) {
    const reply = await send(command);
    if (command.command === "learn_more_tactics" && reply.status === "empty" && !reply.done)
      return begin(() => ({ command: "next" }));
    return reply;
  }
  function begin(build, durable = false) {
    if (busy) return Promise.resolve(null);
    if (storageUnavailable) {
      notify();
      return Promise.reject(new Error(issue));
    }
    if (pending)
      return Promise.reject(new Error("Retry the unresolved command first"));
    try {
      const command = freeze(build());
      if (durable) {
        storage.save({ pending: command });
        pending = command;
      }
      return deliver(command);
    } catch (error) {
      issue = refreshRequired ? "refresh" : error.message;
      notify();
      return Promise.reject(error);
    }
  }
  function attemptCommand(command) {
    if (refreshRequired || view?.status !== "ready")
      throw new Error("This action requires a ready exercise or refresh");
    return {
      command,
      dataset_id: view.dataset_id,
      attempt_id: view.attempt_id,
      submission_id: string(makeSubmissionId(), "submission_id", true),
      expected_revision: view.revision,
    };
  }
  return Object.freeze({
    getState: () => ({ view, busy, canRetry: !!pending && !busy, issue }),
    start: () => {
      if (busy) return Promise.resolve(null);
      if (storageUnavailable) {
        notify();
        return Promise.reject(new Error(issue));
      }
      return pending ? deliver(pending) : begin(() => ({ command: "next" }));
    },
    next: () => begin(() => ({ command: "next" })),
    resume: (attemptId) =>
      begin(() => ({
        command: "resume",
        attempt_id: string(attemptId, "attempt_id", true),
      })),
    refresh: () => begin(() => ({ command: "next" })),
    answer: (uci) =>
      begin(
        () => ({
          ...attemptCommand("answer"),
          answer: { uci: string(uci, "answer.uci", true) },
        }),
        true,
      ),
    acknowledge: (uci) =>
      begin(() => {
        if (view?.activity !== "teach" || view.lesson?.move_uci !== uci)
          throw new Error("Reproduce the prescribed move before acknowledging the lesson");
        return { ...attemptCommand("acknowledge"), answer: { uci } };
      }, true),
    giveUp: () => begin(() => attemptCommand("give_up"), true),
    skip: () => begin(() => attemptCommand("skip"), true),
    resumeSkipped: () => begin(() => ({ command: "resume_skipped" })),
    studyStatus: () => begin(() => ({ command: "study_status" })),
    practiceTactics: () => begin(() => ({ command: "practice_tactics" })),
    learnMoreTactics: () => begin(() => {
      if (view?.status !== "empty" || !view.done || !view.can_learn_more_tactics)
        throw new Error("Complete the required study before increasing today's tactics allowance");
      return {
        command: "learn_more_tactics",
        dataset_id: view.dataset_id,
        submission_id: string(makeSubmissionId(), "submission_id", true),
      };
    }, true),
    abandon: () => begin(() => attemptCommand("abandon"), true),
    retry: () =>
      busy
        ? Promise.resolve(null)
        : pending
          ? deliver(pending)
          : Promise.reject(
              new Error("There is no unresolved command to retry"),
            ),
  });
}
