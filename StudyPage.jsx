import React, { useEffect, useState } from "react";
import { Button, PageHeader, Surface, StatusNotice } from "@tempo-v2/core-components";
import { StudyBoard, turnFromFen } from "./StudyBoard.jsx";
import { MoveTrail } from "./MoveTrail.jsx";
import { StudyProgress } from "./StudyProgress.jsx";
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
              ? view.history.start_fen : view.history.moves[historyIndex - 1]?.fen}
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
        <PageHeader title="Study" actions={
          <div className="study-navigation">
            <Button disabled={state.busy || state.canRetry || !!choice} onClick={onRepertoires}>
              Repertoires
            </Button>
            <Button disabled={state.busy || state.canRetry || !!choice} onClick={onTactics}>
              Tactics
            </Button>
            <Button disabled={state.busy || state.canRetry || !!choice} onClick={onGames}>
              Games
            </Button>
          </div>
        } />
        <div className="actions">
          {attempt && <Button disabled={!!choice} onClick={onFlip}>Flip board</Button>}
          <Button aria-pressed={soundEnabled} onClick={() => onSoundChange(!soundEnabled)}>
            {soundEnabled ? "Mute board" : "Unmute board"}
          </Button>
          <Button onClick={() => setDialog("preferences")}>Board preferences</Button>
          <Button onClick={() => setDialog("help")}>Shortcuts</Button>
        </div>
        <StudyProgress view={view} stopped={stopped} />
        <Surface>
          {stopped ? (
            <>
              <p>Study paused.</p>
              {view?.status === "empty" && <p>{view.outstanding} remaining today.</p>}
            </>
          ) : (
            <>
              <div id="puzzle-turn" className="puzzle-turn" role="status">
                {view?.status === "ready" &&
                  (turnFromFen(view.display_fen) === "white" ? "White to move" : "Black to move")}
              </div>
              {attempt && <p>{({ teach: "Teach", test: "Test", practice: "Practice" })[view.activity]}
                {view.exercise_name && ` · ${view.exercise_name}`}
                {view.prompt && ` · Move ${view.prompt.decision_index + 1} of ${view.prompt.decision_count}`}</p>}
              {attempt && selectionReason?.attemptId === attemptId && selectionReason.datasetId === datasetId &&
                <p className="game-source-note">{selectionReason.text}</p>}
              {lesson && (
                <div className="lesson">
                  {view.corrective_repair && <strong>Game correction</strong>}
                  <h2>Learn this move</h2>
                  <p>Play <strong>{lesson.move_san}</strong> on the board.</p>
                  {lesson.comments.map((comment, index) => <p key={index}>{comment}</p>)}
                  {guided && (guided.uci
                    ? <p role="status">Move reproduced. Continue to save {view.corrective_repair ? "the repair" : "the lesson"}.</p>
                    : <StatusNotice>Follow the arrow and try {lesson.move_san}.</StatusNotice>)}
                </div>
              )}
              {!showSuccess && <StudyOutcome view={view} />}
              {view?.status === "abandoned" && <p>Exercise skipped.</p>}
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
              {view?.history && <MoveTrail line={view.history} index={historyIndex}
                onInspect={onInspect} disabled={state.busy || state.canRetry || !!choice || !!dialog}
                onReturn={() => onInspect(null)} />}
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
        </Surface>
      </aside>
      <BoardPreferences dialog={dialog} onClose={() => setDialog(null)} prefs={prefs}
        onChange={onPrefsChange} soundEnabled={soundEnabled} onSoundChange={onSoundChange} />
      <PromotionChooser
        choice={choice}
        onChoose={onChoose}
        onCancel={onCancel}
      />
    </main>
  );
}
