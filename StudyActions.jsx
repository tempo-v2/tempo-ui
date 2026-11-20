import React from "react";
import { Button } from "@tempo-v2/core-components";

export function studyActionButtons({ view, state, actions, reproduced, stopped }) {
  const recoveryBlocked = state.storageUnavailable;
  if (!view && (state.busy || recoveryBlocked)) return {};
  const disabled = state.busy || recoveryBlocked;
  const stop = <Button disabled={disabled} onClick={actions.stop}>Stop</Button>;

  if (state.canRetry) return {
    continuation: <Button variant="primary" onClick={actions.retry}>{state.retryingNext ? "Retry next exercise" : "Retry"}</Button>,
  };
  if (state.refreshRequired) return {
    continuation: <Button disabled={state.busy} onClick={actions.refresh}>Refresh attempt</Button>,
  };
  if (stopped) return {
    continuation: <Button variant="primary" disabled={disabled} onClick={actions.continue}>Continue study</Button>,
  };
  if (view?.status === "ready") {
    const teaching = view.activity === "teach";
    return {
      continuation: teaching && (
        <Button variant="primary" disabled={disabled || !reproduced} onClick={actions.acknowledge}>
          Got it — continue
        </Button>
      ),
      others: <>
        {!teaching && <Button disabled={disabled || view.assessment !== null} onClick={actions.giveUp}>Show move</Button>}
        <Button disabled={disabled} onClick={actions.skip}>Skip</Button>
        {stop}
      </>,
    };
  }
  if (view?.status === "empty" && !view.done) return {
    continuation: state.passiveSummary
      ? <Button variant="primary" disabled={disabled} onClick={actions.next}>Continue study</Button>
      : <Button variant="primary" disabled={disabled} onClick={actions.resumeSkipped}>Resume skipped</Button>,
    others: stop,
  };
  if (view?.status === "empty") {
    return {
      others: <>
        {view.can_practice_tactics && <Button disabled={disabled} onClick={actions.practiceTactics}>Practice tactics</Button>}
        {view.can_learn_more_tactics && (
          <Button disabled={disabled} onClick={actions.learnMoreTactics}>
            Learn more tactics today
          </Button>
        )}
        <Button disabled={disabled} onClick={actions.next}>Check again</Button>
      </>,
    };
  }
  return {
    continuation: (
      <Button variant="primary" disabled={disabled} onClick={actions.next}>
        {view ? "Continue" : "Check again"}
      </Button>
    ),
    others: stop,
  };
}
