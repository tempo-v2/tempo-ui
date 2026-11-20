import React, { useEffect, useState } from "react";
import { Board, Button, SectionHeader, StatusNotice, Surface } from "@tempo-v2/core-components";
import { commandTacticalAnalysis, readTacticalHistory, tacticalNotation, tacticalOutcomes, tacticalScore } from "./tactical_history.js";
import { sourceNames } from "./game_commands.js";
import "./tactical_history.css";

const qualityNames = { best_or_equivalent: "Best or equivalent", inferior: "Inferior", uncertain: "Uncertain" };
const outcomeDescriptions = {
  took_good_capture: "You took the hanging material with a best or equivalent move.",
  good_alternative: "A good capture was available. The move you played was equally good.",
  missed_good_capture: "You passed up a good capture.",
  took_inferior_capture: "You took the material, but Stockfish preferred another move.",
  declined_inferior_capture: "Taking the apparently free material was worse than another available move.",
  winning_mate: "Stockfish found a winning mate. Tempo kept the mate finding for this turn.",
  uncertain: "The capture is recorded, but its quality has not been established. This analysis does not add a new puzzle.",
};

function moveLabel(row) {
  const { fen, side_to_move, assessment } = row.details;
  const fullmove = fen.trim().split(/\s+/)[5];
  return `${fullmove}${side_to_move === "white" ? "." : "..."} ${tacticalNotation(fen, assessment.played.uci)}`;
}

function Observation({ row, dataset, analysisVersion, onOpen }) {
  const { fen, side_to_move: side, assessment } = row.details;
  const source = sourceNames[row.source] ?? "Saved game";
  const scoredRoots = assessment.analysis.status === "complete" ? assessment.analysis.evaluation.roots : [];
  const playedScore = scoredRoots.find(root => root.uci === assessment.played.uci)?.score ?? null;
  const puzzle = assessment.puzzle;
  return <article className="tactical-observation" aria-label="Selected capture opportunity">
    <div className="tactical-position">
      <Board fen={fen} positionIdentity={`${dataset}:${row.id}:${row.analysis_version}`} positionRevision={0}
        check={false} mode="legal" orientation={side} turn={side} readOnly maxSize={340} coordinates="edges"
        ariaLabel="Hanging-piece opportunity position" />
      <p><strong>{side === "white" ? "White" : "Black"} to move</strong> · Before {moveLabel(row)}</p>
    </div>
    <div className="tactical-comparison">
      <h3>{tacticalOutcomes[row.outcome]}</h3>
      <p>{outcomeDescriptions[row.outcome]}</p>
      <p>{source} · {row.learner} · Game {row.game_id}</p>
      {row.analysis_version !== analysisVersion && <p className="tactical-muted">From an earlier analysis.</p>}
      {onOpen && <Button size="compact" variant="quiet" onClick={() => onOpen({
        dataset_id: dataset, source: row.source, game_id: row.game_id, learner: row.learner,
        repertoire_id: null, ply: row.ply, start: row.ply, branch: [],
      })}>Open source game</Button>}
      <p><strong>You played {tacticalNotation(fen, assessment.played.uci)}</strong> · {tacticalScore(playedScore)}</p>
      {assessment.accepted_moves.length > 0 && <p><strong>Best or equivalent moves:</strong>{" "}
        {assessment.accepted_moves.map(answer => {
          const score = scoredRoots.find(root => root.uci === answer.uci)?.score;
          return `${tacticalNotation(fen, answer.uci)}${score ? ` (${tacticalScore(score)})` : ""}`;
        }).join(", ")}
      </p>}
      {assessment.candidates.length > 0 && <table className="tactical-captures">
        <caption>Available captures · scores from your side</caption>
        <thead><tr><th scope="col">Capture</th><th scope="col">Stockfish</th><th scope="col">Comparison</th></tr></thead>
        <tbody>{assessment.candidates.map(({ capture, quality, score }) => <tr key={capture.answer.uci}>
          <td><strong>{tacticalNotation(fen, capture.answer.uci)}</strong><span className="tactical-target">{capture.target.role} on {capture.target.square}</span></td>
          <td>{tacticalScore(score)}</td><td>{qualityNames[quality]}</td>
        </tr>)}</tbody>
      </table>}
      {(puzzle || row.puzzle) && <div className="tactical-puzzle">
        {puzzle && <p><strong>Selected capture (current analysis): {tacticalNotation(puzzle.fen, puzzle.answer.uci)}</strong></p>}
        {row.puzzle && <p><strong>{puzzle ? "Recorded Study card" : "Earlier Study card"}:</strong>{" "}
          {row.request_id === null ? "Recorded" : row.fulfilled ? "Reviewed in Study" : "Prioritized in Study"}
        </p>}
      </div>}
      {puzzle && <p className="tactical-muted">Stockfish selects one best qualifying capture. A recorded Study card keeps its original answer if later analysis changes.</p>}
      {["took_inferior_capture", "declined_inferior_capture"].includes(row.outcome)
        && <p className="tactical-muted">Kept for comparison. This analysis does not add a new puzzle.</p>}
    </div>
  </article>;
}

