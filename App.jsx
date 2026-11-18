import React, { useEffect, useRef, useState } from "react";
import { createStudyController } from "./study_controller.js";
import { StudyPage } from "./StudyPage.jsx";
import { identity } from "./StudyBoard.jsx";
import { promotionRoles } from "./promotion_roles.js";
import { RepertoiresPage } from "./RepertoiresPage.jsx";
import { hasPendingRepertoireCommand } from "./repertoire_commands.js";
import { TacticsCapturePage } from "./TacticsCapturePage.jsx";
import { hasPendingTacticCommand } from "./tactic_commands.js";

const REPLY_DELAY_MS = 200;
const NEXT_PUZZLE_DELAY_MS = 500;

const storage = {
  load: () =>
    JSON.parse(sessionStorage.getItem("tempo-study-recovery-v4") || "null"),
  save: (e) =>
    sessionStorage.setItem("tempo-study-recovery-v4", JSON.stringify(e)),
};
const transport = {
  async send(command) {
    const response = await fetch("/api/study", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command),
    });
    if (!response.ok) throw new Error(`Server returned ${response.status}`);
    return response.json();
  },
};
function initialPage() {
  if (hasPendingRepertoireCommand()) return "repertoires";
  if (hasPendingTacticCommand()) return "capture";
  return "study";
}

export function App() {
  const [model, setModel] = useState({ view: null, state: { busy: false } }),
    [choice, setChoice] = useState(null),
    [page, setPage] = useState(initialPage),
    [stopped, setStopped] = useState(false),
    [guided, setGuided] = useState(null);
  const board = useRef(null),
    controller = useRef(null),
    choiceRef = useRef(null),
    preview = useRef(null),
    replyTimer = useRef(null),
    advanced = useRef(null);
  if (!controller.current)
    controller.current = createStudyController({
      transport,
      storage,
      makeSubmissionId: () => crypto.randomUUID(),
      render: (view, state) => {
        const move = preview.current;
        if (state.busy || !move) {
          setModel({ view, state, keepMove: state.busy && !!move });
          return;
        }
        preview.current = null;
        if (view === move.view) board.current?.clearInput();
        const showResult = () => {
          replyTimer.current = null;
          setModel({ view, state, keepMove: false });
        };
        // The renderer has already moved the learner's piece. Give that move
        // time to land before reconciling with the FEN that includes the reply.
        const elapsed = performance.now() - move.startedAt;
        if (view !== move.view && view?.feedback?.correct &&
            view.feedback.autoplay.length && elapsed < REPLY_DELAY_MS) {
          replyTimer.current = setTimeout(showResult, REPLY_DELAY_MS - elapsed);
        } else {
          showResult();
        }
      },
    });
  useEffect(() => {
    if (page === "study") controller.current.start().catch(() => {});
    return () => clearTimeout(replyTimer.current);
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
  const showSuccess = page === "study" && !stopped && view?.status === "complete" &&
    view.activity !== "teach" && !view.repertoire_name && view.feedback?.correct &&
    !state.busy && !state.canRetry && !state.issue && advanced.current !== view;
  useEffect(() => {
    if (!showSuccess) return;
    const timer = setTimeout(() => {
      const current = controller.current.getState();
      if (current.view !== view || current.busy || current.canRetry || current.issue) return;
      advanced.current = view;
      controller.current.next().catch(() => {});
    }, NEXT_PUZZLE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [showSuccess, view]);

  const run = (fn) => () => {
    if (replyTimer.current !== null) return;
    choiceRef.current = null;
    setChoice(null);
    fn().catch(() => {});
  };
  const actions = {
    next: run(() => controller.current.next()),
    skip: run(async () => {
      const skipped = await controller.current.skip();
      if (skipped?.status === "abandoned") await controller.current.next();
    }),
    stop: run(async () => {
      setGuided(null);
      setStopped(true);
      await controller.current.studyStatus();
    }),
    continue: run(async () => {
      await controller.current.next();
      setStopped(false);
    }),
    giveUp: run(() => controller.current.giveUp()),
    resumeSkipped: run(() => controller.current.resumeSkipped()),
    practiceTactics: run(() => controller.current.practiceTactics()),
    learnMoreTactics: run(() => controller.current.learnMoreTactics()),
    acknowledge: run(() => controller.current.acknowledge(guided?.uci)),
    retry: run(() => controller.current.retry()),
    refresh: run(() => controller.current.refresh()),
  };
  function submit(view, uci) {
    if (view.activity === "teach") {
      if (uci !== view.lesson.move_uci) {
        board.current?.clearInput();
        setGuided({ view, uci: null });
        return;
      }
      setGuided({ view, uci });
      return;
    }
    preview.current = { view, startedAt: performance.now() };
    controller.current.answer(uci).catch(() => {});
  }
  function onMove(event) {
    const snapshot = controller.current.getState();
    const v = snapshot.view,
      state = snapshot;
    if (
      !v ||
      v.status !== "ready" ||
      state.busy ||
      state.canRetry ||
      state.issue === "refresh" ||
      (guided?.view === v && guided.uci) ||
      choiceRef.current ||
      replyTimer.current !== null ||
      event.positionIdentity !== identity(v) ||
      event.positionRevision !== v.revision
    )
      return;
    const base = event.from + event.to;
    const moves = v.legal_moves.filter((m) => m.startsWith(base));
    if (!moves.length) {
      board.current?.clearInput();
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
  function onChoose(origin, role) {
    const snapshot = controller.current.getState();
    const v = snapshot.view,
      state = snapshot;
    if (
      choiceRef.current !== origin ||
      !v ||
      v.status !== "ready" ||
      state.busy ||
      state.canRetry ||
      state.issue === "refresh" ||
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
    setGuided(null);
    setStopped(false);
    setPage(nextPage);
    if (nextPage === "study") controller.current.start().catch(() => {});
  }
  if (page === "repertoires") return <RepertoiresPage onStudy={() => goTo("study")} />;
  if (page === "capture")
    return <TacticsCapturePage datasetId={view?.dataset_id} onStudy={() => goTo("study")} />;

  return (
    <StudyPage
      {...model}
      showSuccess={showSuccess}
      advancing={state.busy && advanced.current === view}
      actions={actions}
      guided={guided?.view === view ? guided : null}
      stopped={stopped}
      onRepertoires={() => goTo("repertoires")}
      onTacticCapture={() => goTo("capture")}
      boardRef={board}
      choice={choice}
      onMove={onMove}
      onChoose={onChoose}
      onCancel={() => {
        choiceRef.current = null;
        setChoice(null);
        board.current?.clearInput();
      }}
    />
  );
}
