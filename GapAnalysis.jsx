import React, { useEffect, useState } from "react";
import { Board, Button } from "@tempo-v2/core-components";
import { readGapAnalysis, readGapExplorer, startGapAnalysis, startGapExplorer } from "./game_commands.js";

const localAnalysis = { start: startGapAnalysis, read: readGapAnalysis, busy: "analysis_busy" };
const explorer = { start: startGapExplorer, read: readGapExplorer, busy: "explorer_busy" };

function useGapRead(gap, service, ratings) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState(null);
  useEffect(() => {
    const owner = new AbortController();
    const signal = AbortSignal.any([owner.signal, AbortSignal.timeout(22_000)]);
    const requestId = crypto.randomUUID();
    const input = { request_id: requestId, gap: gap.address, ...(ratings && { ratings }) };
    let timer;
    const publish = value => {
      if (!owner.signal.aborted) setState({ value, ratings, attempt });
    };
    const fail = error => publish({ status: "error", message: error.message, code: error.code });

    async function poll() {
      try {
        const result = await service.read(signal);
        if (owner.signal.aborted) return;
        if (result.request_id !== requestId || result.content_revision !== gap.details.content_revision)
          throw new Error("The result belongs to a different position. Try again.");
        if (result.status === "running") timer = setTimeout(poll, 300);
        else publish(result);
      } catch (error) { fail(error); }
    }

    async function start() {
      try {
        const result = await service.start(input, signal);
        if (owner.signal.aborted) return;
        if (result.content_revision !== gap.details.content_revision)
          throw new Error("The repertoire changed. Reopen this gap for current analysis.");
        await poll();
      } catch (error) {
        if (owner.signal.aborted) return;
        if (error.code === service.busy && !signal.aborted) timer = setTimeout(start, 450);
        else fail(error);
      }
    }
    void start();
    return () => {
      owner.abort();
      clearTimeout(timer);
    };
  }, [gap, service, ratings, attempt]);

  return [
    state?.ratings === ratings && state?.attempt === attempt ? state.value : { status: "running" },
    () => setAttempt(value => value + 1),
  ];
}

function evaluation(candidate) {
  if (candidate.mate != null) {
    if (candidate.mate === 0) return "Checkmate";
    return candidate.mate > 0 ? `Mate in ${candidate.mate}` : `Mated in ${-candidate.mate}`;
  }
  const value = candidate.centipawns / 100;
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}`;
}

export function GapAnalysis({ gap, color, moveButton }) {
  const [state, retry] = useGapRead(gap, localAnalysis);
  return (
    <section>
      <h4>Stockfish</h4>
      {state.status === "running" && <p role="status">Analyzing moves and similar positions…</p>}
      {state.status === "error" && <p role="status">{state.message}</p>}
      {state.stockfish_error && <p>{state.stockfish_error}</p>}
      {state.stockfish && (
        <>
          <p>{state.stockfish.engine} · Evaluation for the side to move</p>
          {state.stockfish.candidates.length
            ? <ul className="gap-moves">{state.stockfish.candidates.map(candidate => (
                <li key={candidate.uci}>{moveButton(candidate.uci, evaluation(candidate))}</li>
              ))}</ul>
            : <p>No legal response.</p>}
        </>
      )}
      {state.status === "complete" && (
        <details>
          <summary>Similar repertoire positions</summary>
          {state.neighbors_error && <p>{state.neighbors_error}</p>}
          {state.neighbors?.length === 0 && <p>No similar saved positions found.</p>}
          {state.neighbors?.map(({ fen, repertoires }, index) => (
            <details key={fen}>
              <summary>{repertoires.join(", ")} · Similar position {index + 1}</summary>
              <div className="gap-neighbor-board">
                <Board fen={fen} orientation={color} turn={fen.split(" ")[1] === "w" ? "white" : "black"}
                  readOnly coordinates="edges" positionIdentity={fen} positionRevision={0} />
              </div>
            </details>
          ))}
        </details>
      )}
      {(state.status === "error" || state.stockfish_error || state.neighbors_error) &&
        <Button onClick={retry}>Retry local analysis</Button>}
    </section>
  );
}

const explorerMessages = {
  token_missing: "Add a Lichess token to display game statistics.",
  token_invalid: "Tempo could not read a valid token from the local token file.",
  token_rejected: "Lichess rejected the token. Replace it with a new one.",
  rate_limited: "Lichess is limiting requests. Try again in a minute.",
  timeout: "The Lichess lookup timed out.",
  invalid_reply: "Lichess returned statistics Tempo could not read.",
  offline: "Lichess Explorer is unavailable.",
};

function games(counts) {
  return counts.white + counts.draws + counts.black;
}

function gameResults(counts, color) {
  const total = games(counts);
  if (!total) return "No games";
  const wins = counts[color];
  const losses = counts[color === "white" ? "black" : "white"];
  const percent = n => (100 * n / total).toFixed(1) + "%";
  return `${total.toLocaleString()} games · ${percent(wins)} W / ${percent(counts.draws)} D / ${percent(losses)} L`;
}

export function GapExplorer({ gap, color, moveButton }) {
  const [ratings, setRatings] = useState("around1500");
  const [state, retry] = useGapRead(gap, explorer, ratings);
  const [copied, setCopied] = useState(false);
  return (
    <section>
      <h4>Lichess Explorer</h4>
      <label>Rated Rapid · average rating <select value={ratings} onChange={event => setRatings(event.target.value)}>
        <option value="below1500">1200–1399</option>
        <option value="around1500">1400–1599</option>
        <option value="above1500">1600–1799</option>
        <option value="all">All ratings</option>
      </select></label>
      {state.status === "running" && <p role="status">Loading Lichess statistics…</p>}
      {(state.status === "error" || state.status === "unavailable") && (
        <>
          <p role="status">{explorerMessages[state.code] ?? state.message ?? explorerMessages.offline}</p>
          {["token_missing", "token_invalid", "token_rejected"].includes(state.code) && (
            <details open>
              <summary>Set up Lichess Explorer</summary>
              <p><a href="https://lichess.org/account/oauth/token/create" target="_blank" rel="noreferrer">Create a Lichess token</a>.
                Name it “Tempo Explorer” and leave the permissions unchecked. Save the token by itself in a private plain-text file
                named <code>lichess-explorer.token</code> next to Tempo’s database, then select Retry Explorer.</p>
              {state.token_path && <p>
                <code className="gap-token-path">{state.token_path}</code>{" "}
                <Button onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(state.token_path);
                    setCopied(true);
                  } catch {
                    setCopied(false);
                  }
                }}>{copied ? "Path copied" : "Copy file path"}</Button>
              </p>}
            </details>
          )}
          <Button onClick={retry}>Retry Explorer</Button>
        </>
      )}
      {state.status === "complete" && (games(state.statistics) ? (
        <>
          <p>{gameResults(state.statistics, color)} · from your side</p>
          <ul className="gap-moves">{state.statistics.moves.map(move => (
            <li key={move.uci}>{moveButton(move.uci, gameResults(move, color))}</li>
          ))}</ul>
        </>
      ) : <p>No Lichess games match this position and rating filter.</p>)}
    </section>
  );
}
