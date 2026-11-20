import { useEffect, useRef, useState } from "react";

const delayMs = 250;
const storageKey = "tempo-study-presented-lead-in";

function lastPresentation() {
  try {
    return sessionStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

// Tempo has one active Study attempt. Keep the most recent presentation for
// this tab, including if the board is unmounted or the page is reloaded.
export function useStudyLeadIn(identity, leadIn, onPlayed) {
  const [initial] = useState(lastPresentation);
  const seen = useRef(initial);
  const [playing, setPlaying] = useState(null);
  const before = leadIn?.before_fen;
  const uci = leadIn?.uci;
  const id = before && uci ? identity : null;

  useEffect(() => {
    if (!id || id === seen.current) return;
    seen.current = id;
    try {
      sessionStorage.setItem(storageKey, id);
    } catch {
      // An unavailable session store still allows one playback in this page.
    }
    setPlaying(id);
    const timer = setTimeout(() => {
      setPlaying(null);
      onPlayed(before, uci);
    }, delayMs);
    return () => {
      clearTimeout(timer);
      setPlaying(null);
    };
  }, [id, before, uci, onPlayed]);

  return id && (playing === id || seen.current !== id) ? leadIn : null;
}
