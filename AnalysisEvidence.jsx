import { Board } from "@tempo-v2/core-components";
import React, { useEffect, useState } from "react";
import { candidateMoves, engineCells, explorerCells, probabilityCells } from "./move_evidence.js";
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
    [move, cell.text + (withResults && cell.text !== "0 games" ? " games · " + cell.results : "")]));
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
  const columns = {
    repertoire: Object.fromEntries([...Object.keys(repertoire), ...similar.keys()].map((m) => [m, repertoire[m]])),
    stockfish: labels(engineCells(fen, fish.data)),
    rated: labels(explorerCells(rapid.data), true),
    masters: labels(explorerCells(masters.data), true),
    maia: labels(probabilityCells(maia.data)),
  };
  const overlay = Object.keys(sources).flatMap((source) =>
    enabled[source]
      ? Object.keys(columns[source])
          .slice(0, 3)
          .map((move) => ({ move, source }))
      : [],
  );
  const overlayKey = JSON.stringify(overlay);
  useEffect(() => {
    onOverlay(overlay);
  }, [fen, overlayKey]);
  const rows = candidateMoves(moves, [pins, ...Object.values(columns).map(Object.keys), [...moves.keys()]]);
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
            <button
              onClick={() => setRetry({ ...retry, [k]: (retry[k] || 0) + 1 })}
            >
              Retry
            </button>
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
                  <button
                    onFocus={() => hover(move)}
                    onBlur={() => hover("")}
                    onClick={() => play(move)}
                  >
                    {moves.get(move).san}
                  </button>
                </th>
                <td>
                  <button
                    aria-label={"Pin " + moves.get(move).san}
                    disabled={!pins.includes(move) && pins.length >= 16}
                    aria-pressed={pins.includes(move)}
                    onClick={() => togglePin(move)}
                  >
                    {pins.includes(move) ? "Pinned" : "Pin"}
                  </button>
                </td>
                {Object.keys(sources).map((k) => (
                  <td key={k}>
                    {columns[k][move] || (k === "repertoire" && similar.has(move) ? "" : "—")}
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
        </div>
      )}
    </details>
  );
}
