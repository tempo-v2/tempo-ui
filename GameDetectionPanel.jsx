import React, { useEffect, useRef, useState } from "react";
import { Board, Button, StatusNotice } from "@tempo-v2/core-components";
import { readDetectors, scanGame } from "./game_detection.js";

const statusCopy = {
  unconfigured: "Game detectors are not configured.",
  unsupported: "This detector does not support this game.",
  source_unavailable: "This saved game is unavailable to the detector.",
  timed_out: "The detector ran out of time.",
  cancelled: "The detector stopped before completing the game.",
  failed: "The detector could not complete this game.",
  invalid_result: "Tempo rejected an invalid detector result.",
  busy: "A detector is still working. Try again in a moment.",
  expired: "This result expired. Run the detector again to get a new result.",
  stale: "This result belongs to a different dataset.",
  invalid_perspective: "Enter the exact name of one of the two players.",
  delivery_error: "Tempo could not read the detector reply. You can run the detector again.",
};

function DetectionFindings({ result }) {
  const [selected, setSelected] = useState(null);
  const moment = result.findings.find(item => item.finding_id === selected) ?? result.findings[0];
  if (!moment) return <p role="status">The selected detector reported no observations.</p>;
  return (
    <>
      {result.findings.length > 1 && (
        <label>Observation <select value={moment.finding_id} onChange={event => setSelected(event.target.value)}>
          {result.findings.map(item => (
            <option key={item.finding_id} value={item.finding_id}>Half-move {item.occurrence} · {item.code}</option>
          ))}
        </select></label>
      )}
      <p role="status">Half-move {moment.occurrence} · {moment.side_to_move === "black" ? "Black" : "White"} to move</p>
      <p>{moment.explanation || moment.code}</p>
      {moment.candidate_san && <p>Observed candidate {moment.candidate_san}</p>}
      <Board
        fen={moment.fen}
        positionIdentity={moment.finding_id}
        positionRevision={0}
        check={false}
        mode="legal"
        orientation={result.learner_color}
        turn={moment.side_to_move}
        readOnly
        maxSize={320}
        coordinates="edges"
        ariaLabel="Detector finding position"
      />
    </>
  );
}

// The caller keys the panel by the accepted dataset/source/game/learner tuple.
export function GameDetectionPanel({ dataset, source, gameId, learner }) {
  const [registry, setRegistry] = useState(null);
  const [discoveryFailed, setDiscoveryFailed] = useState(false);
  const [discoveryRevision, setDiscoveryRevision] = useState(0);
  const [detectorId, setDetectorId] = useState("");
  const [perspective, setPerspective] = useState(learner);
  const [result, setResult] = useState(null);
  const current = useRef(null);

  useEffect(() => {
    const owner = new AbortController();
    readDetectors(owner.signal).then(value => {
      if (!owner.signal.aborted) setRegistry(value);
    }, () => {
      if (!owner.signal.aborted) setDiscoveryFailed(true);
    });
    return () => {
      owner.abort();
      current.current?.abort();
    };
  }, [discoveryRevision]);

  function clearResult() {
    current.current?.abort();
    current.current = null;
    setResult(null);
  }

  const detector = registry?.detectors.find(item => item.id === detectorId) ?? registry?.detectors[0];
  const running = result?.status === "running";

  async function run(event) {
    event.preventDefault();
    if (!detector || !perspective.trim()) return;
    current.current?.abort();
    const owner = new AbortController();
    current.current = owner;
    setResult({ status: "running" });
    try {
      const reply = await scanGame({ dataset, source, gameId, learner: perspective.trim(), detector }, owner.signal);
      if (current.current === owner && !owner.signal.aborted) setResult(reply);
    } catch {
      if (current.current === owner && !owner.signal.aborted) setResult({ status: "delivery_error" });
    }
  }

  return (
    <section aria-label="Game detector">
      <h3>Game detector</h3>
      {discoveryFailed ? (
        <>
          <StatusNotice kind="error">Detector availability could not be read.</StatusNotice>
          <Button onClick={() => {
            setDiscoveryFailed(false);
            setDiscoveryRevision(value => value + 1);
          }}>Retry detector discovery</Button>
        </>
      ) : registry === null ? <p role="status">Checking detector availability…</p>
        : registry.status === "unconfigured" ? <p role="status">{statusCopy.unconfigured}</p>
        : (
          <>
            <form onSubmit={run} className="repertoire-form">
              <div className="repertoire-fields">
                <label>Detector <select value={detector.id} onChange={event => {
                  clearResult();
                  setDetectorId(event.target.value);
                }}>
                  {registry.detectors.map(item => <option key={item.id} value={item.id}>{item.label || item.id}</option>)}
                </select></label>
                <label>Player perspective <input value={perspective} onChange={event => {
                  clearResult();
                  setPerspective(event.target.value);
                }} required autoComplete="off" /></label>
              </div>
              <Button type="submit" disabled={running || !perspective.trim()}>Run detector</Button>
            </form>
            {running ? <p role="status">The detector is analyzing this game…</p>
              : result?.status === "complete" ? <DetectionFindings key={result.request_id} result={result} />
              : result && <p role="status">{statusCopy[result.code ?? result.status] ?? "Detector analysis is unavailable."}</p>}
          </>
        )}
    </section>
  );
}
