import React, { useEffect, useState } from "react";
import { Button, PageHeader, StatusNotice, Surface } from "@tempo-v2/core-components";
import { AnalysisPage } from "./AnalysisPage.jsx";
import { validateAnalysisOrigin } from "./analysis_origin.js";
import {
  readReviewCommand,
  reviewRemoveRecovery,
  savedReviewsPath,
  useReviewWrite,
} from "./saved_review_commands.js";
import { studyChangeStamp } from "./study_presence.js";

const date = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function reviewPage(reply) {
  if (reply?.status !== "saved_reviews" || !Array.isArray(reply.rows) ||
      !reply.rows.every(row => Number.isSafeInteger(row?.id) && row.id > 0 &&
        (row.exercise_name === null || typeof row.exercise_name === "string") &&
        Number.isSafeInteger(row.decision_index) && row.decision_index >= 0 &&
        Number.isFinite(new Date(row.saved_at_ms).valueOf())) ||
      (reply.next !== null && reply.next !== reply.rows.at(-1)?.id)) {
    throw new Error("Tempo could not verify the saved reviews list.");
  }
  return reply;
}

export function SavedReviewsPage({ datasetId, onStudy }) {
  const [cursors, setCursors] = useState([null]);
  const [result, setResult] = useState(null);
  const [selection, setSelection] = useState(null);
  const [opened, setOpened] = useState(null);
  const [refresh, setRefresh] = useState(0);
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
    const owner = new AbortController();
    const stamp = studyChangeStamp();
    readReviewCommand(savedReviewsPath, {
      command: "open", dataset_id: datasetId, id: selection.id,
    }, owner.signal).then(reply => {
      if (owner.signal.aborted) return;
      if (reply?.id !== selection.id) throw new Error("Tempo could not verify the saved mark.");
      if (reply.status === "study_required") setOpened({ selection, waiting: true });
      else if (reply.status === "review_context") {
        if (studyChangeStamp() !== stamp)
          throw new Error("Study changed while opening this position. Try again.");
        const origin = validateAnalysisOrigin(reply.origin, { dataset_id: datasetId });
        setOpened({ selection, origin });
      } else throw new Error("Tempo could not open the saved position.");
    }).catch(error => {
      if (!owner.signal.aborted) setOpened({ selection, error: error.message });
    });
    return () => owner.abort();
  }, [datasetId, selection]);

  function closePosition() {
    setSelection(null);
    setOpened(null);
    setRefresh(number => number + 1);
  }

  const current = opened?.selection === selection ? opened : null;
  if (current?.origin) return <AnalysisPage origin={current.origin} onClose={closePosition} />;
  return (
    <main className="tempo-core repertoire-page">
      <PageHeader title="Saved for review" actions={<Button onClick={onStudy}>Back to Study</Button>} />
      {remove.message && <StatusNotice kind={remove.message.error ? "error" : undefined}>{remove.message.text}</StatusNotice>}
      {remove.pending && <Button disabled={remove.busy} onClick={remove.retry}>Retry removal</Button>}
      <Surface>
        {selection ? (
          <>
            <Button onClick={closePosition}>Back to saved reviews</Button>
            {current?.waiting ? <StatusNotice>Finish in Study to open analysis.</StatusNotice>
              : current?.error ? (
                <><StatusNotice kind="error">{current.error}</StatusNotice>
                  <Button onClick={() => setSelection({ id: selection.id })}>Retry opening position</Button></>
              ) : <p role="status">Opening position…</p>}
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
                      <Button disabled={remove.pending || remove.busy}
                        onClick={() => void remove.send({ command: "remove", dataset_id: datasetId, id: row.id })}>Remove</Button>
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
