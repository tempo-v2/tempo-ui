import React from "react";
import { Button } from "@tempo-v2/core-components";

export function MoveTrail({ line, index, onInspect, onReturn, disabled }) {
  const end = line.moves.length;
  const current = index ?? end;
  return (
    <section className="move-trail" aria-label="Revealed moves">
      <h3>Moves</h3>
      <div className="move-list">
        {line.moves.map(({ notation }, i) => (
          <Button key={i} disabled={disabled} aria-pressed={index === i + 1}
            onClick={() => onInspect(i + 1)}>{notation}</Button>
        ))}
      </div>
      <div className="actions">
        <Button disabled={disabled || index === 0} onClick={() => onInspect(0)}>Beginning</Button>
        <Button disabled={disabled || !current} onClick={() => onInspect(current - 1)}>Previous</Button>
        <Button disabled={disabled || current === end} onClick={() => onInspect(current + 1)}>Next move</Button>
        <Button disabled={disabled || index === end} onClick={() => onInspect(end)}>End</Button>
        {onReturn && index !== null && <Button disabled={disabled} onClick={onReturn}>Return to current position</Button>}
      </div>
    </section>
  );
}
