import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { Board } from "@tempo-v2/core-components";
import { createBoardSounds } from "./board_sounds.js";

const storageKey = "tempo-v2-board-preferences";
const legacySoundKey = "tempo-v2-board-sounds";
export const boardThemes = { brown: "Brown", blue: "Blue", green: "Green" };
export const pieceSets = { cburnett: "CBurnett", merida: "Merida" };
const defaults = { theme: "brown", pieceSet: "cburnett", volume: 0.72, soundEnabled: true };
const BoardPreferences = createContext({ prefs: defaults });

function readPreferences() {
  let saved;
  try { saved = JSON.parse(window.localStorage.getItem(storageKey)); } catch {}
  let soundEnabled = saved?.soundEnabled;
  if (typeof soundEnabled !== "boolean") {
    try { soundEnabled = window.localStorage.getItem(legacySoundKey) !== "false"; } catch {}
  }
  return {
    theme: Object.hasOwn(boardThemes, saved?.theme) ? saved.theme : defaults.theme,
    pieceSet: Object.hasOwn(pieceSets, saved?.pieceSet) ? saved.pieceSet : defaults.pieceSet,
    volume: Number.isFinite(saved?.volume) ? Math.max(0, Math.min(1, saved.volume)) : defaults.volume,
    soundEnabled: typeof soundEnabled === "boolean" ? soundEnabled : defaults.soundEnabled,
  };
}

export function BoardPreferencesProvider({ children }) {
  const [prefs, setPrefs] = useState(readPreferences);
  const [persisted, setPersisted] = useState(true);
  const memory = useRef({ prefs, persisted });

  function publish(next, saved) {
    memory.current = { prefs: next, persisted: saved };
    setPrefs(next);
    setPersisted(saved);
  }

  function update(change) {
    const current = memory.current;
    const next = { ...(current.persisted ? readPreferences() : current.prefs), ...change };
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      publish(next, false);
      return;
    }
    publish(next, true);
    try { window.localStorage.removeItem(legacySoundKey); } catch {}
  }

  useEffect(() => {
    function sync(event) {
      if (event.key === storageKey || event.key === legacySoundKey || event.key === null)
        publish(readPreferences(), true);
    }
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  return <BoardPreferences.Provider value={{ prefs, persisted, update }}>{children}</BoardPreferences.Provider>;
}

export function useBoardPreferences() {
  return useContext(BoardPreferences);
}

export function TempoBoard(props) {
  const { prefs } = useBoardPreferences();
  return <Board {...props} theme={prefs.theme} pieceSet={prefs.pieceSet} />;
}

export function useBoardSounds() {
  const { prefs } = useBoardPreferences();
  const [sounds] = useState(() => createBoardSounds(prefs.volume, prefs.soundEnabled));
  useEffect(() => {
    sounds.setVolume(prefs.volume);
    sounds.setEnabled(prefs.soundEnabled);
  }, [sounds, prefs.volume, prefs.soundEnabled]);
  useEffect(() => {
    void sounds.prepare();
    return () => sounds.cancel();
  }, [sounds]);
  return sounds;
}
