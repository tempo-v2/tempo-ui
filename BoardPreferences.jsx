import React from "react";
import { Dialog, IconButton } from "@tempo-v2/core-components";
import { CloseIcon } from "./ControlIcons.jsx";
import { closeDialogShortcut, studyShortcuts } from "./shortcuts.js";

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
  const { primary, flip, help, replay } = studyShortcuts;
  return (
    <Dialog open={!!dialog} title={dialog === "help" ? "Keyboard shortcuts" : "Board preferences"} onClose={onClose}>
      {dialog === "help" ? (
        <dl className="shortcut-list">
          <dt>{primary.label}</dt><dd>Primary study action</dd>
          <dt>{flip.label}</dt><dd>Flip the board</dd>
          <dt>{help.label}</dt><dd>Open shortcuts</dd>
          <dt>{replay.previous.label} / {replay.next.label}</dt><dd>Previous or next revealed position</dd>
          <dt>{replay.beginning.label} / {replay.end.label}</dt><dd>Beginning or end of revealed moves</dd>
          <dt>{replay.returnToPosition.label}</dt><dd>Return to the live position</dd>
          <dt>{closeDialogShortcut.label}</dt><dd>Close the dialog</dd>
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
      <IconButton label="Close" shortcut={closeDialogShortcut} onClick={onClose}><CloseIcon /></IconButton>
    </Dialog>
  );
}
