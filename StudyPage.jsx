import React from "react";
import { Button, PageHeader, Surface, StatusNotice } from "@tempo-v2/core-components";
import { StudyBoard, turnFromFen } from "./StudyBoard.jsx";
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
  boardRef,
  choice,
  onMove,
  onChoose,
  onCancel,
}) {
  const attempt = view && !stopped && ["ready", "complete", "abandoned"].includes(view.status);
  const lesson = view?.lesson;
  return (
    <main className={`tempo-core study-layout${attempt ? " has-board" : ""}`}>
      {attempt && (
        <div className="study-board">
          <StudyBoard
            ref={boardRef}
            view={view}
            locked={
              state.busy ||
              state.canRetry ||
              state.issue === "refresh" ||
              !!choice || !!guided?.uci
            }
            retainMoveOnLock={keepMove || !!choice || !!guided?.uci}
            onMove={onMove}
          />
          {showSuccess && (
            <div className="puzzle-success" role="status">
              <span aria-hidden="true">✓</span>
              <span className="visually-hidden">Puzzle solved</span>
            </div>
          )}
        </div>
      )}
      <aside className="study-panel" aria-label="Study information">
        <PageHeader title="Study" actions={
          <Button disabled={state.busy || state.canRetry || !!choice} onClick={onRepertoires}>
            Repertoires
          </Button>
        } />
        <Surface>
          {stopped ? (
            <>
              <p>Study paused.</p>
              {view?.outstanding > 0 && <p>{view.outstanding} remaining today.</p>}
            </>
          ) : (
            <>
              <div id="puzzle-turn" className="puzzle-turn" role="status">
                {view?.status === "ready" &&
                  (turnFromFen(view.display_fen) === "white" ? "White to move" : "Black to move")}
              </div>
              {attempt && <p>{view.repertoire_name ?? "Tactics"}</p>}
              {lesson && (
                <div className="lesson">
                  <h2>Learn this move</h2>
                  <p>Play <strong>{lesson.move_san}</strong> on the board.</p>
                  {lesson.comments.map((comment, index) => <p key={index}>{comment}</p>)}
                  {guided && (guided.uci
                    ? <p role="status">Move reproduced. Acknowledge to complete the lesson.</p>
                    : <StatusNotice>Follow the arrow and try {lesson.move_san}.</StatusNotice>)}
                </div>
              )}
              {view?.status === "complete" && !showSuccess && (
                <p role="status">{view.activity === "teach"
                  ? "Lesson complete. Your first review is due tomorrow."
                  : view.assessment === "again" ? "Review recorded as Again." : "Review complete."}</p>
              )}
              {view?.status === "abandoned" && <p>Exercise skipped.</p>}
              {view?.status === "empty" && (
                <StatusNotice>
                  {view.done ? "Done for today." : `${view.outstanding} remaining today.`}
                  {view.done && view.repertoire_remaining > 0 && (
                    <p>No more repertoire positions are available. Unused opening introductions: {view.repertoire_remaining}.</p>
                  )}
                </StatusNotice>
              )}
              <MoveFeedback view={view} />
            </>
          )}
          {view?.status === "error" && (
            <StatusNotice kind="error">{view.message}</StatusNotice>
          )}
          {state.issue && state.issue !== "refresh" && (
            <StatusNotice kind="error">{state.issue}</StatusNotice>
          )}
          {!showSuccess && !advancing && (
            <StudyActions view={view} state={state} actions={actions} reproduced={!!guided?.uci} stopped={stopped} />
          )}
        </Surface>
      </aside>
      <PromotionChooser
        choice={choice}
        onChoose={onChoose}
        onCancel={onCancel}
      />
    </main>
  );
}
