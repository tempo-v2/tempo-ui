import React, { useEffect, useRef, useState } from "react";
import { Button, StatusNotice } from "@tempo-v2/core-components";
import { readCoverage, startCoverage } from "./game_commands.js";

export function coveragePercent(probability) {
  if (probability > 0 && probability < 0.001) return "<0.1%";
  if (probability < 1 && probability > 0.999) return ">99.9%";
  return `${Number((probability * 100).toFixed(1))}%`;
}

export function RepertoireCoverage({ dataset, repertoires, forecastBook, onFilter, refresh, onReport }) {
  const [selected, setSelected] = useState(forecastBook ?? "");
  const [target, setTarget] = useState("90");
  const [depth, setDepth] = useState("8");
  const [attempt, setAttempt] = useState(null);
  const sent = useRef(null);
  const [state, setState] = useState(null);
  const [issue, setIssue] = useState("");
  const [starting, setStarting] = useState(null);
  const seen = useRef(null);
  const reportChanged = useRef(onReport);
  reportChanged.current = onReport;
  const active = repertoires.filter(item => item.activity === "active");
  const repertoire = active.find(item => item.id === selected);
  const current = state?.dataset_id === dataset && state?.repertoire_id === repertoire?.id ? state : null;

  useEffect(() => {
    if (!dataset || !repertoire) return;
    const controller = new AbortController();
    let timer;
    let keepReading = false;
    const address = { dataset_id: dataset, repertoire_id: repertoire.id };
    const request = attempt?.dataset_id === dataset && attempt.repertoire_id === repertoire.id ? attempt : null;

    async function observe(start, preserveIssue = false) {
      try {
        const next = await (start ? startCoverage(request, controller.signal) : readCoverage(address, controller.signal));
        if (controller.signal.aborted) return;
        setState(next);
        if (!preserveIssue) setIssue("");
        setStarting(null);
        if (next.report && next.report.request_id !== seen.current) {
          seen.current = next.report.request_id;
          reportChanged.current();
        }
        keepReading = next.busy;
        if (keepReading) timer = setTimeout(() => void observe(false, preserveIssue), 900);
      } catch (error) {
        if (controller.signal.aborted) return;
        setIssue(error.message || "Could not check repertoire coverage.");
        if (start && ["coverage_busy", "stale_coverage"].includes(error.code)) {
          timer = setTimeout(() => void observe(false, true), 900);
        } else if ((start && !error.status) || keepReading) {
          timer = setTimeout(() => void observe(false), 900);
        }
      } finally {
        if (start && !controller.signal.aborted) setStarting(null);
      }
    }
    // Send once for the explicit form submission. Refreshes and reloads read current status.
    const start = Boolean(request && sent.current !== request.request_id);
    if (start) sent.current = request.request_id;
    void observe(start);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [dataset, repertoire?.id, refresh, attempt]);

  function submit(event) {
    event.preventDefault();
    setIssue("");
    setStarting(repertoire.id);
    setAttempt({ request_id: crypto.randomUUID(), dataset_id: dataset, repertoire_id: repertoire.id,
      target_percent: Number(target), through_move: Number(depth),
      prior_report_id: current?.report?.request_id ?? null });
  }

  const report = current?.report;
  const minimum = report && coveragePercent(report.covered);
  const maximum = report && coveragePercent(report.covered + report.unresolved);
  const goal = report && report.target_percent / 100;
  const achievement = report && (report.covered + 1e-9 >= goal ? "Target met"
    : report.covered + report.unresolved + 1e-9 < goal ? "Below target" : "Target uncertain");

  return <div className="repertoire-form">
    <form onSubmit={submit}>
      <h3>Scan repertoire coverage</h3>
      <div className="repertoire-fields">
        <label>Repertoire
          <select value={repertoire?.id ?? ""} onChange={event => { setSelected(event.target.value); setIssue(""); setStarting(null); }}>
            <option value="">Choose a repertoire</option>
            {active.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <label>Target probability (%)
          <input type="number" min="1" max="100" required value={target} onChange={event => setTarget(event.target.value)} />
        </label>
        <label>Through your move
          <input type="number" min="1" max="20" required value={depth} onChange={event => setDepth(event.target.value)} />
        </label>
      </div>
      <div className="actions">
        <Button type="submit" disabled={!dataset || !repertoire || !current || current.busy || starting === repertoire.id}>Scan repertoire</Button>
        {report && forecastBook !== repertoire?.id && <Button type="button" onClick={() => onFilter(repertoire.id)}>This scan</Button>}
        {forecastBook && <Button type="button" onClick={() => onFilter(null)}>All gaps</Button>}
      </div>
    </form>
    {current?.status === "running" && <p role="status">Scanning · {current.positions ?? 0} opponent positions checked</p>}
    {current?.busy && current.status !== "running" && <p role="status">Another repertoire scan is running.</p>}
    {(current?.error || issue) && <StatusNotice kind="error">{issue || current.error}</StatusNotice>}
    {report && <div role="status">
      <p><strong>{current.stale ? "Earlier estimate" : achievement}</strong> · {minimum}
        {report.unresolved > 1e-9 && ` to ${maximum}`} estimated coverage through your move {report.through_move}
        { ` · ${report.target_percent}% target`}</p>
      <p>Rapid around 1500 · Explorer at {report.explorer_positions} of {report.positions} positions
        { ` · Maia at ${report.maia_positions} of ${report.positions}`}</p>
      {current.stale && <p>Repertoire changed. Rerun the scan to update the estimate.</p>}
    </div>}
  </div>;
}
