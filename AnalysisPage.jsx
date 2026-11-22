import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MainBoard } from "./MainBoard.jsx";
import { Button, IconButton, PageHeader, StatusNotice } from "@tempo-v2/core-components";
import { PreviousIcon } from "./ControlIcons.jsx";
import { Chess } from "chess.js";
import { PromotionChooser } from "./PromotionChooser.jsx";
import { moveArrow as shape } from "./move_evidence.js";
import { playBoardMove } from "./board_move.js";
import { MarkedLinesForm, MarkedLinesSaveButton, useMarkedLines } from "./MarkedLinesForm.jsx";
import { LichessControl } from "./LichessControl.jsx";
import { boardWithLeadIn, lineFromBoard } from "./lichess_analysis.js";
import { usePageExitGuard } from "./page_exit_guard.js";

const start = new Chess().fen();
export function AnalysisPage({ origin, onClose, interruption, renderRootLineAction, cardDetails }) {
  const root = origin.fen || start;
  const [path, setPath] = useState([]);
  const [paths, setPaths] = useState([[]]);
  const [choice, setChoice] = useState(null);
  const boardInput = useRef(null);
  const draft = useMarkedLines(origin, root);
  const interrupted = !!interruption;
  useEffect(() => {
    if (interrupted) {
      setChoice(null);
    }
  }, [interrupted]);
  const { color, locked, destination } = draft;
  const hasMarkedLines = draft.marked.length > 0;
  const discardMarkedLines = useCallback(() => {
    return !hasMarkedLines || window.confirm("Discard marked lines and leave analysis?");
  }, [hasMarkedLines]);
  usePageExitGuard(locked, discardMarkedLines);
  const authoring = !!destination || !!origin.newBook;
  const board = useMemo(() => {
    const b = new Chess(root);
    for (const m of path) playBoardMove(b, m);
    return b;
  }, [root, path]);
  const fen = board.fen();
  const exportLine = useMemo(() => {
    if (origin.anchorRoute?.length) {
      const anchored = boardWithLeadIn(root, origin.anchorRoute);
      for (const uci of path) playBoardMove(anchored, uci);
      return lineFromBoard(anchored);
    }
    return lineFromBoard(board);
  }, [board, path, root, origin.anchorRoute]);
  const moves = useMemo(
    () => new Map(board.moves({ verbose: true }).map((m) => [m.lan, m])),
    [board],
  );
  const dests = new Map();
  for (const m of moves.values())
    dests.set(m.from, [...new Set([...(dests.get(m.from) || []), m.to])]);
  const key = path.join(" ");
  function navigate(p) {
    setPath(p);
    setChoice(null);
  }
  function play(m) {
    if (locked || !moves.has(m)) return;
    const next = [...path, m];
    setPaths((old) =>
      old.some((p) => p.join(" ") === next.join(" ")) ? old : [...old, next],
    );
    navigate(next);
  }
  function close() {
    if (!locked && discardMarkedLines()) onClose(draft.saved);
  }
  const arrows = new Map();
  if (!path.length)
    for (const [m, c] of [
      [origin.prescribedUci, "green"],
      [origin.playedUci, "red"],
    ])
      if (moves.has(m)) arrows.set(m, shape(m, c));
  const tree = useMemo(() => {
    const tree = new Map([["", { label: "Starting position" }]]);
    for (const p of paths) {
      const id = p.join(" ");
      if (!id) continue;
      const parent = tree.get(p.slice(0, -1).join(" "));
      const b = new Chess(parent.fen || root);
      const m = playBoardMove(b, p.at(-1));
      tree.set(id, { label: m.san, fen: b.fen() });
    }
    return tree;
  }, [root, paths]);
  function lineLabel(p) {
    return p
      .map((_, i) => tree.get(p.slice(0, i + 1).join(" ")).label)
      .join(" ");
  }
  const header = (
    <PageHeader title="Analysis board" actions={
      <Button disabled={locked} onClick={close}>Return</Button>
    } />
  );
  if (interrupted) return (
    <main className="tempo-core analysis-page">
      {header}
      {interruption}
      {draft.issue && <StatusNotice kind="error">{draft.issue}</StatusNotice>}
      {draft.pending && <MarkedLinesSaveButton draft={draft} />}
      {draft.notice && <StatusNotice>{draft.notice}</StatusNotice>}
    </main>
  );
  return (
    <main className="tempo-core analysis-page">
      {header}
      <div className="analysis-layout">
        <section>
          <div className="analysis-board-frame desktop-board-frame">
            <MainBoard
              ref={boardInput}
              fen={fen}
              turn={board.turn() === "w" ? "white" : "black"}
              orientation={color}
              mode="legal"
              locked={locked || !!choice}
              destinations={dests}
              coordinates="edges"
              positionIdentity={fen}
              positionRevision={path.length}
              shapes={[...arrows.values()]}
              ariaLabel="Analysis board"
              onMove={(e) => {
                if (
                  e.positionIdentity !== fen ||
                  e.positionRevision !== path.length
                )
                  return;
                const base = e.from + e.to;
                if (moves.has(base)) play(base);
                else {
                  const roles = [...moves.keys()]
                    .filter((m) => m.startsWith(base))
                    .map((m) => m[4]);
                  if (roles.length) setChoice({ base, moves: roles });
                }
              }}
            />
          </div>
          {!path.length && (
            <p>
              {[
                [
                  origin.prescribedUci,
                  "Issued Study move",
                ],
                [origin.playedUci, "Played"],
              ]
                .filter(([m]) => moves.has(m))
                .map(([m, l]) => l + " · " + moves.get(m).san)
                .join("　")}
            </p>
          )}
          <div className="actions">
            {!path.length && renderRootLineAction
              ? renderRootLineAction(fen, color)
              : <LichessControl fen={fen} line={exportLine} orientation={color} />}
            <IconButton
              label="Back one move"
              disabled={locked || !path.length}
              onClick={() => navigate(path.slice(0, -1))}
            >
              <PreviousIcon />
            </IconButton>
            <select
              aria-label="Variation"
              disabled={locked}
              value={key}
              onChange={(e) =>
                navigate(e.target.value.split(" ").filter(Boolean))
              }
            >
              {paths.map((p) => (
                <option key={p.join(" ")} value={p.join(" ")}>
                  {lineLabel(p) || "Starting position"}
                </option>
              ))}
            </select>
          </div>
          {cardDetails}
          {authoring && (
            <MarkedLinesForm draft={draft} path={path} lineLabel={lineLabel} />
          )}
        </section>
      </div>
      <PromotionChooser
        choice={choice}
        onChoose={(c, r) => play(c.base + r)}
        onCancel={() => {
          setChoice(null);
          boardInput.current?.clearInput();
        }}
      />
    </main>
  );
}
