import React, { useState } from "react";
import { Button, StatusNotice } from "@tempo-v2/core-components";
import { TempoBoard as Board } from "./board_preferences.jsx";
import { canSetCastling, editSetupPieces, emptyFen, normalizeCaptureFen, readSetup, startingFen, writeSetup } from "./tactic_builder.js";

const roles = ["king", "queen", "rook", "bishop", "knight", "pawn"];
const rights = [
  ["K", "White kingside"], ["Q", "White queenside"],
  ["k", "Black kingside"], ["q", "Black queenside"],
];

export function TacticPositionEditor({ fen, hasSolution, locked, onApply, onCancel }) {
  const [setup, setSetup] = useState(() => readSetup(fen));
  const [fenText, setFenText] = useState("");
  const [tool, setTool] = useState("move");
  const [from, setFrom] = useState(null);
  const [issue, setIssue] = useState(null);
  const boardFen = writeSetup(setup);
  const turn = setup.turn === "w" ? "white" : "black";

  function replaceSetup(next) {
    setSetup(next);
    setFrom(null);
    setIssue(null);
  }

  function selectTool(value) {
    setTool(value);
    setFrom(null);
  }

  function selectSquare({ square }) {
    if (tool !== "move") {
      replaceSetup(editSetupPieces(setup, { [square]: tool }));
    } else if (from && from !== square) {
      replaceSetup(editSetupPieces(setup, { [from]: ".", [square]: setup.pieces[from] }));
    } else {
      setFrom(from || setup.pieces[square] === "." ? null : square);
    }
  }

  function apply(value) {
    try {
      onApply(normalizeCaptureFen(value));
    } catch (error) {
      setIssue(error.message);
    }
  }

  return (
    <div className="repertoire-form">
      {hasSolution && <p>Applying a different starting position clears the solution.</p>}
      <form className="capture-fen" onSubmit={event => {
        event.preventDefault();
        apply(fenText);
      }}>
        <label>Starting position FEN
          <input value={fenText} onChange={event => {
            setFenText(event.target.value);
            setIssue(null);
          }} disabled={locked} placeholder="Paste a six-field FEN" spellCheck="false" />
        </label>
        <Button type="submit" disabled={locked || !fenText.trim()}>Use FEN</Button>
      </form>
      {issue && <StatusNotice kind="error">{issue}</StatusNotice>}
      <div className="tactic-builder-layout">
        <Board fen={boardFen} orientation={turn} turn={turn} check={false} mode="select" locked={locked}
          drawingEnabled={false} coordinates="edges" positionIdentity={`${boardFen}:${tool}`}
          positionRevision={0} ariaLabel="Starting position editor" onSelect={selectSquare}
          shapes={from ? [{ orig: from, brush: "green" }] : []} />
        <div className="capture-setup-controls">
          <label>Side to move
            <select value={setup.turn} disabled={locked} onChange={event =>
              replaceSetup({ ...setup, turn: event.target.value, enPassant: "-" })}>
              <option value="w">White</option>
              <option value="b">Black</option>
            </select>
          </label>
          <div className="capture-piece-tools" role="group" aria-label="Piece editing tools">
            <div className="actions">
              <Button disabled={locked} aria-pressed={tool === "move"} onClick={() => selectTool("move")}>Move pieces</Button>
              <Button disabled={locked} aria-pressed={tool === "."} onClick={() => selectTool(".")}>Remove piece</Button>
            </div>
            {["White", "Black"].map((color, row) => (
              <div className="capture-piece-palette" key={color}>
                {roles.map((role, index) => {
                  const lower = role === "knight" ? "n" : role[0];
                  const piece = row === 0 ? lower.toUpperCase() : lower;
                  const label = `${color} ${role}`;
                  return <Button key={piece} disabled={locked} aria-pressed={tool === piece}
                    aria-label={label} title={label} onClick={() => selectTool(piece)}>
                    {String.fromCodePoint(0x2654 + row * 6 + index)}
                  </Button>;
                })}
              </div>
            ))}
          </div>
          <fieldset className="capture-castling">
            <legend>Castling rights</legend>
            {rights.map(([right, label]) => <label key={right}>
              <input type="checkbox" checked={setup.rights.includes(right)}
                disabled={locked || !canSetCastling(setup.pieces, right)} onChange={event => {
                  const value = event.target.checked ? setup.rights + right : setup.rights.replace(right, "");
                  replaceSetup({ ...setup, rights: [..."KQkq"].filter(candidate => value.includes(candidate)).join("") });
                }} />{label}
            </label>)}
          </fieldset>
          <div className="actions">
            <Button disabled={locked} onClick={() => replaceSetup(readSetup(emptyFen))}>Clear board</Button>
            <Button disabled={locked} onClick={() => replaceSetup(readSetup(startingFen))}>Reset board</Button>
          </div>
        </div>
      </div>
      <div className="actions">
        <Button variant="primary" disabled={locked} onClick={() => apply(boardFen)}>Use board position</Button>
        <Button disabled={locked} onClick={onCancel}>Cancel position edit</Button>
      </div>
    </div>
  );
}
