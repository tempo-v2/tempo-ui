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
  const deliveryCount = useRef(0);
  const [state, setState] = useState(null);
  const [issue, setIssue] = useState("");
  const [readIssue, setReadIssue] = useState("");
  const seen = useRef(null);
  const reportChanged = useRef(onReport);
  reportChanged.current = onReport;
  const active = repertoires.filter(item => item.activity === "active");
  const repertoire = active.find(item => item.id === selected);
  const current = state?.dataset_id === dataset && state?.repertoire_id === repertoire?.id ? state : null;

  const request = attempt?.request;
  const delivery = attempt?.delivery;
  useEffect(() => {
    if (!dataset || !repertoire) return;
    const controller = new AbortController();
    let timer;
    let keepReading = false;
    let pending = request;
    const address = { dataset_id: dataset, repertoire_id: repertoire.id };
    const matches = next => pending && (
      next.request_id === pending.request_id || next.report?.request_id === pending.request_id
    );
    function settle() {
      pending = null;
      setAttempt(null);
    }
    function retryAvailable() {
      setAttempt(previous => previous?.request === pending
        ? { ...previous, canRetry: true } : previous);
    }

    async function observe(start) {
      try {
        const next = await (start ? startCoverage(pending, controller.signal) : readCoverage(address, controller.signal));
        if (controller.signal.aborted) return;
        setState(next);
        setReadIssue("");
        if (matches(next)) {
          settle();
          setIssue("");
        }
        if (pending) {
          setIssue("Tempo has not confirmed this scan.");
          if (!next.busy) retryAvailable();
        }
        if (next.report && next.report.request_id !== seen.current) {
          seen.current = next.report.request_id;
          reportChanged.current();
        }
        keepReading = next.busy;
        if (keepReading || (start && pending))
          timer = setTimeout(() => void observe(false), 900);
      } catch (error) {
        if (controller.signal.aborted) return;
        if (start && ["coverage_busy", "stale_coverage", "invalid_scan", "stale_dataset", "invalid_game"].includes(error.code)) {
          settle();
          setIssue(error.message);
        } else if (pending) {
          setIssue("Tempo has not confirmed this scan.");
          if (start || keepReading) timer = setTimeout(() => void observe(false), 900);
          else retryAvailable();
        } else {
          setReadIssue(error.message || "Could not check repertoire coverage.");
          if (keepReading) timer = setTimeout(() => void observe(false), 900);
        }
      }
    }
    // A transport retry resends the same request. Normal refresh reads status.
    const start = Boolean(pending && sent.current !== delivery);
    if (start) sent.current = delivery;
    void observe(start);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [dataset, repertoire?.id, refresh, request, delivery]);

  function submit(event) {
    event.preventDefault();
    if (!repertoire || !current || current.busy || attempt) return;
    setIssue("");
    setAttempt({
      request: {
        request_id: crypto.randomUUID(), dataset_id: dataset, repertoire_id: repertoire.id,
        target_percent: Number(target), through_move: Number(depth),
        prior_report_id: current.report?.request_id ?? null,
      },
      delivery: ++deliveryCount.current, canRetry: false,
    });
  }

  function retry() {
    const next = ++deliveryCount.current;
    setAttempt(previous => previous?.canRetry ? { ...previous, delivery: next, canRetry: false } : previous);
  }

  const report = current?.report;
  const minimum = report && coveragePercent(report.covered);
  const maximum = report && coveragePercent(report.covered + report.unresolved);
  const goal = report && report.target_percent / 100;
  const achievement = report && (report.covered + 1e-9 >= goal ? "Target met"
    : report.covered + report.unresolved + 1e-9 < goal ? "Below target" : "Target uncertain");

  const earlier = current?.stale || attempt || (
    current?.request_id && current.request_id !== report?.request_id
  );

  return <div className="repertoire-form">
    <form onSubmit={submit}>
      <h3>Scan repertoire coverage</h3>
      <div className="repertoire-fields">
        <label>Repertoire
          <select value={repertoire?.id ?? ""} disabled={!!attempt && !!repertoire} onChange={event => {
            setSelected(event.target.value); setAttempt(null); setIssue(""); setReadIssue("");
          }}>
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
        <Button type="submit" disabled={!dataset || !repertoire || !current || current.busy || !!attempt}>Scan repertoire</Button>
        {attempt?.canRetry && <Button type="button" onClick={retry}>Retry same scan</Button>}
        {report && forecastBook !== repertoire?.id && <Button type="button" onClick={() => onFilter(repertoire.id)}>This scan</Button>}
        {forecastBook && <Button type="button" onClick={() => onFilter(null)}>All gaps</Button>}
      </div>
    </form>
    {current?.status === "running" && <p role="status">Scanning · {current.positions ?? 0} opponent positions checked</p>}
    {current?.busy && current.status !== "running" && <p role="status">Another repertoire scan is running.</p>}
    {(current?.error || issue || readIssue) && <StatusNotice kind="error">{issue || readIssue || current.error}</StatusNotice>}
    {report && <div role="status">
      <p><strong>{earlier ? "Earlier estimate" : achievement}</strong> · {minimum}
        {report.unresolved > 1e-9 && ` to ${maximum}`} estimated coverage through your move {report.through_move}
        { ` · ${report.target_percent}% target`}</p>
      <p>Rapid around 1500 · Explorer at {report.explorer_positions} of {report.positions} positions
        { ` · Maia at ${report.maia_positions} of ${report.positions}`}</p>
      {current.stale && <p>Repertoire changed. Rerun the scan to update the estimate.</p>}
    </div>}
  </div>;
}
