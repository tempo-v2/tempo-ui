import React from "react";
import { Button } from "@tempo-v2/core-components";

export function studyActionButtons({ view, state, actions, reproduced, stopped, primaryShortcut }) {
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
        <Button variant="primary" disabled={disabled || !reproduced} onClick={actions.acknowledge}
          tooltip={primaryShortcut && "Save this lesson and continue"} shortcut={primaryShortcut}>
          Got it — continue
        </Button>
      ),
      others: <>
        {!teaching && <Button disabled={disabled || view.assessment !== null} onClick={actions.giveUp}>Show move</Button>}
        <Button disabled={disabled} onClick={actions.skip}>
          Skip
        </Button>
        {stop}
      </>,
    };
  }
  if (view?.status === "empty" && !view.done) return {
    continuation: <Button variant="primary" disabled={disabled} onClick={actions.resumeSkipped}>Resume skipped</Button>,
    others: stop,
  };
  if (view?.status === "empty") return {
    others: <Button disabled={disabled} onClick={actions.next}>Check again</Button>,
  };
  return {
    continuation: (
      <Button variant="primary" disabled={disabled} onClick={actions.next}
        tooltip={primaryShortcut && "Continue to the next exercise"} shortcut={primaryShortcut}>
        {view ? "Continue" : "Check again"}
      </Button>
    ),
    others: stop,
  };
}
