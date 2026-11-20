import React, { useCallback, useEffect, useRef, useState } from "react";
import { createStudyController } from "./study_controller.js";
import { StudyPage } from "./StudyPage.jsx";
import { identity, studyOrientation } from "./StudyBoard.jsx";
import { promotionRoles } from "./promotion_roles.js";
import { completedReviewAddress, studyReviewAddresses, useReviewMark } from "./saved_review_commands.js";
import { createBoardSounds, learnerCue, replyCue } from "./board_sounds.js";

import { studyTransport } from "./study_transport.js";
import { useStudyGameContext } from "./study_game_context.js";
import { canAutoAdvance } from "./StudyOutcome.jsx";
import { loadBoardPreferences, saveBoardPreferences } from "./BoardPreferences.jsx";
import { closeReservedLichessTab, reserveLichessTab } from "./lichess_analysis.js";

const REPLY_DELAY_MS = 200;
const NEXT_EXERCISE_DELAY_MS = 500;

// Reply versions can change independently of the pending command format.
const storage = {
  load: () =>
    JSON.parse(sessionStorage.getItem("tempo-study-recovery-v4") || "null"),
  save: (e) =>
    sessionStorage.setItem("tempo-study-recovery-v4", JSON.stringify(e)),
};
export function App({ initialPage = "study", renderSection, renderAnalysis, transport = studyTransport, boardContinuation, navigateSection, subscribeNavigation }) {
  const [model, setModel] = useState({ view: null, state: { busy: true } }),
    [choice, setChoice] = useState(null),
    [page, setPage] = useState(initialPage),
    [stopped, setStopped] = useState(false),
    [guided, setGuided] = useState(null);
  const [prefs, setPrefs] = useState(loadBoardPreferences);
  const [flipped, setFlipped] = useState(false);
  const [history, setHistory] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [lichessLaunch, setLichessLaunch] = useState(null);
  const lichessReservation = useRef(null);
  const cancelLichessLaunch = useCallback(() => {
    closeReservedLichessTab(lichessReservation.current?.tab);
    lichessReservation.current = null;
    setLichessLaunch(null);
  }, []);
  useEffect(() => {
    window.addEventListener("pagehide", cancelLichessLaunch);
    return () => {
      window.removeEventListener("pagehide", cancelLichessLaunch);
      closeReservedLichessTab(lichessReservation.current?.tab);
      lichessReservation.current = null;
    };
  }, [cancelLichessLaunch]);
  const [sounds] = useState(() => createBoardSounds(prefs.volume));
  const [soundEnabled, setSoundEnabled] = useState(sounds.enabled);
  const studyVisit = useRef(0);
  const reviewMark = useReviewMark();
  const lastCompleted = useRef(null);
  const board = useRef(null),
    controller = useRef(null),
    choiceRef = useRef(null),
    preview = useRef(null),
    replyTimer = useRef(null),
    advanced = useRef(null),
    pausedAdvance = useRef(null);
  if (!controller.current)
    controller.current = createStudyController({
      transport,
      storage,
      makeSubmissionId: () => crypto.randomUUID(),
      render: (view, state) => {
        if (view?.status === "complete") lastCompleted.current = completedReviewAddress(view);
        const move = preview.current;
        if (state.busy || !move) {
          setModel({ view, state, keepMove: state.busy && !!move });
          return;
        }
        preview.current = null;
        if (view === move.view) board.current?.clearInput();
        const replies = view !== move.view && view?.feedback?.correct ? view.feedback.autoplay : [];
        const showResult = () => {
          replyTimer.current = null;
          setModel({ view, state, keepMove: false });
          if (sounds.enabled && replies.length && studyVisit.current === move.studyVisit) {
            sounds.play(replyCue(move.view.display_fen, move.uci, replies));
          }
        };
        // The renderer has already moved the learner's piece. Give that move
        // time to land before reconciling with the FEN that includes the reply.
        const elapsed = performance.now() - move.startedAt;
        if (replies.length && elapsed < REPLY_DELAY_MS) {
          replyTimer.current = setTimeout(showResult, REPLY_DELAY_MS - elapsed);
        } else {
          showResult();
        }
      },
    });
  useEffect(() => {
    void sounds.prepare();
    if (page === "study") controller.current.start().catch(() => {});
    return () => {
      clearTimeout(replyTimer.current);
      sounds.cancel();
    };
  }, []);
  useEffect(() => {
    const v = model.view;
    if (
      choiceRef.current &&
      (!v ||
        v.status !== "ready" ||
        model.state.busy ||
        model.state.canRetry ||
        identity(v) !== choiceRef.current.id ||
        v.revision !== choiceRef.current.revision)
    ) {
      choiceRef.current = null;
      setChoice(null);
    }
  }, [model.view, model.state.canRetry, model.state.busy]);

  const { view, state } = model;
  const reviewAddresses = studyReviewAddresses(view, lastCompleted.current);
  const studying = page === "study" && !state.analysis;
  const readyRepair = studying && !stopped && view?.status === "ready" && view.corrective_repair;
  const gameContext = useStudyGameContext(view?.dataset_id, readyRepair ? view.attempt_id : null);
  const historyLine = gameContext?.line ?? view?.history;
  const inspecting = history?.view === view;
  useEffect(() => { setHistory(null); }, [view]);
  const autoAdvance = studying && !stopped && !dialog && !inspecting && canAutoAdvance(view?.status, view?.activity, view?.assessment) &&
    !state.busy && !state.canRetry && !state.refreshRequired && !state.storageUnavailable && advanced.current !== view && pausedAdvance.current !== view;
  useEffect(() => {
    if (!autoAdvance) return;
    const timer = setTimeout(() => {
      const current = controller.current.getState();
      if (current.analysis || current.view !== view || current.busy || current.canRetry || current.refreshRequired || current.storageUnavailable || pausedAdvance.current === view) return;
      advanced.current = view;
      controller.current.next().catch(() => {});
    }, NEXT_EXERCISE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [autoAdvance, view]);

  const run = (fn) => () => {
    if (replyTimer.current !== null) return;
    choiceRef.current = null;
    setChoice(null);
    fn().catch(() => {});
  };
  function openInLichess(address, enter) {
    const study = controller.current;
    const current = study.getState();
    if (current.busy || current.canRetry || current.refreshRequired || current.storageUnavailable ||
        current.analysis || !Object.entries(address).every(([key, value]) => current.view?.[key] === value)) return;
    const orientation = studyOrientation(current.view.learner_color, flipped);
    cancelLichessLaunch();
    const reservation = { tab: reserveLichessTab(), orientation };
    lichessReservation.current = reservation;
    const cancelReservation = () => {
      if (lichessReservation.current === reservation) cancelLichessLaunch();
    };
    void enter(address).then(() => {
      if (lichessReservation.current !== reservation) return;
      const visit = study.getState().analysis;
      if (visit && visit.dataset_id === address.dataset_id && visit.attempt_id === address.attempt_id &&
          visit.content_version === address.content_version) {
        setLichessLaunch({ ...reservation, visit });
      } else cancelReservation();
    }).catch(cancelReservation);
  }
  function analyze(inLichess) {
    pausedAdvance.current = view;
    board.current?.clearInput();
    const { dataset_id, attempt_id, content_version, revision } = view;
    const address = { dataset_id, attempt_id, content_version, revision };
    if (view.status === "ready" && view.activity === "test")
      openDialog({ kind: "analysis", address, assessment: view.assessment, inLichess });
    else if (inLichess) openInLichess(address, controller.current.openAnalysis);
    else void controller.current.openAnalysis(address).catch(() => {});
  }
  const actions = {
    analyze: renderAnalysis ? () => analyze(false) : undefined,
    analyzeInLichess: renderAnalysis ? () => analyze(true) : undefined,
    confirmAnalysis: () => {
      if (dialog?.kind !== "analysis") return;
      setDialog(null);
      if (dialog.inLichess) openInLichess(dialog.address, controller.current.concedeForAnalysis);
      else void controller.current.concedeForAnalysis(dialog.address).catch(() => {});
    },
    next: run(() => {
      pausedAdvance.current = view;
      return controller.current.next();
    }),
    skip: run(async () => {
      pausedAdvance.current = view;
      const skipped = await controller.current.skip();
      if (skipped?.status === "abandoned") await controller.current.next();
    }),
    stop: run(async () => {
      pausedAdvance.current = view;
      setGuided(null);
      setStopped(true);
      await controller.current.studyStatus();
    }),
    continue: run(async () => {
      const next = await controller.current.next();
      if (next && next.status !== "error") setStopped(false);
    }),
    giveUp: run(() => controller.current.giveUp()),
    resumeSkipped: run(() => controller.current.resumeSkipped()),
    practiceTactics: run(() => controller.current.practiceTactics()),
    learnMoreTactics: run(() => controller.current.learnMoreTactics()),
    acknowledge: run(() => controller.current.acknowledge(guided?.uci)),
    retry: run(async () => {
      const retryingNext = controller.current.getState().retryingNext;
      const result = await controller.current.retry();
      if (retryingNext && result && result.status !== "error") setStopped(false);
    }),
    refresh: run(() => controller.current.refresh()),
  };
  function openDialog(value) {
    if (value) pausedAdvance.current = view;
    setDialog(value);
  }
  function inspect(index) {
    if (index !== null) pausedAdvance.current = view;
    board.current?.clearInput();
    setHistory(index === null ? null : { view, index });
  }
  const onFlip = () => {
    board.current?.clearInput();
    setFlipped(value => !value);
  };
  useEffect(() => {
    if (!studying) return;
    function shortcut(event) {
      if (event.defaultPrevented || event.repeat || event.isComposing || event.altKey ||
          event.ctrlKey || event.metaKey || (event.shiftKey && event.key !== "?") ||
          event.target?.closest?.("input, textarea, select, [contenteditable], a") ||
          choiceRef.current || dialog) return;
      const current = controller.current.getState();
      if (event.key === "?") openDialog("help");
      else if (event.key.toLowerCase() === "f" && view?.attempt_id && !stopped) onFlip();
      else if (historyLine && !stopped && !current.busy && !current.canRetry &&
          ["ArrowLeft", "ArrowRight", "Home", "End", "r", "R"].includes(event.key)) {
        const end = historyLine.moves.length;
        const index = inspecting ? history.index : end - Number(!!gameContext);
        if (event.key.toLowerCase() === "r") inspect(null);
        else if (event.key === "Home") inspect(0);
        else if (event.key === "End") inspect(end);
        else if (event.key === "ArrowLeft") inspect(Math.max(0, index - 1));
        else inspect(Math.min(end, index + 1));
      }
      else if (event.key === "Enter" && !event.target?.closest?.("button") && current.view === view && !current.busy &&
          !current.canRetry && !current.refreshRequired && !current.storageUnavailable && !stopped && !autoAdvance && !inspecting) {
        if (view?.status === "ready" && view.activity === "teach" && guided?.view === view && guided.uci)
          actions.acknowledge();
        else if (["complete", "abandoned"].includes(view?.status)) actions.next();
        else return;
      } else return;
      event.preventDefault();
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  });
  function submit(view, uci) {
    if (sounds.enabled) sounds.play(learnerCue(view.display_fen, uci));
    if (view.activity === "teach") {
      if (uci !== view.lesson.move_uci) {
        board.current?.clearInput();
        setGuided({ view, uci: null });
        return;
      }
      setGuided({ view, uci });
      return;
    }
    preview.current = { view, uci, studyVisit: studyVisit.current, startedAt: performance.now() };
    controller.current.answer(uci).catch(() => {});
  }
  function currentMoveView(event) {
    const snapshot = controller.current.getState();
    const v = snapshot.view,
      state = snapshot;
    if (
      !v ||
      v.status !== "ready" ||
      dialog || inspecting || snapshot.analysis ||
      state.busy ||
      state.canRetry ||
      state.refreshRequired || state.storageUnavailable ||
      (guided?.view === v && guided.uci) ||
      choiceRef.current ||
      replyTimer.current !== null ||
      event.positionIdentity !== identity(v) ||
      event.positionRevision !== v.revision
    )
      return null;
    return v;
  }
  function onMove(event) {
    const v = currentMoveView(event);
    if (!v) return;
    const base = event.from + event.to;
    const moves = v.legal_moves.filter((m) => m.startsWith(base));
    if (!moves.length) {
      board.current?.clearInput();
      sounds.play("illegal");
      return;
    }
    const promotions = moves.filter((m) => m.length === 5);
    if (promotions.length) {
      const origin = {
        id: identity(v),
        revision: v.revision,
        base,
        moves: promotions.map((m) => m[4]),
      };
      choiceRef.current = origin;
      setChoice(origin);
      return;
    }
    submit(v, base);
  }
  function onRejectedMove(event) {
    if (currentMoveView(event)) sounds.play("illegal");
  }
  function onChoose(origin, role) {
    const snapshot = controller.current.getState();
    const v = snapshot.view,
      state = snapshot;
    if (
      choiceRef.current !== origin ||
      !v ||
      v.status !== "ready" ||
      dialog ||
      state.busy ||
      state.canRetry ||
      state.refreshRequired || state.storageUnavailable ||
      identity(v) !== origin.id ||
      v.revision !== origin.revision ||
      !v.legal_moves.includes(origin.base + role)
    )
      return;
    choiceRef.current = null;
    setChoice(null);
    board.current?.previewPromotion(origin.base.slice(2), promotionRoles[role].toLowerCase());
    submit(v, origin.base + role);
  }
  function goTo(nextPage) {
    cancelLichessLaunch();
    if (nextPage === "saved-reviews" || (page === "saved-reviews" && nextPage === "study")) {
      // The list is a read. Preserve the Study visit and any reproduced lesson.
      pausedAdvance.current = view;
      setPage(nextPage);
      return;
    }
    pausedAdvance.current = view;
    studyVisit.current += 1;
    setDialog(null);
    setHistory(null);
    choiceRef.current = null;
    setChoice(null);
    sounds.cancel();
    setGuided(null);
    setStopped(false);
    navigateSection?.(nextPage);
    setPage(nextPage);
    if (nextPage === "study") controller.current.start().catch(() => {});
  }
  useEffect(() => subscribeNavigation?.(page, nextPage => {
    if (nextPage === "games") cancelLichessLaunch();
    setPage(nextPage);
    if (nextPage === "study") controller.current.start().catch(() => {});
  }), [cancelLichessLaunch, page, subscribeNavigation]);
  if (page !== "study") return renderSection(page, goTo, view?.dataset_id);
  if (state.analysis && renderAnalysis)
    return renderAnalysis(state.analysis, state.issue, () => {
      cancelLichessLaunch();
      return controller.current.closeAnalysis().catch(() => {});
    }, lichessLaunch?.visit === state.analysis ? lichessLaunch : null);

  return (
    <StudyPage
      {...model}
      showSuccess={autoAdvance && view.activity === "test"}
      advancing={state.busy && advanced.current === view}
      actions={actions}
      guided={guided?.view === view ? guided : null}
      stopped={stopped}
      boardContinuation={boardContinuation}
      reviewMark={reviewMark}
      reviewAddresses={reviewAddresses}
      onNavigate={renderSection ? goTo : undefined}
      boardRef={board}
      choice={choice}
      onMove={onMove}
      onRejectedMove={onRejectedMove}
      prefs={prefs}
      flipped={flipped}
      historyIndex={inspecting ? history.index : null}
      historyLine={historyLine}
      gameContext={gameContext}
      onInspect={inspect}
      onFlip={onFlip}
      dialog={dialog}
      setDialog={openDialog}
      onPrefsChange={changes => {
        const next = { ...prefs, ...changes };
        setPrefs(next);
        saveBoardPreferences(next);
        sounds.setVolume(next.volume);
      }}
      soundEnabled={soundEnabled}
      onSoundChange={enabled => {
        sounds.setEnabled(enabled);
        setSoundEnabled(enabled);
      }}
      onChoose={onChoose}
      onCancel={() => {
        choiceRef.current = null;
        setChoice(null);
        board.current?.clearInput();
      }}
    />
  );
}
