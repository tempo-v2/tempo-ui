import React, { useEffect, useMemo, useRef, useState } from "react";
import { SMALL_READ_TIMEOUT_MS } from "./bounded_read.js";
import { postCommand } from "./content_transport.js";

export function useStudyProgress(view, stopped) {
  const [result, setResult] = useState(null);
  const known = useRef(null);
  const dataset = view?.dataset_id;
  const attempt = view?.attempt_id;
  const status = view?.status;
  const grade = view?.assessment;
  const remaining = view?.tactics_remaining;
  const scope = useMemo(() => ({ dataset }),
    [dataset, attempt, status, grade, remaining, stopped]);

  useEffect(() => {
    if (!scope.dataset) return;
    const request = new AbortController();
    let inFlight = false;
    async function refresh() {
      if (inFlight) return;
      inFlight = true;
      try {
        const previous = known.current?.stamp?.dataset_id === scope.dataset ? known.current : null;
        const next = await postCommand("/api/study-progress", previous?.stamp ?? null, request.signal,
          undefined, { timeoutMs: SMALL_READ_TIMEOUT_MS });
        if (request.signal.aborted) return;
        if (next?.status === "error" || (next && next.stamp?.dataset_id !== scope.dataset))
          throw new Error("Progress unavailable");
        const summary = next ?? previous;
        known.current = summary;
        setResult({ scope, summary });
      } catch {
        if (!request.signal.aborted) setResult({ scope, summary: null });
      } finally {
        inFlight = false;
      }
    }
    // A confirmed study transition refreshes the projection. Between
    // transitions only check the stamp, so midnight needs no catalog polling.
    void refresh();
    const interval = setInterval(refresh, 60_000);
    return () => {
      request.abort();
      clearInterval(interval);
    };
  }, [scope]);

  const current = result?.scope === scope;
  const summary = result && result.scope.dataset === dataset ? result.summary : null;
  const count = summary?.repairs_remaining;
  return {
    summary,
    unavailable: current && !summary,
    repairsRemaining: current && Number.isSafeInteger(count) && count >= 0 ? count : null,
  };
}

export function StudyProgress({ summary, unavailable }) {
  if (unavailable) return <p className="study-progress">Daily progress unavailable.</p>;
  if (!summary) return null;
  return (
    <section className="study-progress" aria-label="Today's study progress">
      <h2>Today</h2>
      <dl>
        <div><dt>Due reviews</dt><dd>{summary.due}</dd></div>
        {!!summary.reteach && <div><dt>Opening moves to relearn</dt><dd>{summary.reteach}</dd></div>}
        <div><dt>New opening moves</dt><dd>{summary.openings_introduced} / {summary.openings_limit}</dd></div>
        <div><dt>New tactics</dt><dd>{summary.tactics_introduced} / {summary.tactics_limit}
          {!!summary.extra_tactics && ` (+${summary.extra_tactics} today)`}</dd></div>
      </dl>
      {summary.active_correction && <p>Current test still needs correction.</p>}
    </section>
  );
}
