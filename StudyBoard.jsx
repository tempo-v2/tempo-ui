import React, { forwardRef, useMemo } from "react";
import { Chess } from "chess.js";
import { playBoardMove } from "./board_move.js";
import { Board } from "@tempo-v2/core-components";
export const identity = (v) =>
  `${v.dataset_id}:${v.attempt_id}:${v.content_version}`;
export const turnFromFen = (fen) => fen.split(/\s+/)[1] === "b" ? "black" : "white";

export const StudyBoard = forwardRef(function StudyBoard(
  { view, locked, retainMoveOnLock, onMove, onRejectedMove, prefs, flipped, historyFen, guidedMove, gameReplay },
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
  return (
    <Board
      ref={ref}
      fen={fen}
      readOnly={!!historyFen}
      orientation={flipped ? (view.learner_color === "white" ? "black" : "white") : view.learner_color}
      theme={prefs?.theme}
      pieceSet={prefs?.pieceSet}
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
      shapes={!historyFen && !previewFen && demonstration ? [{ orig: demonstration.slice(0, 2), dest: demonstration.slice(2, 4), brush: "blue" }] : undefined}
      onMove={onMove}
      onRejectedMove={onRejectedMove}
      ariaLabel={gameReplay ? "Game replay chessboard" : "Study chessboard"}
      ariaDescribedBy={!historyFen && view.status === "ready" ? "puzzle-turn" : undefined}
    />
  );
});
