import React from "react";
import { Button, Dialog } from "@tempo-v2/core-components";

const storageKey = "tempo-v2-board-preferences";

export function loadBoardPreferences() {
  let value;
  try { value = JSON.parse(window.localStorage.getItem(storageKey)); } catch {}
  return {
    theme: ["brown", "blue", "green"].includes(value?.theme) ? value.theme : "brown",
    pieceSet: value?.pieceSet === "merida" ? "merida" : "cburnett",
    volume: Number.isFinite(value?.volume) ? Math.max(0, Math.min(1, value.volume)) : 0.72,
  };
}

export function saveBoardPreferences(preferences) {
  try { window.localStorage.setItem(storageKey, JSON.stringify(preferences)); } catch {}
}

export function BoardPreferences({ dialog, onClose, prefs, onChange, soundEnabled, onSoundChange }) {
  return (
    <Dialog open={!!dialog} title={dialog === "help" ? "Keyboard shortcuts" : "Board preferences"} onClose={onClose}>
      {dialog === "help" ? (
        <dl className="shortcut-list">
          <dt>Enter</dt><dd>Primary study action</dd>
          <dt>F</dt><dd>Flip the board</dd>
          <dt>?</dt><dd>Open shortcuts</dd>
          <dt>← / →</dt><dd>Previous or next revealed position</dd>
          <dt>Home / End</dt><dd>Beginning or end of revealed moves</dd>
          <dt>R</dt><dd>Return to the live position</dd>
          <dt>Escape</dt><dd>Close the dialog</dd>
        </dl>
      ) : (
        <div className="board-preferences">
          <label>Board theme <select value={prefs.theme} onChange={e => onChange({ theme: e.target.value })}>
            <option value="brown">Brown</option>
            <option value="blue">Blue</option>
            <option value="green">Green</option>
          </select></label>
          <label>Pieces <select value={prefs.pieceSet} onChange={e => onChange({ pieceSet: e.target.value })}>
            <option value="cburnett">CBurnett</option>
            <option value="merida">Merida</option>
          </select></label>
          <label>Volume <input type="range" min="0" max="1" step="0.01" value={prefs.volume}
            onChange={e => onChange({ volume: e.target.valueAsNumber })} /></label>
          <label><input type="checkbox" checked={soundEnabled} onChange={e => onSoundChange(e.target.checked)} /> Board sounds</label>
        </div>
      )}
      <Button onClick={onClose}>Close</Button>
    </Dialog>
  );
}
