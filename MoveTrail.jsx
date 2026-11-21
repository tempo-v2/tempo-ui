import React from "react";
import { Button, IconButton } from "@tempo-v2/core-components";
import { FirstIcon, LastIcon, NextIcon, PreviousIcon } from "./ControlIcons.jsx";

export function MoveTrail({ line, index, onInspect, onReturn, disabled, shortcuts, gameReplay = false }) {
  const end = line.moves.length;
  const current = index ?? end;
  const returnLabel = gameReplay ? "Return to exercise" : "Return to current position";
  return (
    <section className="move-trail" aria-label={gameReplay ? "Game moves" : "Revealed moves"}>
      <h3>{gameReplay ? "Game moves" : "Moves"}</h3>
      <div className="move-list">
        {line.moves.map(({ notation }, i) => (
          <Button key={i} disabled={disabled} aria-pressed={index === i + 1}
            onClick={() => onInspect(i + 1)}>{notation}</Button>
        ))}
      </div>
      <div className="actions move-trail-actions">
        <div className="compact-controls" role="group" aria-label="Replay controls">
          <IconButton label="Beginning" tooltip="Go to the starting position" shortcut={shortcuts?.beginning}
            disabled={disabled || index === 0} onClick={() => onInspect(0)}><FirstIcon /></IconButton>
          <IconButton label="Previous" tooltip="Previous move" shortcut={shortcuts?.previous}
            disabled={disabled || !current} onClick={() => onInspect(current - 1)}><PreviousIcon /></IconButton>
          <IconButton label="Next move" shortcut={shortcuts?.next}
            disabled={disabled || current === end} onClick={() => onInspect(current + 1)}><NextIcon /></IconButton>
          <IconButton label="End" tooltip="Go to the last revealed move" shortcut={shortcuts?.end}
            disabled={disabled || index === end} onClick={() => onInspect(end)}><LastIcon /></IconButton>
        </div>
        {onReturn && index !== null &&
          <Button disabled={disabled} onClick={onReturn} tooltip={shortcuts ? returnLabel : undefined}
            shortcut={shortcuts?.returnToPosition}>{returnLabel}</Button>}
      </div>
    </section>
  );
}
