import React, { useMemo, useRef, useState } from "react";
import { MainBoard } from "./MainBoard.jsx";
import { Button, StatusNotice, Surface } from "@tempo-v2/core-components";
import { lineFromBoard } from "./board_move.js";
import { PromotionChooser } from "./PromotionChooser.jsx";
import { turnFromFen } from "./StudyBoard.jsx";
import { TacticPositionEditor } from "./TacticPositionEditor.jsx";
import { appendCaptureSan, captureBoard, capturePgn, startingFen } from "./tactic_builder.js";

export function TacticBuilder({ locked, canSave, saving, onSave }) {
  const [root, setRoot] = useState(startingFen);
  const [editing, setEditing] = useState(false);
  const [moves, setMoves] = useState([]);
  const [san, setSan] = useState("");
  const [issue, setIssue] = useState(null);
  const [promotion, setPromotion] = useState(null);
  const boardInput = useRef(null);
  const board = useMemo(() => captureBoard(root, moves), [root, moves]);
  const line = useMemo(() => lineFromBoard(board), [board]);
  const { destinations, legal } = useMemo(() => {
    const destinations = new Map();
    const legal = new Set();
    for (const move of board.moves({ verbose: true })) {
      legal.add(move.lan);
      if (!destinations.has(move.from)) destinations.set(move.from, []);
      const squares = destinations.get(move.from);
      if (!squares.includes(move.to)) squares.push(move.to);
    }
    return { destinations, legal };
  }, [board]);
  const fen = board.fen();
  const turn = turnFromFen(fen);
  const id = `${root}:${moves.join(" ")}`;

  function applyPosition(next) {
    if (next !== root) {
      setRoot(next);
      setMoves([]);
      setSan("");
      setIssue(null);
    }
    setEditing(false);
  }

  function play(uci) {
    if (locked || !legal.has(uci)) return;
    setMoves(current => current === moves ? [...current, uci] : current);
    setPromotion(null);
    setIssue(null);
  }

  function moveOnBoard(event) {
    if (locked || event.positionIdentity !== id || event.positionRevision !== moves.length) return;
    const base = event.from + event.to;
    if (legal.has(base)) play(base);
    else {
      const roles = [...legal].filter(move => move.startsWith(base)).map(move => move[4]);
      if (roles.length) setPromotion({ base, moves: roles });
    }
  }

  function addSan(event) {
    event.preventDefault();
    if (locked || promotion) return;
    try {
      setMoves(appendCaptureSan(root, moves, san));
      setSan("");
      setIssue(null);
    } catch (error) {
      setIssue(error.message);
    }
  }

  return (
    <Surface>
      {editing ? <TacticPositionEditor fen={root} hasSolution={moves.length > 0 || !!san.trim()}
        locked={locked} onApply={applyPosition} onCancel={() => setEditing(false)} /> : <>
        <div className="tactic-builder-layout repertoire-form">
          <div className="capture-edit-position">
            <Button disabled={locked} onClick={() => setEditing(true)}>Edit board or enter FEN</Button>
          </div>
          <div className="capture-board-column">
            <div className="desktop-board-frame">
              <MainBoard ref={boardInput} fen={fen} orientation={turnFromFen(root)} turn={turn}
                check={board.isCheck() ? turn : false} mode="legal" locked={locked || !!promotion}
                drawingEnabled={false} coordinates="edges" destinations={destinations}
                positionIdentity={id} positionRevision={moves.length}
                lastMove={moves.length ? [moves.at(-1).slice(0, 2), moves.at(-1).slice(2, 4)] : undefined}
                ariaLabel="Tactic solution board" onMove={moveOnBoard} />
            </div>
            <p>{turn === "white" ? "White" : "Black"} to move</p>
          </div>
          <div className="capture-builder-controls">
            <form className="capture-san" onSubmit={addSan}>
              <label>Paste SAN moves
                <textarea rows={3} value={san} spellCheck="false" disabled={locked || !!promotion}
                  onChange={event => {
                    setSan(event.target.value);
                    setIssue(null);
                  }} />
              </label>
              <Button type="submit" disabled={locked || !!promotion || !san.trim()}>Add moves</Button>
            </form>
            {issue && <StatusNotice kind="error">{issue}</StatusNotice>}
            {line && <ul className="capture-solution" aria-label="Solution moves">
              {line.moves.map(({ notation }, index) => <li key={index}>{notation}</li>)}
            </ul>}
            <div className="actions">
              <Button disabled={locked || !!promotion || !moves.length} onClick={() => {
                setMoves(moves.slice(0, -1));
                setIssue(null);
              }}>Undo last move</Button>
              <Button variant="primary" pending={saving} disabled={locked || !canSave || !!promotion || !line || !!san.trim()}
                onClick={() => onSave(capturePgn(root, line))}>Save tactic</Button>
            </div>
          </div>
        </div>
        <PromotionChooser choice={promotion} onChoose={(choice, role) => play(choice.base + role)}
          onCancel={() => {
            setPromotion(null);
            boardInput.current?.clearInput();
          }} />
      </>}
    </Surface>
  );
}