function HistorySession({ dataset, onOpen }) {
  const [before, setBefore] = useState(undefined);
  const [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState(null);
  const [availability, setAvailability] = useState(null);
  const [error, setError] = useState(false);
  const [commandError, setCommandError] = useState(null);
  const [working, setWorking] = useState(false);
  async function change(action) {
    setCommandError(null);
    setWorking(true);
    try {
      await commandTacticalAnalysis(dataset, action);
      setRevision(value => value + 1);
    } catch (error) {
      setCommandError(error.message);
    } finally {
      setWorking(false);
    }
  }
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const view = snapshot && snapshot.before === before ? snapshot.value : null;

  useEffect(() => {
    const owner = new AbortController();
    let timer;
    async function read() {
      setLoading(true);
      let keepPolling = true;
      try {
        const value = await readTacticalHistory(dataset, before, owner.signal);
        if (owner.signal.aborted) return;
        setError(false);
        if (value.status === "unavailable") {
          setAvailability(value.message);
          keepPolling = false;
        } else {
          setAvailability(null);
          setSnapshot({ before, value });
        }
      } catch {
        if (!owner.signal.aborted) setError(true);
      } finally {
        if (!owner.signal.aborted) {
          setLoading(false);
          if (keepPolling) timer = setTimeout(read, 3000);
        }
      }
    }
    void read();
    return () => { clearTimeout(timer); owner.abort(); };
  }, [dataset, before, revision]);

  function page(cursor) { setSelected(null); setAvailability(null); setError(false); setBefore(cursor); }
  const stats = view?.statistics;
  const outcomes = stats?.outcomes ?? {};
  const current = view?.observations.find(row => row.id === selected) ?? view?.observations[0];
  const interrupted = availability !== null || error;
  const incomplete = stats ? stats.failed_games + stats.timed_out_games + stats.unsupported_games : 0;
  const progress = interrupted ? "Last available results" : view?.paused ? "Analysis paused"
    : view?.status === "running" ? "Analyzing saved games"
    : view?.waiting_for_idle && stats?.pending_games > 0 ? "Waiting for the Mac to be idle on wall power"
    : stats?.pending_games > 0 ? "Waiting to analyze saved games" : incomplete > 0 ? "Analysis finished with gaps" : "Analysis up to date";

  return <section aria-label="Hanging-piece history" className="tactical-history"><Surface>
    <SectionHeader title="Analysis"><Button size="compact" variant="quiet" disabled={loading}
      onClick={() => setRevision(value => value + 1)}>Refresh tactics</Button></SectionHeader>
    <p>See when you took free material, missed a good capture, or chose an equally good move.</p>
    {availability !== null && <StatusNotice>{availability}{view && " Showing the last available results."}</StatusNotice>}
    {error && <StatusNotice kind="error">The latest tactical results could not be read.{view && " Showing the last available results."}</StatusNotice>}
    {!view && loading && <p role="status">Reading tactical results…</p>}
    {commandError && <StatusNotice kind="error">{commandError}</StatusNotice>}
    {view && <>
      {view.paused !== undefined && <div>
        <Button disabled={working} onClick={() => change(view.paused ? "resume" : "pause")}>{view.paused ? "Resume analysis" : "Pause analysis"}</Button>
        <Button disabled={working || !stats.retryable_positions} onClick={() => change("retry")}>Retry inconclusive positions</Button>
      </div>}
      <p className="tactical-coverage" role="status">{progress}
        {" · "}{stats.completed_games.toLocaleString()} games checked · {stats.decisions_scanned.toLocaleString()} decisions scanned
        {stats.pending_positions > 0 && ` · ${stats.pending_positions.toLocaleString()} positions pending`}
        {stats.inconclusive_positions > 0 && ` · ${stats.inconclusive_positions.toLocaleString()} inconclusive`}
        {stats.pending_games > 0 && ` · ${stats.pending_games.toLocaleString()} games remaining`}</p>
      {view.games?.length > 0 && <details>
        <summary>Recent games in analysis</summary>
        <ul>{view.games.map(game => <li key={JSON.stringify([game.source, game.game_id])}>
          <strong>{game.white} vs {game.black}</strong>
          {game.preparing ? " · Queued" : ` · ${game.checked} checked · ${game.pending} pending · ${game.inconclusive} inconclusive`}
        </li>)}</ul>
      </details>}
      <dl className="tactical-counts">{Object.entries(tacticalOutcomes).map(([key, label]) => <div key={key}>
        <dt>{label}</dt><dd>{(outcomes[key] ?? 0).toLocaleString()}</dd>
      </div>)}</dl>
      <p className="tactical-muted">Counts are per decision in your games. The same piece or puzzle can appear in more than one decision.</p>
      {stats.pending_requests > 0 && <p className="tactical-queue"><strong>{stats.pending_requests.toLocaleString()} {stats.pending_requests === 1 ? "review" : "reviews"} waiting in Study.</strong> Game puzzles alternate with due reviews after your current card.</p>}
      {incomplete > 0 && <p>{incomplete.toLocaleString()} {incomplete === 1 ? "game could" : "games could"} not be fully analyzed. Unfinished analysis is not counted as a missed capture.</p>}
      {view.last_error && <StatusNotice kind="error">{view.last_error}</StatusNotice>}
      {current ? <>
        <div className="tactical-history-layout">
          <div className="tactical-list"><h3>{before === undefined ? "Recent opportunities" : "Earlier opportunities"}</h3>
            <ol>{view.observations.map(row => <li key={row.id}>
              <button type="button" aria-pressed={row.id === current.id} onClick={() => setSelected(row.id)}>
                <strong>{tacticalOutcomes[row.outcome]}</strong><span>{moveLabel(row)} · {sourceNames[row.source] ?? "Saved game"}</span>
                <span>{row.learner}{row.request_id !== null && ` · ${row.fulfilled ? "Reviewed" : "Queued"}`}</span>
              </button>
            </li>)}</ol>
          </div>
          <Observation row={current} dataset={dataset} analysisVersion={view.analysis_version} onOpen={onOpen} />
        </div>
      </> : <p>{stats.pending_games > 0 || view.status === "running"
        ? "Opportunities will appear as your games are analyzed." : "No hanging-piece opportunities have been recorded in the analyzed games."}</p>}
      {(before !== undefined || view.next_before !== null) && <nav className="tactical-pages" aria-label="Tactical history pages">
        {before !== undefined && <Button disabled={loading} onClick={() => page(undefined)}>Latest opportunities</Button>}
        {view.next_before !== null && <Button disabled={loading} onClick={() => page(view.next_before)}>Earlier opportunities</Button>}
      </nav>}
    </>}
  </Surface></section>;
}

export function TacticalHistory({ dataset, onOpen }) {
  return dataset ? <HistorySession key={dataset} dataset={dataset} onOpen={onOpen} /> : null;
}
