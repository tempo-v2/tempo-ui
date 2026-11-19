import React, { useEffect, useState } from "react";
import { Button, Dialog, PageHeader, Surface, StatusNotice } from "@tempo-v2/core-components";
import { StudyBoard, turnFromFen } from "./StudyBoard.jsx";
import { MoveTrail } from "./MoveTrail.jsx";
import { StudyProgress, useStudyProgress } from "./StudyProgress.jsx";
import { StudyOutcome } from "./StudyOutcome.jsx";
import { BoardPreferences } from "./BoardPreferences.jsx";
import { MoveFeedback } from "./MoveFeedback.jsx";
import { StudyActions } from "./StudyActions.jsx";
import { PromotionChooser } from "./PromotionChooser.jsx";

export function StudyPage({
  view,
  state,
  keepMove,
  showSuccess,
  advancing,
  actions,
  guided,
  stopped,
  onRepertoires,
  onTactics,
  onGames,
  boardRef,
  choice,
  onMove,
  onRejectedMove,
  prefs,
  flipped,
  historyIndex,
  historyLine,
  gameContext,
  onInspect,
  onFlip,
  dialog,
  setDialog,
  onPrefsChange,
  soundEnabled,
  onSoundChange,
  onChoose,
  onCancel,
}) {
  const attempt = view && !stopped && ["ready", "complete", "abandoned"].includes(view.status);
  const lesson = view?.lesson;
  const inGameReplay = !!gameContext && historyIndex !== null;
  // The source is contiguous, so only a leading Black move needs its own number.
  const precedingMoves = gameContext?.line.moves.slice(0, -1).map(({ notation }, index) =>
    index === 0 ? notation : notation.replace(/^\d+\.\.\. /, ""));
  const { summary, unavailable, repairsRemaining } = useStudyProgress(view, stopped);
  const replayBlocked = state.busy || state.canRetry || !!choice || !!dialog;
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
    fetch("/api/study/relevance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataset_id: datasetId, attempt_id: attemptId }),
      signal: request.signal,
    }).then(reply => reply.ok ? reply.json() : null).then(reply => {
      if (!request.signal.aborted && typeof reply?.reason === "string") {
        setSelectionReason({ attemptId, datasetId, text: reply.reason });
      }
    }).catch(() => {});
    return () => request.abort();
  }, [attemptId, datasetId]);
  return (
    <main className={`tempo-core study-layout${attempt ? " has-board" : ""}`}>
      {attempt && (
        <div className="study-board">
          <StudyBoard
            ref={boardRef}
            view={view}
            prefs={prefs}
            flipped={flipped}
            historyFen={historyIndex === null ? undefined : historyIndex === 0
              ? historyLine?.start_fen : historyLine?.moves[historyIndex - 1]?.fen}
            gameReplay={inGameReplay}
            gameDeviation={gameContext?.playedUci}
            guidedMove={view.corrective_repair ? guided?.uci : undefined}
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
            <div className="exercise-success" role="status">
              <span aria-hidden="true">✓</span>
              <span className="visually-hidden">Exercise complete</span>
            </div>
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
          {!advancing && historyIndex === null && (
            <StudyActions view={view} state={state} actions={actions} reproduced={!!guided?.uci} stopped={stopped} />
          )}
          {attempt && historyIndex === null &&
            (view.status !== "abandoned" || (view.activity === "test" && view.assessment === "again")) && (
            <Button size="compact" disabled={replayBlocked || advancing || state.refreshRequired || state.storageUnavailable}
              onClick={actions.analyze}>Analyze</Button>
          )}
          {gameContext && (
            <div className="actions game-replay-links">
              {!inGameReplay &&
                <Button size="compact" disabled={replayBlocked}
                  onClick={() => onInspect(gameContext.line.moves.length)}>Replay game</Button>}
              {gameContext.url && <a href={gameContext.url} target="_blank" rel="noopener noreferrer">
                Open original game
              </a>}
            </div>
          )}
        </Surface>
        <StudyProgress summary={summary} unavailable={unavailable} />
        <nav className="study-navigation" aria-label="Tempo sections">
          <Button size="compact" disabled={state.busy || state.canRetry || !!choice} onClick={onRepertoires}>
            Repertoires
          </Button>
          <Button size="compact" disabled={state.busy || state.canRetry || !!choice} onClick={onTactics}>
            Tactics
          </Button>
          <Button size="compact" disabled={state.busy || state.canRetry || !!choice} onClick={onGames}>
            Games
          </Button>
        </nav>
        <div className="actions study-board-controls" aria-label="Board controls" role="group">
          {attempt && <Button size="compact" disabled={!!choice} onClick={onFlip}>Flip board</Button>}
          <Button size="compact" aria-pressed={soundEnabled} onClick={() => onSoundChange(!soundEnabled)}>
            {soundEnabled ? "Mute board" : "Unmute board"}
          </Button>
          <Button size="compact" onClick={() => setDialog("preferences")}>Board preferences</Button>
          <Button size="compact" onClick={() => setDialog("help")}>Shortcuts</Button>
        </div>
      </aside>
      {dialog === "analysis" && (
        <Dialog open title="Analyze this review?" onClose={() => setDialog(null)}>
          <p>{view.assessment === "again"
            ? "Again is already recorded for this review. Opening analysis will end the attempt."
            : "Opening analysis will end this review and record it as Again."}</p>
          <div className="actions">
            <Button onClick={() => setDialog(null)}>Cancel</Button>
            <Button variant="primary" onClick={actions.confirmAnalysis}>
              {view.assessment === "again" ? "End review and analyze" : "Record Again and analyze"}
            </Button>
          </div>
        </Dialog>
      )}
      <BoardPreferences dialog={dialog === "analysis" ? null : dialog} onClose={() => setDialog(null)} prefs={prefs}
        onChange={onPrefsChange} soundEnabled={soundEnabled} onSoundChange={onSoundChange} />
      <PromotionChooser
        choice={choice}
        onChoose={onChoose}
        onCancel={onCancel}
      />
    </main>
  );
}
