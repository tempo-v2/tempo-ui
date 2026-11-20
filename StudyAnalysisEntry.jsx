import React, { useEffect, useState } from "react";
import { Button, StatusNotice } from "@tempo-v2/core-components";
import { AnalysisPage } from "./AnalysisPage.jsx";
import { useStudyLineExport } from "./StudyLineExport.jsx";
import { postCommand } from "./content_transport.js";
import { UCI } from "./validate_study_view.js";

// Mount the analysis board only after the server discloses the addressed decision.
// Retries here are reads, including after a recovered review concession.
export function StudyAnalysisEntry({ visit, issue, launch, onClose }) {
  const [result, setResult] = useState(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const owner = new AbortController();
    const { dataset_id, attempt_id, revision, content_version } = visit;
    const address = { dataset_id, attempt_id, revision, content_version };
    async function read() {
      try {
        const origin = await postCommand("/api/study/analysis-context", address,
          AbortSignal.any([owner.signal, AbortSignal.timeout(10000)]));
        if (origin.attemptId !== attempt_id || origin.datasetId !== dataset_id ||
            origin.contentVersion !== content_version || origin.revision !== revision ||
            typeof origin.fen !== "string" || !["white", "black"].includes(origin.color) ||
            (origin.repertoireId !== null && typeof origin.repertoireId !== "string") ||
            (origin.name !== null && typeof origin.name !== "string") ||
            (origin.playedUci !== null && !UCI.test(origin.playedUci)) || !UCI.test(origin.prescribedUci))
          throw new Error("Tempo could not verify this Study position.");
        if (!owner.signal.aborted) setResult({ visit, retry, origin });
      } catch (error) {
        if (!owner.signal.aborted) setResult({ visit, retry, error: error.message });
      }
    }
    void read();
    return () => owner.abort();
  }, [visit, retry]);
  const current = result?.visit === visit && result.retry === retry ? result : null;
  const renderRootLineAction = useStudyLineExport(visit, current?.origin, launch);
  if (current?.origin && !issue) return <AnalysisPage origin={current.origin} onClose={onClose}
    renderRootLineAction={renderRootLineAction} />;
  return <main className="tempo-core">
    <h1>Position analysis</h1>
    {issue || current?.error ? <StatusNotice kind="error">{issue || current.error}</StatusNotice>
      : <p role="status">Opening the Study position…</p>}
    {current?.error && <Button onClick={() => setRetry(value => value + 1)}>Retry opening position</Button>}
    <Button onClick={onClose}>Back to Study</Button>
  </main>;
}
