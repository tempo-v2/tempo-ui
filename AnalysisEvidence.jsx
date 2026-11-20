import { TempoBoard as Board } from "./board_preferences.jsx";
import { Button } from "@tempo-v2/core-components";
import { LichessControl } from "./LichessControl.jsx";
import React, { useEffect, useState } from "react";
import { comparisonCandidates, leadingMeasuredMoves, measurementText, engineCells, explorerCells, probabilityCells } from "./move_evidence.js";
import { usePositionEvidence } from "./position_evidence.js";

export const sources = {
  repertoire: "Repertoire",
  stockfish: "Stockfish",
  rated: "Lichess Rapid",
  masters: "Masters",
  maia: "Maia Rapid 1500",
};

function labels(cells, withResults = false) {
  return Object.fromEntries(Object.entries(cells).map(([move, cell]) =>
    [move, cell.text + (withResults ? cell.detail : "")]));
}

export function AnalysisEvidence({
  fen,
  origin,
  bookRevision,
  moves,
  pins,
  togglePin,
  play,
  hover,
  onOverlay,
}) {
  const [allLegal,setAllLegal] = useState(false);
  const [ratings, setRatings] = useState("around1500");
  const [retry, setRetry] = useState({});
  const [enabled, setEnabled] = useState({});
  const context = {
    dataset_id: origin.datasetId,
    learner_color: origin.color,
    repertoire_id: origin.repertoireId || undefined,
  };
  const book = usePositionEvidence(fen, "repertoire", context, [
    retry.repertoire,
    bookRevision,
  ], moves);
  const fish = usePositionEvidence(fen, "stockfish", { pins }, retry.stockfish, moves);
  const rapid = usePositionEvidence(fen, "rated", { ratings }, retry.rated, moves);
  const masters = usePositionEvidence(fen, "masters", {}, retry.masters, moves);
  const maia = usePositionEvidence(fen, "maia", {}, retry.maia, moves);
  const replies = {
    repertoire: book,
    stockfish: fish,
    rated: rapid,
    masters,
    maia,
  };
  const repertoire = {};
  for (const row of book.data?.exact || [])
    repertoire[row.uci] =
      (repertoire[row.uci] ? repertoire[row.uci] + ", " : "") +
      (row.repertoire_id === origin.repertoireId
        ? "This repertoire"
        : book.data.repertoire_names[row.repertoire_id] || "Other repertoire");
  const similar = new Map();
  for (const group of ["current", "other"]) {
    for (const row of book.data?.similar_responses?.[group] || []) {
      const support = similar.get(row.uci) || [];
      const positions = book.data.nearby[group].filter((position) =>
        position.responses.some((response) => response.reusable && response.uci === row.uci),
      );
      support.push({ group, count: row.position_count, positions });
      similar.set(row.uci, support);
    }
  }
  const ratedCells = explorerCells(rapid.data);
  const masterCells = explorerCells(masters.data);
  const maiaCells = probabilityCells(maia.data);
  const nearbyCells = Object.fromEntries([...similar].map(([move,entries]) =>
    [move, {score:entries.reduce((sum,group) => sum + group.count,0)}]));
  const columns = {
    repertoire: Object.fromEntries([...Object.keys(repertoire), ...similar.keys()].map((m) => [m, repertoire[m]])),
    stockfish: labels(engineCells(fen, fish.data)),
    rated: labels(ratedCells, true),
    masters: labels(masterCells, true),
    maia: labels(maiaCells),
  };
  const sourceMoves = {repertoire:[...new Set([...Object.keys(repertoire),...leadingMeasuredMoves(nearbyCells)])],
    stockfish:Object.keys(columns.stockfish), rated:leadingMeasuredMoves(ratedCells),
    masters:leadingMeasuredMoves(masterCells), maia:leadingMeasuredMoves(maiaCells)};
  const overlay = Object.keys(sources).flatMap(source => enabled[source]
    ? sourceMoves[source].slice(0,3).map(move => ({move,source})) : []);
  const overlayKey = JSON.stringify(overlay);
  useEffect(() => {
    onOverlay(overlay);
  }, [fen, overlayKey]);
  const rows = comparisonCandidates(moves,{required:pins,exact:Object.keys(repertoire),engine:sourceMoves.stockfish,
    ranked:[nearbyCells,ratedCells,masterCells,maiaCells],allLegal});
  return (
    <section aria-label="Move comparison">
      <div className="actions">
        <label>
          Rapid rating{" "}
          <select value={ratings} onChange={(e) => setRatings(e.target.value)}>
            {Object.entries({
              around1500: "1400–1599",
              below1500: "1200–1399",
              above1500: "1600–1799",
              all: "All ratings",
            }).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label><input type="checkbox" checked={allLegal} onChange={e => setAllLegal(e.target.checked)}/> All legal moves</label>
      <fieldset>
        <legend>Source arrows</legend>
        {Object.entries(sources).map(([k, v]) => (
          <label key={k}>
            <input
              type="checkbox"
              checked={!!enabled[k]}
              onChange={(e) =>
                setEnabled({ ...enabled, [k]: e.target.checked })
              }
            />
            {v}{" "}
          </label>
        ))}
      </fieldset>
      {Object.entries(replies).map(([k, r]) =>
        r.error ? (
          <p key={k} role="status">
            {sources[k]} · {r.error}{" "}
            <Button size="compact" variant="quiet"
              onClick={() => setRetry({ ...retry, [k]: (retry[k] || 0) + 1 })}
            >
              Retry
            </Button>
          </p>
        ) : null,
      )}
      {maia.data?.terminal && <p role="status">Maia · No legal moves in this position.</p>}
      {fish.data?.comparison_complete === false && (
        <p role="status">
          Stockfish could not finish a same-depth comparison of the pinned
          moves.
        </p>
      )}
      <div className="analysis-table">
        <table>
          <caption>
            Stockfish scores favor White when positive. Game results show White
            wins / draws / Black wins.
          </caption>
          <thead>
            <tr>
              <th>Move</th>
              <th>Pin</th>
              {Object.entries(sources).map(([k, v]) => (
                <th key={k}>
                  {v}
                  {(k === "rated" || k === "masters") && replies[k].data && (
                    <small> · {(replies[k].data.white + replies[k].data.draws + replies[k].data.black).toLocaleString()} games</small>
                  )}
                  {!replies[k].data && !replies[k].error ? " …" : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((move) => (
              <tr
                key={move}
                onMouseEnter={() => hover(move)}
                onMouseLeave={() => hover("")}
              >
                <th>
                  <Button size="compact" variant="quiet"
                    onFocus={() => hover(move)}
                    onBlur={() => hover("")}
                    onClick={() => play(move)}
                  >
                    {moves.get(move).san}
                  </Button>
                </th>
                <td>
                  <Button size="compact" variant="quiet"
                    aria-label={"Pin " + moves.get(move).san}
                    disabled={!pins.includes(move) && pins.length >= 16}
                    aria-pressed={pins.includes(move)}
                    onClick={() => togglePin(move)}
                  >
                    {pins.includes(move) ? "Pinned" : "Pin"}
                  </Button>
                </td>
                {Object.keys(sources).map((k) => (
                  <td key={k}>
                    {columns[k][move] || (k === "repertoire" && similar.has(move) ? "" : measurementText(null,replies[k]))}
                    {k === "repertoire" && similar.get(move)?.map(({ group, count, positions }) => (
                      <details key={group}>
                        <summary>{count} nearby ({group})</summary>
                        {positions.map((position) => <Nearby key={position.fen} position={position} orientation={origin.color || "white"} />)}
                      </details>
                    ))}
                    {overlay.some(
                      (arrow) => arrow.source === k && arrow.move === move,
                    ) && <span aria-label="Arrow shown"> ↗</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {book.data?.nearby && (
        <details>
          <summary>Nearby repertoire examples</summary>
          {Object.entries(book.data.nearby).map(([group, positions]) => (
            <div key={group}>
              <strong>
                {group === "current"
                  ? "Current repertoire"
                  : "Other repertoires"}
              </strong>
              {positions.map((p) => (
                <Nearby
                  key={p.fen}
                  position={p}
                  orientation={origin.color || "white"}
                />
              ))}
            </div>
          ))}
        </details>
      )}
    </section>
  );
}
function Nearby({ position, orientation }) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>{position.responses.map((r) => r.san).join(" / ")}</summary>
      {open && (
        <div className="gap-neighbor-board">
          <Board
            fen={position.fen}
            orientation={orientation}
            readOnly
            positionIdentity={position.fen}
            positionRevision={0}
          />
          <LichessControl fen={position.fen} orientation={orientation} />
        </div>
      )}
    </details>
  );
}
