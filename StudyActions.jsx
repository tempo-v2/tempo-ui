import React from "react";
import { Button } from "@tempo-v2/core-components";

export function StudyActions({ view, state, actions, reproduced, stopped }) {
  const recoveryBlocked = state.issue?.startsWith("Recovery storage");
  if (!view && (!state.issue || recoveryBlocked) && !state.canRetry) return null;
  const disabled = state.busy || recoveryBlocked;
  return (
    <div className="actions">
      {state.canRetry ? (
        <Button variant="primary" onClick={actions.retry}>Retry</Button>
      ) : state.issue === "refresh" ? (
        <Button disabled={state.busy} onClick={actions.refresh}>Refresh attempt</Button>
      ) : stopped ? (
        <Button variant="primary" disabled={disabled} onClick={actions.continue}>Continue study</Button>
      ) : view?.status === "ready" ? (
        <>
          {view.activity === "teach" ? (
            <Button variant="primary" disabled={disabled || !reproduced} onClick={actions.acknowledge}>
              Acknowledge lesson
            </Button>
          ) : (
            <Button disabled={disabled || view.assessment !== null} onClick={actions.giveUp}>Give up</Button>
          )}
          <Button disabled={disabled} onClick={actions.skip}>Skip</Button>
          <Button disabled={disabled} onClick={actions.stop}>Stop</Button>
        </>
      ) : view?.status === "empty" && !view.done ? (
        <>
          <Button variant="primary" disabled={disabled} onClick={actions.resumeSkipped}>Resume skipped</Button>
          <Button disabled={disabled} onClick={actions.stop}>Stop</Button>
        </>
      ) : (
        <Button variant="primary" disabled={disabled} onClick={actions.next}>
          {view?.status === "empty" ? "Check again" : "Next"}
        </Button>
      )}
    </div>
  );
}
