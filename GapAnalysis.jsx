import React, { useEffect, useRef, useState } from "react";
import { Board, Button, StatusNotice } from "@tempo-v2/core-components";
import { readGapAnalysis, startGapAnalysis } from "./game_commands.js";

function evaluation(candidate) {
  if (candidate.mate != null) {
    if (candidate.mate === 0) return "Checkmate";
    return candidate.mate > 0 ? `Mate in ${candidate.mate}` : `Mated in ${-candidate.mate}`;
  }
  const value = candidate.centipawns / 100;
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}`;
}

export function GapAnalysis({ gap, color, disabled }) {
  const [state, setState] = useState(null);
  const request = useRef(null);
  const timer = useRef(null);
  useEffect(() => () => {
    request.current?.abort();
    clearTimeout(timer.current);
  }, []);

  async function analyze() {
    request.current?.abort();
    clearTimeout(timer.current);
    const controller = new AbortController();
    request.current = controller;
    const requestId = crypto.randomUUID();
    setState({ status: "running" });
    const signal = () => AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]);
    function failed(error) {
      if (!controller.signal.aborted) setState({ status: "error", message: error.message });
    }
    async function poll() {
      try {
        const result = await readGapAnalysis(signal());
        if (controller.signal.aborted) return;
        if (result.request_id !== requestId || result.content_revision !== gap.details.content_revision)
          throw new Error("The position analysis is no longer current. Try again.");
        if (result.status === "running") timer.current = setTimeout(poll, 300);
        else setState(result);
      } catch (error) { failed(error); }
    }
    try {
      await startGapAnalysis({ request_id: requestId, gap: gap.address }, signal());
      if (!controller.signal.aborted) await poll();
    } catch (error) { failed(error); }
  }

  return (
    <section>
      <Button type="button" disabled={disabled || state?.status === "running"} onClick={() => void analyze()}>
        Analyze position
      </Button>
      {state?.status === "running" && <p role="status">Analyzing candidate moves and similar positions…</p>}
      {state?.status === "error" && <StatusNotice kind="error">{state.message}</StatusNotice>}
      {state?.status === "complete" && (
        <>
          <h4>Stockfish candidates</h4>
          {state.stockfish_error && <p>{state.stockfish_error}</p>}
          {state.stockfish && (
            <>
              <p>{state.stockfish.engine} · Evaluation for the side to move</p>
              {state.stockfish.candidates.length > 0 ? <ul>{state.stockfish.candidates.map(candidate =>
                <li key={candidate.uci}>{candidate.san} · {evaluation(candidate)}</li>)}</ul> : <p>No legal response.</p>}
            </>
          )}
          <h4>Similar repertoire positions</h4>
          {state.neighbors_error && <p>{state.neighbors_error}</p>}
          {state.neighbors?.length === 0 && <p>No similar saved positions found.</p>}
          {state.neighbors?.map(({ fen, repertoires }, index) => (
            <details key={fen}>
              <summary>{repertoires.join(", ")} · Similar position {index + 1}</summary>
              <div style={{ width: "min(100%, 240px)" }}>
                <Board fen={fen} orientation={color} turn={color} readOnly coordinates="edges" />
              </div>
            </details>
          ))}
        </>
      )}
    </section>
  );
}
