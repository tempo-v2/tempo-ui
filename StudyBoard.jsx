import React, { forwardRef, useMemo } from "react";
import { Chess } from "chess.js";
import { playBoardMove } from "./board_move.js";
import { TempoBoard as Board } from "./board_preferences.jsx";
export const identity = (v) =>
  `${v.dataset_id}:${v.attempt_id}:${v.content_version}`;
export const turnFromFen = (fen) => fen.split(/\s+/)[1] === "b" ? "black" : "white";
export const studyOrientation = (color, flipped) =>
  flipped ? (color === "white" ? "black" : "white") : color;

export const StudyBoard = forwardRef(function StudyBoard(
  { view, locked, retainMoveOnLock, onMove, onRejectedMove, flipped, historyFen, guidedMove, gameReplay, gameDeviation },
  ref,
) {
  const destinations = useMemo(() => {
    const m = new Map();
    for (const uci of view.legal_moves) {
      const a = uci.slice(0, 2),
        b = uci.slice(2, 4);
      if (!m.has(a)) m.set(a, []);
      if (!m.get(a).includes(b)) m.get(a).push(b);
    }
    return m;
  }, [view.legal_moves]);
  const previewFen = useMemo(() => {
    if (!guidedMove) return null;
    const position = new Chess(view.display_fen);
    playBoardMove(position, guidedMove);
    return position.fen();
  }, [guidedMove, view.display_fen]);
  const fen = historyFen ?? previewFen ?? view.display_fen;
  const turn = turnFromFen(fen);
  const demonstration = view.lesson?.move_uci ?? view.feedback?.correction_uci;
  const lastMove = guidedMove || view.lesson?.previous_move;
  const arrows = [];
  if (!historyFen && !previewFen) {
    if (gameDeviation) {
      const sameSquares = gameDeviation.slice(0, 4) === demonstration?.slice(0, 4);
      arrows.push({
        orig: gameDeviation.slice(0, 2), dest: gameDeviation.slice(2, 4), brush: "red",
        ...(sameSquares && { modifiers: { lineWidth: 18 } }),
      });
    }
    if (demonstration) {
      arrows.push({
        orig: demonstration.slice(0, 2), dest: demonstration.slice(2, 4), brush: "blue",
      });
    }
  }
  return (
    <Board
      ref={ref}
      fen={fen}
      readOnly={!!historyFen}
      orientation={studyOrientation(view.learner_color, flipped)}
      turn={turn}
      check={!historyFen && !previewFen && view.in_check ? turn : false}
      mode="legal"
      destinations={destinations}
      positionIdentity={historyFen ? `${identity(view)}:history:${historyFen}` : identity(view)}
      positionRevision={view.revision}
      locked={locked || view.status !== "ready"}
      retainMoveOnLock={!historyFen && retainMoveOnLock}
      coordinates="edges"
      maxSize={Number.MAX_SAFE_INTEGER}
      lastMove={!historyFen && lastMove ? [lastMove.slice(0, 2), lastMove.slice(2, 4)] : undefined}
      shapes={arrows}
      onMove={onMove}
      onRejectedMove={onRejectedMove}
      ariaLabel={gameReplay ? "Game replay chessboard" : "Study chessboard"}
      ariaDescribedBy={!historyFen && view.status === "ready" ? "puzzle-turn" : undefined}
    />
  );
});
