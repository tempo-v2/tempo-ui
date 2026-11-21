import React, { useCallback, useEffect, useState } from "react";
import { Button, Dialog, PageHeader, StatusNotice, Surface } from "@tempo-v2/core-components";
import { AnalysisPage } from "./AnalysisPage.jsx";
import { CARD_DISCLOSURE_RECHECK_MS } from "./card_details.js";
import { SavedReviewCardDetails } from "./StudyCardDetails.jsx";
import { validateAnalysisOrigin } from "./analysis_origin.js";
import {
  readReviewCommand,
  reviewExcludeRecovery,
  reviewRemoveRecovery,
  savedReviewsPath,
  useReviewWrite,
} from "./saved_review_commands.js";
import { signalStudyChange, studyChangeKey, studyChangeStamp } from "./study_presence.js";

const date = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function reviewPage(reply) {
  if (reply?.status !== "saved_reviews" || !Array.isArray(reply.rows) ||
      !reply.rows.every(row => Number.isSafeInteger(row?.id) && row.id > 0 &&
        (row.exercise_name === null || typeof row.exercise_name === "string") &&
        (row.can_remove_from_study === undefined || typeof row.can_remove_from_study === "boolean") &&
        (row.removed_from_study === undefined || typeof row.removed_from_study === "boolean") &&
        Number.isSafeInteger(row.decision_index) && row.decision_index >= 0 &&
        Number.isFinite(new Date(row.saved_at_ms).valueOf())) ||
      (reply.next !== null && reply.next !== reply.rows.at(-1)?.id)) {
    throw new Error("Tempo could not verify the saved reviews list.");
  }
  return reply;
}

