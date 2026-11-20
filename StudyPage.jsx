import React, { useEffect, useState } from "react";
import { Button, Dialog, PageHeader, Surface, StatusNotice } from "@tempo-v2/core-components";
import { StudyBoard, studyOrientation, turnFromFen } from "./StudyBoard.jsx";
import { LichessControl } from "./LichessControl.jsx";
import { MoveTrail } from "./MoveTrail.jsx";
import { StudyProgress, useStudyProgress } from "./StudyProgress.jsx";
import { StudyOutcome } from "./StudyOutcome.jsx";
import { MoveFeedback } from "./MoveFeedback.jsx";
import { studyActionButtons } from "./StudyActions.jsx";
import { PromotionChooser } from "./PromotionChooser.jsx";
import { SMALL_READ_TIMEOUT_MS } from "./bounded_read.js";
import { postCommand } from "./content_transport.js";

export function StudyPage({
  view,
  state,
  keepMove,
  showSuccess,
  advancing,
  actions,
  guided,
  stopped,
  boardContinuation,
  reviewMark,
  reviewAddresses,
  onNavigate,
  boardRef,
  choice,
  onMove,
  onRejectedMove,
  flipped,
  historyIndex,
  historyLine,
  gameContext,
  onInspect,
  onFlip,
  dialog,
  setDialog,
  onOpenSettings,
  soundEnabled,
  onSoundChange,
  onChoose,
  onCancel,
}) {
  const attempt = view && !stopped && ["ready", "complete", "abandoned"].includes(view.status);
  const continuationBelowBoard = attempt && boardContinuation;
  const { continuation, others } = !advancing && historyIndex === null
    ? studyActionButtons({ view, state, actions, reproduced: !!guided?.uci, stopped })
    : {};
  const panelContinuation = !continuationBelowBoard && continuation;
  const lesson = view?.lesson;
  const inGameReplay = !!gameContext && historyIndex !== null;
  // The source is contiguous, so only a leading Black move needs its own number.
  const precedingMoves = gameContext?.line.moves.slice(0, -1).map(({ notation }, index) =>
    index === 0 ? notation : notation.replace(/^\d+\.\.\. /, ""));
  const { summary, unavailable, repairsRemaining } = useStudyProgress(view, stopped);
  const replayBlocked = state.busy || state.canRetry || !!choice || !!dialog;
  const canAnalyze = !!actions.analyze && attempt &&
    (view.status !== "abandoned" || (view.activity === "test" && view.assessment === "again"));
  const analysisBlocked = replayBlocked || advancing || state.refreshRequired || state.storageUnavailable;
  const title = attempt
    ? view.exercise_name ?? (view.corrective_repair ? "Opening move" :
      ({ teach: "Learn the move", test: "Find the move", practice: "Practice" })[view.activity])
    : stopped ? "Study paused" : "Study";
  const [selectionReason, setSelectionReason] = useState(null);
  const attemptId = attempt ? view.attempt_id : null;
  const datasetId = view?.dataset_id;
  useEffect(() => {
    if (!attemptId || !datasetId) return;
    const request = new AbortController();
    postCommand("/api/study/relevance", { dataset_id: datasetId, attempt_id: attemptId },
      request.signal, undefined, { timeoutMs: SMALL_READ_TIMEOUT_MS }).then(reply => {
      if (!request.signal.aborted && typeof reply?.reason === "string") {
        setSelectionReason({ attemptId, datasetId, text: reply.reason });
      }
    }).catch(() => {});
    return () => request.abort();
  }, [attemptId, datasetId]);
  return (
    <main className={`tempo-core study-layout${attempt ? " has-board" : ""}`}>
      {attempt && (
        <div className={`study-board${continuationBelowBoard ? " with-continuation" : ""}`}>
          <StudyBoard
            ref={boardRef}
            view={view}
            flipped={flipped}
            historyFen={historyIndex === null ? undefined : historyIndex === 0
              ? historyLine?.start_fen : historyLine?.moves[historyIndex - 1]?.fen}
            gameReplay={inGameReplay}
            gameDeviation={gameContext?.playedUci}
            guidedMove={guided?.uci}
            locked={
              state.busy ||
              state.canRetry ||
              state.refreshRequired || state.storageUnavailable ||
              historyIndex !== null || !!choice || !!dialog || !!guided?.uci
            }
            retainMoveOnLock={keepMove || !!choice || !!guided?.uci}
            onMove={onMove}
            onRejectedMove={onRejectedMove}
          />
          {showSuccess && (
            <div className={continuationBelowBoard ? "puzzle-success" : "exercise-success"} role="status">
              <span aria-hidden="true">✓</span>
              <span className="visually-hidden">Exercise complete</span>
            </div>
          )}
          {continuationBelowBoard && continuation && (
            <div className="study-continuation">{continuation}</div>
          )}
        </div>
      )}
      <aside className="study-panel" aria-label="Study information">
        <PageHeader title={title} />
        <Surface>
          {stopped ? (
            <>
              {view?.status === "empty" && <p>{view.outstanding} remaining today.</p>}
            </>
          ) : (
            <>
              {view?.corrective_repair && (
                <h2 className="correction-heading">
                  Repertoire correction{repairsRemaining !== null && ` (${repairsRemaining} remaining)`}
                </h2>
              )}
              {inGameReplay ? (
                <p className="puzzle-turn" role="status">Game replay</p>
              ) : (
                <div id="puzzle-turn" className="puzzle-turn" role="status">
                  {view?.status === "ready" &&
                    (turnFromFen(view.display_fen) === "white" ? "White to move" : "Black to move")}
                </div>
              )}
              {attempt && view.prompt?.decision_count > 1 &&
                <p className="move-progress">Move {view.prompt.decision_index + 1} of {view.prompt.decision_count}</p>}
              {attempt && selectionReason?.attemptId === attemptId && selectionReason.datasetId === datasetId &&
                <p className="game-source-note">{selectionReason.text}</p>}
              {lesson && (
                <div className="lesson">
                  {!inGameReplay && precedingMoves?.length > 0 && (
                    <p className="correction-context"><strong>Moves before the decision</strong><br />
                      {precedingMoves.join(" ")}
                    </p>
                  )}
                  {gameContext && <p>You played <strong>{gameContext.playedSan}</strong> in your game.
                    {" "}Your repertoire calls for <strong>{lesson.move_san}</strong>.</p>}
                  {!inGameReplay && (
                    <>
                      <p>Play <strong>{lesson.move_san}</strong> on the board.</p>
                      {lesson.comments.map((comment, index) => <p key={index}>{comment}</p>)}
                      {guided && (guided.uci
                        ? <p role="status">Move reproduced. Continue to save {view.corrective_repair ? "the correction" : "the lesson"}.</p>
                        : <StatusNotice>Try {lesson.move_san} again.</StatusNotice>)}
                    </>
                  )}
                  {view.corrective_repair &&
                    <p className="correction-allowance">Outside your daily allowance for new opening moves.</p>}
                </div>
              )}
              {!showSuccess && <StudyOutcome view={view} />}
              {view?.status === "abandoned" && <p>{view.activity === "test" && view.assessment === "again"
                ? "Review ended. Again was recorded." : "Exercise skipped."}</p>}
              {view?.status === "empty" && (
                <StatusNotice>
                  <div>{view.done ? "Done for today." : `${view.outstanding} remaining today.`}</div>
                  {view.corrective_recalls_remaining > 0 && (
                    <p>{view.corrective_recalls_remaining} corrective {view.corrective_recalls_remaining === 1 ? "recall" : "recalls"} still to complete.</p>
                  )}
                  {view.done && view.repertoire_remaining > 0 && (
                    <p>No more repertoire positions are available. Unused opening introductions: {view.repertoire_remaining}.</p>
                  )}
                  {view.done && view.tactics_remaining > 0 && (
                    <p>No more new tactics match your settings. Unused tactic introductions: {view.tactics_remaining}.</p>
                  )}
                </StatusNotice>
              )}
              <MoveFeedback view={view} />
              {historyLine && (!gameContext || inGameReplay) &&
                <MoveTrail line={historyLine} index={historyIndex} gameReplay={inGameReplay}
                  onInspect={onInspect} disabled={replayBlocked} onReturn={() => onInspect(null)} />}
            </>
          )}
          {view?.status === "error" && (
            <StatusNotice kind="error">{view.message}</StatusNotice>
          )}
          {state.issue && (
            <StatusNotice kind="error">{state.issue}</StatusNotice>
          )}
          {reviewMark && (
            <>
              <div className="actions">
                {reviewMark.pending ? (
                  <Button size="compact" disabled={reviewMark.busy} onClick={reviewMark.retry}>Retry saving for review</Button>
                ) : (
                  <>
                    {attempt && reviewAddresses.current && (
                      <Button key={JSON.stringify(reviewAddresses.current)} size="compact"
                        disabled={reviewMark.busy || !!choice || !!dialog || historyIndex !== null}
                        onClick={() => void reviewMark.send(reviewAddresses.current)}>Review later</Button>
                    )}
                    {!stopped && reviewAddresses.previous && (
                      <Button key={JSON.stringify(reviewAddresses.previous)} size="compact" disabled={reviewMark.busy || !!choice || !!dialog}
                        onClick={() => void reviewMark.send(reviewAddresses.previous)}>Save previous response</Button>
                    )}
                  </>
                )}
              </div>
              {reviewMark.message && <StatusNotice kind={reviewMark.message.error ? "error" : undefined}>
                {reviewMark.message.text}
              </StatusNotice>}
            </>
          )}
          {(panelContinuation || others) && (
            <div className="actions">{panelContinuation}{others}</div>
          )}
          {canAnalyze && (
            <div className="actions study-analysis-actions">
              {historyIndex === null &&
                <Button size="compact" disabled={analysisBlocked} onClick={actions.analyze}>Analyze</Button>}
              {inGameReplay
                ? <LichessControl fen={gameContext.line.start_fen} line={gameContext.line}
                    orientation={studyOrientation(view.learner_color, flipped)} />
                : <LichessControl disabled={analysisBlocked} onClick={actions.analyzeInLichess} />}
            </div>
          )}
          {gameContext && (
            <div className="actions game-replay-links">
              {!inGameReplay &&
                <Button size="compact" disabled={replayBlocked}
                  onClick={() => onInspect(gameContext.line.moves.length)}>Replay game</Button>}
              {onNavigate && gameContext.url && <a href={gameContext.url} target="_blank" rel="noopener noreferrer">
                Open original game
              </a>}
            </div>
          )}
        </Surface>
        <StudyProgress summary={summary} unavailable={unavailable} />
        {onNavigate && (
          <nav className="study-navigation" aria-label="Tempo sections">
            <Button size="compact" disabled={!view?.dataset_id || state.busy || state.canRetry || reviewMark?.busy || !!choice || !!dialog}
              onClick={() => onNavigate("saved-reviews")}>Saved for review</Button>
            <Button size="compact" disabled={state.busy || state.canRetry || !!choice} onClick={() => onNavigate("repertoires")}>
              Repertoires
            </Button>
            <Button size="compact" disabled={state.busy || state.canRetry || !!choice} onClick={() => onNavigate("tactics")}>
              Tactics
            </Button>
            <Button size="compact" disabled={state.busy || state.canRetry || !!choice} onClick={() => onNavigate("games")}>
              Games
            </Button>
          </nav>
        )}
        <div className="actions study-board-controls" aria-label="Board controls" role="group">
          {attempt && <Button size="compact" disabled={!!choice} onClick={onFlip}>Flip board</Button>}
          <Button size="compact" aria-pressed={soundEnabled} onClick={() => onSoundChange(!soundEnabled)}>
            {soundEnabled ? "Mute board" : "Unmute board"}
          </Button>
          <Button size="compact" disabled={replayBlocked || advancing || reviewMark?.busy}
            onClick={onOpenSettings}>Settings</Button>
          <Button size="compact" onClick={() => setDialog("help")}>Shortcuts</Button>
        </div>
      </aside>
      {dialog?.kind === "analysis" && (
        <Dialog open title="Analyze this review?" onClose={() => setDialog(null)}>
          <p>{dialog.assessment === "again"
            ? "Again is already recorded for this review. Opening analysis will end the attempt."
            : "Opening analysis will end this review and record it as Again."}</p>
          <div className="actions">
            <Button onClick={() => setDialog(null)}>Cancel</Button>
            <Button variant="primary" onClick={actions.confirmAnalysis}>
              {dialog.assessment === "again" ? "End review and analyze" : "Record Again and analyze"}
            </Button>
          </div>
        </Dialog>
      )}
      {dialog === "help" && <Dialog open title="Keyboard shortcuts" onClose={() => setDialog(null)}>
        <dl className="shortcut-list">
          <dt>Enter</dt><dd>Primary study action</dd>
          <dt>F</dt><dd>Flip the board</dd>
          <dt>?</dt><dd>Open shortcuts</dd>
          <dt>← / →</dt><dd>Previous or next revealed position</dd>
          <dt>Home / End</dt><dd>Beginning or end of revealed moves</dd>
          <dt>R</dt><dd>Return to the live position</dd>
          <dt>Escape</dt><dd>Close the dialog</dd>
        </dl>
        <Button onClick={() => setDialog(null)}>Close</Button>
      </Dialog>}
      <PromotionChooser
        choice={choice}
        onChoose={onChoose}
        onCancel={onCancel}
      />
    </main>
  );
}
