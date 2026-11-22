import { validateStudyView } from "./validate_study_view.js";
import { freeze, string } from "./wire_values.js";

function recoveryResult(view) {
  if (!view.feedback?.tactic_explanation) return view;
  const { tactic_explanation, ...feedback } = view.feedback;
  return { ...view, feedback };
}

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
  let analysisVisit = null;
  const envelope = (command, visit) => visit ? { pending: command, analysis: visit } : { pending: command };
  let storageUnavailable = false;
  try {
    const saved = storage.load();
    pending = saved?.pending ?? null;
    analysisVisit = saved?.analysis ?? null;
    if (analysisVisit?.savedResult) view = validateStudyView(analysisVisit.savedResult);
  } catch {
    storageUnavailable = true;
    issue =
      "Recovery storage is unavailable. Restore storage access and reload this page.";
  }
  const renderState = () => ({
    busy,
    canRetry: !!pending && !busy,
    analysis: !pending && analysisVisit?.phase === "open" ? analysisVisit : null,
    retryingNext: pending?.command === "next",
    refreshRequired,
    storageUnavailable,
    issue,
  });
  const notify = () => render(view, renderState());
  async function send(command) {
    busy = true;
    pending = command;
    issue = null;
    notify();
    try {
      const response = validateStudyView(await transport.send(command));
      if (response.status === "error" && response.retryable) {
        issue = response.message;
        return response;
      }
      // Leave the original command in memory and storage if resolution cannot be saved.
      let nextVisit = analysisVisit;
      if (analysisVisit?.phase === "accept" && command.submission_id === analysisVisit.submission_id) {
        if (response.status === "error") nextVisit = null;
        else {
          const expected = command.command === "concede" ? "abandoned" : "ready";
          if (response.status !== expected || response.assessment !== "again" ||
              response.attempt_id !== analysisVisit.attempt_id || response.dataset_id !== analysisVisit.dataset_id ||
              response.content_version !== analysisVisit.content_version || response.revision !== command.expected_revision + 1)
            throw new Error("The Study reply does not confirm this analysis request.");
          nextVisit = { ...analysisVisit, revision: response.revision, phase: "open", savedResult: recoveryResult(response) };
        }
      }
      if (analysisVisit?.phase === "return") {
        const unavailable = command.command === "resume" && (response.status === "error"
          ? ["stale_content", "stale_dataset", "stale_activity", "retired_activity", "suspended_repertoire", "unknown_attempt"].includes(response.code)
          : response.status !== "ready" || response.dataset_id !== analysisVisit.dataset_id ||
            response.attempt_id !== analysisVisit.attempt_id || response.content_version !== analysisVisit.content_version);
        nextVisit = unavailable ? { ...analysisVisit, returnTo: "next" } : null;
      }
      storage.save(envelope(null, nextVisit));
      analysisVisit = nextVisit;
      pending = null;
      // Resume can find a finished attempt or an ID in a restored dataset. Keep
      // the original Study result visible while the authoritative Next is loaded.
      if (nextVisit?.phase === "return") return response;
      if (response.status === "error") {
        refreshRequired ||= [
          "stale_revision",
          "stale_content",
          "stale_dataset",
          "stale_activity",
          "retired_activity",
          "suspended_repertoire",
          "unknown_attempt",
        ].includes(response.code);
        issue = response.message;
      } else {
        view = response;
        refreshRequired = false;
        issue = null;
      }
      return response;
    } catch (error) {
      issue = error.message || "Delivery uncertain";
      throw error;
    } finally {
      busy = false;
      notify();
    }
  }
  async function deliver(command) {
    const reply = await send(command);
    if (command.command === "resume" && analysisVisit?.phase === "return" &&
        analysisVisit.returnTo === "next")
      return begin(() => ({ command: "next" }));
    if (
      (command.command === "acknowledge" && reply.status === "complete" && reply.activity === "teach") ||
      (command.command === "learn_more_tactics" && reply.status === "empty" && !reply.done)
    ) {
      // Keep the accepted result even if acquiring the next exercise fails.
      await begin(() => ({ command: "next" })).catch(() => {});
      return reply;
    }
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
        storage.save(envelope(command, analysisVisit));
        pending = command;
      }
      return deliver(command);
    } catch (error) {
      issue = error.message;
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
  async function visitAnalysis(address, entry) {
    if (busy || pending || refreshRequired || storageUnavailable || !view?.attempt_id || analysisVisit) return null;
    if (address.dataset_id !== view.dataset_id || address.attempt_id !== view.attempt_id ||
        address.content_version !== view.content_version || address.revision !== view.revision) return null;
    const active = view.status === "ready";
    const scheduledReview = active && view.activity === "test";
    // Only the confirmation for this displayed revision authorizes a human Again.
    if (scheduledReview !== (entry === "concede")) return null;
    const action = scheduledReview ? "concede" :
      active && view.activity === "practice" && view.assessment === null ? "give_up" : null;
    const visit = {
      dataset_id: view.dataset_id, attempt_id: view.attempt_id, content_version: view.content_version,
      revision: view.revision, returnTo: active && action !== "concede" ? "resume" : "next",
    };
    try {
      if (action) {
        const command = freeze(attemptCommand(action));
        const original = { ...visit, phase: "accept", submission_id: command.submission_id };
        storage.save(envelope(command, original));
        analysisVisit = original;
        pending = command;
        return await deliver(command);
      }
      const open = { ...visit, phase: "open", savedResult: recoveryResult(view) };
      storage.save(envelope(null, open));
      analysisVisit = open;
      notify();
    } catch (error) {
      issue = error.message || "Could not open analysis.";
      notify();
      throw error;
    }
    return null;
  }
  function finishReturn(visit) {
    return visit.returnTo === "resume"
      ? begin(() => ({ command: "resume", attempt_id: visit.attempt_id }))
      : begin(() => ({ command: "next" }));
  }
  async function closeAnalysis() {
    if (!analysisVisit || pending || busy) return null;
    const returning = { ...analysisVisit, phase: "return" };
    try {
      storage.save(envelope(null, returning));
    } catch (error) {
      issue = error.message || "Could not close analysis.";
      notify();
      throw error;
    }
    analysisVisit = returning;
    return finishReturn(returning);
  }
  return Object.freeze({
    openAnalysis: address => visitAnalysis(address, "open"),
    concedeForAnalysis: confirmedAddress => visitAnalysis(confirmedAddress, "concede"),
    closeAnalysis,
    getState: () => ({ view, ...renderState() }),
    start: () => {
      if (busy) return Promise.resolve(null);
      if (storageUnavailable) {
        notify();
        return Promise.reject(new Error(issue));
      }
      if (pending) return deliver(pending);
      if (analysisVisit?.phase === "return") return finishReturn(analysisVisit);
      if (analysisVisit) { notify(); return Promise.resolve(null); }
      return begin(() => ({ command: "next" }));
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