export function SavedReviewsPage({ datasetId, onStudy, onTacticExcluded }) {
  const [cursors, setCursors] = useState([null]);
  const [result, setResult] = useState(null);
  const [selection, setSelection] = useState(null);
  const [opened, setOpened] = useState(null);
  const [openRetry, setOpenRetry] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [confirmation, setConfirmation] = useState(null);
  const exclude = useReviewWrite(savedReviewsPath, reviewExcludeRecovery, "excluded", () => {
    signalStudyChange();
    onTacticExcluded();
    setRefresh(number => number + 1);
  });
  const remove = useReviewWrite(savedReviewsPath, reviewRemoveRecovery, "removed", () => {
    setCursors([null]);
    setRefresh(number => number + 1);
  });

  useEffect(() => {
    const owner = new AbortController();
    setResult(null);
    readReviewCommand(savedReviewsPath, {
      command: "list", dataset_id: datasetId, before: cursors.at(-1),
    }, owner.signal).then(reviewPage).then(page => {
      if (!owner.signal.aborted) setResult({ page });
    }).catch(error => {
      if (!owner.signal.aborted) setResult({ error: error.message });
    });
    return () => owner.abort();
  }, [datasetId, cursors, refresh]);

  useEffect(() => {
    if (!selection) return;
    let request;
    let timer;
    let invalidated = false;
    function present(value) {
      setOpened(previous => ({
        selection, datasetId,
        origin: previous?.selection === selection && previous.datasetId === datasetId
          ? previous.origin : null,
        ...value,
      }));
    }
    function hidePosition() {
      if (invalidated) return;
      clearTimeout(timer);
      request?.abort();
      present({ state: "checking" });
    }
    async function verify(command) {
      if (invalidated) return;
      if (command === "open") hidePosition();
      if (document.hidden || !document.hasFocus()) return;
      const owner = new AbortController();
      request = owner;
      const stamp = studyChangeStamp();
      try {
        const reply = await readReviewCommand(savedReviewsPath, {
          command, dataset_id: datasetId, id: selection.id,
        }, owner.signal);
        if (owner.signal.aborted) return;
        if (studyChangeStamp() !== stamp) {
          invalidate();
          return;
        }
        if (reply?.id !== selection.id) throw new Error("Tempo could not verify the saved mark.");
        if (reply.status === "study_required") {
          present({ state: "waiting" });
          return;
        }
        if (command === "open" && reply.status === "review_context") {
          const origin = validateAnalysisOrigin(reply.origin, { dataset_id: datasetId });
          present({ state: "open", origin });
        } else if (command !== "check" || reply.status !== "review_available") {
          throw new Error("Tempo could not verify the saved position.");
        }
        timer = setTimeout(() => void verify("check"), CARD_DISCLOSURE_RECHECK_MS);
      } catch (error) {
        if (!owner.signal.aborted) present({ state: "error", error: error.message });
      }
    }
    function recheck() {
      void verify("open");
    }
    function invalidate() {
      invalidated = true;
      clearTimeout(timer);
      request?.abort();
      // A cross-tab request can still be in flight or may have lost its reply.
      // End this disclosure visit. A new, explicit Open gets current authority.
      present({ state: "invalidated" });
    }
    function onStudyChange(event) {
      if (event.key === studyChangeKey) invalidate();
    }
    recheck();
    window.addEventListener("storage", onStudyChange);
    window.addEventListener("pageshow", recheck);
    window.addEventListener("blur", hidePosition);
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      clearTimeout(timer);
      request?.abort();
      window.removeEventListener("storage", onStudyChange);
      window.removeEventListener("pageshow", recheck);
      window.removeEventListener("blur", hidePosition);
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, [datasetId, selection, openRetry]);

  function closePosition() {
    setSelection(null);
    setOpened(null);
    setRefresh(number => number + 1);
  }

  const current = opened?.selection === selection && opened.datasetId === datasetId ? opened : null;
  const retryOpening = useCallback(() => setOpenRetry(number => number + 1), []);
  const interruption = current?.state === "waiting" ? (
    <><StatusNotice>Finish in Study to open analysis.</StatusNotice>
      <Button onClick={retryOpening}>Check again</Button></>
  ) : current?.state === "invalidated" ? (
    <StatusNotice>Study changed in another tab. Return to saved reviews to open this position again.</StatusNotice>
  ) : current?.state === "error" ? (
    <><StatusNotice kind="error">{current.error}</StatusNotice>
      <Button onClick={retryOpening}>Retry opening position</Button></>
  ) : <p role="status">{current?.origin ? "Checking Study…" : "Opening position…"}</p>;
  if (current?.origin)
    return <AnalysisPage origin={current.origin} onClose={closePosition}
      interruption={current.state === "open" ? null : interruption}
      cardDetails={<SavedReviewCardDetails datasetId={datasetId} id={selection.id}
        onDisclosureChanged={retryOpening} />} />;
  return (
    <main className="tempo-core repertoire-page">
      <PageHeader title="Saved for review" actions={<Button disabled={exclude.busy} onClick={onStudy}>Back to Study</Button>} />
      {exclude.message && <StatusNotice kind="error">{exclude.message}</StatusNotice>}
      {exclude.pending && <Button disabled={exclude.busy} onClick={exclude.retry}>Retry removing from Study</Button>}
      {confirmation !== null && (
        <Dialog open title="Remove this tactic from Study?" onClose={() => setConfirmation(null)}>
          <p>Study will stop showing this tactic. Its saved mark, collection entry and learning history will stay available.</p>
          <div className="actions">
            <Button onClick={() => setConfirmation(null)}>Cancel</Button>
            <Button variant="primary" onClick={() => {
              const id = confirmation;
              setConfirmation(null);
              void exclude.send({ command: "exclude_tactic", dataset_id: datasetId, id });
            }}>Remove from Study</Button>
          </div>
        </Dialog>
      )}
      {remove.message && <StatusNotice kind="error">{remove.message}</StatusNotice>}
      {remove.pending && <Button disabled={remove.busy} onClick={remove.retry}>Retry removal</Button>}
      <Surface>
        {selection ? (
          <>
            <Button onClick={closePosition}>Back to saved reviews</Button>
            {interruption}
          </>
        ) : result?.error ? (
          <><StatusNotice kind="error">{result.error}</StatusNotice>
            <Button onClick={() => setRefresh(number => number + 1)}>Retry list</Button></>
        ) : !result ? <p role="status">Loading saved reviews…</p> : (
          <>
            {result.page.rows.length ? (
              <ul className="tactic-results">
                {result.page.rows.map(row => (
                  <li key={row.id}>
                    <span>{row.exercise_name || "Study card"} · Move {row.decision_index + 1} · {date.format(row.saved_at_ms)}</span>
                    <div className="actions">
                      <Button onClick={() => setSelection({ id: row.id })}>Open analysis</Button>
                      {row.removed_from_study && <span>Removed from Study</span>}
                      {row.can_remove_from_study && <Button disabled={exclude.pending || exclude.busy || remove.pending || remove.busy}
                        onClick={() => setConfirmation(row.id)}>Remove from Study</Button>}
                      <Button disabled={remove.pending || remove.busy || exclude.pending || exclude.busy}
                        onClick={() => void remove.send({ command: "remove", dataset_id: datasetId, id: row.id })}>
                        Remove saved mark
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : <p>No cards saved on this page.</p>}
            {(cursors.length > 1 || result.page.next !== null) && (
              <div className="actions">
                <Button disabled={cursors.length === 1} onClick={() => setCursors(cursors.slice(0, -1))}>Previous page</Button>
                <Button disabled={result.page.next === null} onClick={() => setCursors([...cursors, result.page.next])}>Next page</Button>
              </div>
            )}
          </>
        )}
      </Surface>
    </main>
  );
}
