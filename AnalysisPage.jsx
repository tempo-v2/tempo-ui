import React, { useMemo, useRef, useState } from "react";
import { Board, Button, PageHeader } from "@tempo-v2/core-components";
import { Chess } from "chess.js";
import { AnalysisEvidence } from "./AnalysisEvidence.jsx";
import { PromotionChooser } from "./PromotionChooser.jsx";
import { playBoardMove } from "./board_move.js";
import { MarkedLinesForm, useMarkedLines } from "./MarkedLinesForm.jsx";
import { LichessControl } from "./LichessControl.jsx";
import { boardWithLeadIn, lineFromBoard } from "./lichess_analysis.js";

const start = new Chess().fen();
const colors = {
  repertoire: "green",
  stockfish: "blue",
  rated: "yellow",
  masters: "red",
  maia: "maia",
};
const shape = (move, brush) => ({
  orig: move.slice(0, 2),
  dest: move.slice(2, 4),
  brush,
});

export function AnalysisPage({ origin, onClose, renderRootLineAction }) {
  const root = origin.fen || start;
  const [path, setPath] = useState([]);
  const [paths, setPaths] = useState([[]]);
  const [pins, setPins] = useState({});
  const [overlay, setOverlay] = useState([]);
  const [hover, setHover] = useState("");
  const [choice, setChoice] = useState(null);
  const boardInput = useRef(null);
  const draft = useMarkedLines(origin, root);
  const { color, locked, destination } = draft;
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
    setHover("");
    setOverlay([]);
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
    if (
      !locked &&
      (!draft.marked.length ||
        window.confirm("Discard marked lines and leave analysis?"))
    )
      onClose(draft.saved);
  }
  const arrows = new Map();
  for (const { move, source } of overlay)
    if (moves.has(move)) arrows.set(move, shape(move, colors[source]));
  if (!path.length)
    for (const [m, c] of [
      [origin.prescribedUci, "green"],
      [origin.playedUci, "red"],
    ])
      if (moves.has(m)) arrows.set(m, shape(m, c));
  for (const m of pins[fen] || []) arrows.set(m, shape(m, "green"));
  if (moves.has(hover)) arrows.set(hover, shape(hover, "blue"));
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
  return (
    <main className="tempo-core analysis-page">
      <PageHeader
        title="Analysis board"
        actions={
          <Button disabled={locked} onClick={close}>
            Return
          </Button>
        }
      />
      <div className="analysis-layout">
        <section>
          <Board
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
            <Button
              disabled={locked || !path.length}
              onClick={() => navigate(path.slice(0, -1))}
            >
              Back one move
            </Button>
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
          {authoring && (
            <MarkedLinesForm draft={draft} path={path} lineLabel={lineLabel} />
          )}
        </section>
        <AnalysisEvidence
          fen={fen}
          bookRevision={draft.revision}
          origin={{ ...origin, color, repertoireId: destination }}
          moves={moves}
          pins={pins[fen] || []}
          togglePin={(m) =>
            setPins({
              ...pins,
              [fen]: pins[fen]?.includes(m)
                ? pins[fen].filter((x) => x !== m)
                : [...(pins[fen] || []), m],
            })
          }
          play={play}
          hover={setHover}
          onOverlay={setOverlay}
        />
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
