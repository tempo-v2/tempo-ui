import React, { forwardRef, useMemo } from "react";
import { Board } from "@tempo-v2/core-components";
export const identity = (v) =>
  `${v.dataset_id}:${v.attempt_id}:${v.content_version}`;
export const turnFromFen = (fen) => fen.split(/\s+/)[1] === "b" ? "black" : "white";

export const StudyBoard = forwardRef(function StudyBoard(
  { view, locked, retainMoveOnLock, onMove },
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
  const turn = turnFromFen(view.display_fen);
  const demonstration = view.lesson?.move_uci ?? view.feedback?.correction_uci;
  const previous = view.lesson?.previous_move;
  return (
    <Board
      ref={ref}
      fen={view.display_fen}
      orientation={view.learner_color}
      turn={turn}
      check={view.in_check ? turn : false}
      mode="legal"
      destinations={destinations}
      positionIdentity={identity(view)}
      positionRevision={view.revision}
      locked={locked || view.status !== "ready"}
      retainMoveOnLock={retainMoveOnLock}
      coordinates="edges"
      maxSize={Number.MAX_SAFE_INTEGER}
      lastMove={previous ? [previous.slice(0, 2), previous.slice(2, 4)] : undefined}
      shapes={demonstration ? [{ orig: demonstration.slice(0, 2), dest: demonstration.slice(2, 4), brush: "blue" }] : undefined}
      onMove={onMove}
      ariaLabel="Study chessboard"
      ariaDescribedBy={view.status === "ready" ? "puzzle-turn" : undefined}
    />
  );
});
