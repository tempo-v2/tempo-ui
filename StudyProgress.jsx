import React, { useEffect, useRef, useState } from "react";
import { postCommand } from "./content_transport.js";

export function StudyProgress({ view, stopped }) {
  const [summary, setSummary] = useState(null);
  const [unavailable, setUnavailable] = useState(false);
  const known = useRef(null);
  const dataset = view?.dataset_id;
  const attempt = view?.attempt_id;
  const status = view?.status;
  const grade = view?.assessment;
  const remaining = view?.tactics_remaining;

  useEffect(() => {
    if (!dataset) return;
    let cancelled = false;
    let inFlight = false;
    async function refresh(stamp) {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await postCommand("/api/study-progress", stamp);
        if (cancelled) return;
        if (next?.status === "error" || (next && next.stamp.dataset_id !== dataset))
          throw new Error("Progress unavailable");
        if (next) {
          known.current = next.stamp;
          setSummary(next);
        }
        setUnavailable(false);
      } catch {
        if (!cancelled) setUnavailable(true);
      } finally {
        inFlight = false;
      }
    }
    // A confirmed study transition refreshes the projection. Between
    // transitions only check the stamp, so midnight needs no catalog polling.
    void refresh(known.current);
    const interval = setInterval(() => void refresh(known.current), 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [dataset, attempt, status, grade, remaining, stopped]);

  if (unavailable) return <p className="study-progress">Daily progress unavailable.</p>;
  if (!summary || summary.stamp.dataset_id !== dataset) return null;
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
