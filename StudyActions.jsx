import React from "react";
import { Button } from "@tempo-v2/core-components";

export function StudyActions({ view, state, actions, reproduced, stopped }) {
  const recoveryBlocked = state.issue?.startsWith("Recovery storage");
  if (!view && (!state.issue || recoveryBlocked) && !state.canRetry) return null;
  const disabled = state.busy || recoveryBlocked;
  const moreTactics = view?.learn_more_count ?? 10;
  return (
    <div className="actions">
      {state.canRetry ? (
        <Button variant="primary" onClick={actions.retry}>{state.retryingNext ? "Retry next exercise" : "Retry"}</Button>
      ) : state.issue === "refresh" ? (
        <Button disabled={state.busy} onClick={actions.refresh}>Refresh attempt</Button>
      ) : stopped ? (
        <Button variant="primary" disabled={disabled} onClick={actions.continue}>Continue study</Button>
      ) : view?.status === "ready" ? (
        <>
          {view.activity === "teach" ? (
            <Button variant="primary" disabled={disabled || !reproduced} onClick={actions.acknowledge}>
              Got it — continue
            </Button>
          ) : (
            <Button disabled={disabled || view.assessment !== null} onClick={actions.giveUp}>Show move</Button>
          )}
          <Button disabled={disabled} onClick={actions.skip}>Skip</Button>
          <Button disabled={disabled} onClick={actions.stop}>Stop</Button>
        </>
      ) : view?.status === "empty" && !view.done ? (
        <>
          <Button variant="primary" disabled={disabled} onClick={actions.resumeSkipped}>Resume skipped</Button>
          <Button disabled={disabled} onClick={actions.stop}>Stop</Button>
        </>
      ) : view?.status === "empty" ? (
        <>
          {view.can_practice_tactics && <Button disabled={disabled} onClick={actions.practiceTactics}>Practice tactics</Button>}
          {view.can_learn_more_tactics && (
            <Button disabled={disabled} onClick={actions.learnMoreTactics}>
              Learn up to {moreTactics} more {moreTactics === 1 ? "tactic" : "tactics"} today
            </Button>
          )}
          <Button disabled={disabled} onClick={actions.next}>Check again</Button>
        </>
      ) : (
        <>
          <Button variant="primary" disabled={disabled} onClick={actions.next}>
            {state.issue ? "Retry next exercise" : "Continue"}
          </Button>
          <Button disabled={disabled} onClick={actions.stop}>Stop</Button>
        </>
      )}
    </div>
  );
}
