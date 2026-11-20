import React, { useEffect, useRef, useState } from "react";
import { LichessControl } from "./LichessControl.jsx";
import { postCommand } from "./content_transport.js";
import {
  closeReservedLichessTab, lichessAnalysis, navigateReservedLichessTab, reserveLichessTab,
} from "./lichess_analysis.js";
import { validateRevealedLine } from "./validate_study_view.js";

const ANALYSIS_LINE_TIMEOUT_MS = 10_000;

// The authorized position opens first. Only an explicit Lichess action reads the
// line. Its delivery and retry belong to this visit, independent of Study recovery.
export function useStudyLineExport(visit, origin, launch, positionFailed) {
  const [request, setRequest] = useState(null);
  const [result, setResult] = useState(null);
  const consumedLaunch = useRef(null);
  useEffect(() => () => closeReservedLichessTab(launch?.tab), [launch]);
  useEffect(() => {
    if (!launch || consumedLaunch.current === launch) return;
    if (!origin && !positionFailed) return;
    consumedLaunch.current = launch;
    if (positionFailed) closeReservedLichessTab(launch.tab);
    else setRequest(launch);
  }, [origin, launch, positionFailed]);
  useEffect(() => {
    if (request?.visit !== visit) return;
    const owner = new AbortController();
    const { dataset_id, attempt_id, revision, content_version } = visit;
    async function read() {
      try {
        const reply = await postCommand("/api/study/analysis-line",
          { dataset_id, attempt_id, revision, content_version },
          owner.signal, undefined, { timeoutMs: ANALYSIS_LINE_TIMEOUT_MS });
        if (owner.signal.aborted) return;
        if (!["full_line", "issued_move"].includes(reply.scope))
          throw new Error("Tempo could not verify the analysis line.");
        const line = validateRevealedLine(reply.line);
        const destination = lichessAnalysis(line.start_fen, line, request.orientation);
        if (reply.scope === "full_line" && !destination.downloadPgn)
          navigateReservedLichessTab(request.tab, destination.href);
        else closeReservedLichessTab(request.tab);
        setResult({ request, line, scope: reply.scope });
      } catch {
        if (owner.signal.aborted) return;
        closeReservedLichessTab(request.tab);
        setResult({ request, failed: true });
      }
    }
    void read();
    return () => {
      owner.abort();
      closeReservedLichessTab(request.tab);
    };
  }, [request, visit]);

  return (fen, orientation) => {
    const current = result?.request === request && request?.visit === visit ? result : null;
    if (current?.line) return <LichessControl fen={fen} line={current.line}
      scope={current.scope} orientation={orientation} />;
    const loading = request?.visit === visit && !current;
    return <>
      <LichessControl disabled={loading}
        onClick={() => setRequest({ visit, orientation, tab: reserveLichessTab() })} />
      {loading && <small role="status">Loading analysis line…</small>}
      {current?.failed && <small role="status">Could not load the analysis line. Try ↗ Lichess again.</small>}
    </>;
  };
}
