import React, { useMemo } from "react";
import { lichessAnalysis } from "./lichess_analysis.js";

export function LichessControl({ fen, line, orientation, scope, onClick, disabled }) {
  const destination = useMemo(() => fen ? lichessAnalysis(fen, line, orientation) : null,
    [fen, line, orientation]);
  const label = scope === "issued_move" ? "Analyze issued move in Lichess"
    : line ? "Analyze line in Lichess"
    : fen ? "Analyze position in Lichess" : "Analyze in Lichess";
  const text = <><span aria-hidden="true">↗</span> Lichess</>;
  if (onClick) return <button className="lichess-link" type="button" aria-label={label}
    disabled={disabled} onClick={onClick}>{text}</button>;
  if (!destination) return null;
  return <span className="lichess-controls">
    <a className="lichess-link" aria-label={destination.downloadPgn ? "Open Lichess for PGN import" : label}
      href={destination.href} target="_blank" rel="noopener noreferrer">{text}</a>
    {scope === "issued_move" && <small>Issued move only</small>}
    {destination.downloadPgn && <>
      <a download="tempo-line.pgn"
        href={"data:application/x-chess-pgn;charset=utf-8," + encodeURIComponent(destination.downloadPgn)}>Download PGN</a>
      <small>Import the PGN in Lichess to see the full line.</small>
    </>}
  </span>;
}
