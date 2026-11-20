import React, { forwardRef, useMemo } from "react";
import { MainBoard } from "./MainBoard.jsx";
import { Chess } from "chess.js";
import { playBoardMove } from "./board_move.js";
export const identity = (v) =>
  `${v.dataset_id}:${v.attempt_id}:${v.content_version}`;
export const turnFromFen = (fen) => fen.split(/\s+/)[1] === "b" ? "black" : "white";
export const studyOrientation = (color, flipped) =>
  flipped ? (color === "white" ? "black" : "white") : color;

export const StudyBoard = forwardRef(function StudyBoard(
  { view, leadIn, locked, retainMoveOnLock, onMove, onRejectedMove, prefs, flipped, historyFen, guidedMove, gameReplay, gameDeviation },
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
  const fen = historyFen ?? leadIn?.before_fen ?? previewFen ?? view.display_fen;
  const turn = turnFromFen(fen);
  const demonstration = view.lesson?.move_uci ?? view.feedback?.correction_uci;
  const opponentMove = view.opponent_move?.uci;
  const lastMove = guidedMove || opponentMove;
  const arrows = [];
  if (!historyFen && !previewFen && !leadIn) {
    if (opponentMove) {
      arrows.push({
        orig: opponentMove.slice(0, 2), dest: opponentMove.slice(2, 4), brush: "red",
      });
    }
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
    <MainBoard
      ref={ref}
      fen={fen}
      readOnly={!!historyFen}
      orientation={studyOrientation(view.learner_color, flipped)}
      theme={prefs?.theme}
      pieceSet={prefs?.pieceSet}
      turn={turn}
      check={!historyFen && !previewFen && !leadIn && view.in_check ? turn : false}
      mode="legal"
      destinations={destinations}
      positionIdentity={historyFen ? `${identity(view)}:history:${historyFen}` : identity(view)}
      positionRevision={view.revision}
      locked={locked || !!leadIn || view.status !== "ready"}
      retainMoveOnLock={!historyFen && retainMoveOnLock}
      coordinates="edges"
      maxSize={Number.MAX_SAFE_INTEGER}
      lastMove={!historyFen && !leadIn && lastMove ? [lastMove.slice(0, 2), lastMove.slice(2, 4)] : undefined}
      shapes={arrows}
      onMove={onMove}
      onRejectedMove={onRejectedMove}
      ariaLabel={gameReplay ? "Game replay chessboard" : "Study chessboard"}
      ariaDescribedBy={!historyFen && view.status === "ready" ? "puzzle-turn" : undefined}
    />
  );
});
