import { Chess } from "chess.js";

const clips = ["move-self", "move-opponent", "capture", "check", "castle", "promote", "illegal"];
const preferenceKey = "tempo-v2-board-sounds";
const playbackDeadlineMs = 250;
const preloadDeadlineMs = 500;

function applyMove(board, uci) {
  return board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
}

function cue(move, board, ordinary) {
  if (board.isCheck()) return "check";
  if (move.isPromotion()) return "promote";
  if (move.isKingsideCastle() || move.isQueensideCastle()) return "castle";
  if (move.isCapture() || move.isEnPassant()) return "capture";
  return ordinary;
}

// Classification is best effort. Tempo's supplied destinations and replies own legality.
export function learnerCue(fen, uci) {
  try {
    const board = new Chess(fen);
    return cue(applyMove(board, uci), board, "move-self");
  } catch {
    return "move-self";
  }
}

export function replyCue(fen, uci, autoplay) {
  if (!autoplay.length) return null;
  try {
    const board = new Chess(fen);
    applyMove(board, uci);
    let reply;
    for (const { uci } of autoplay) reply = applyMove(board, uci);
    // Tempo renders the replies in one transition to the final position.
    return cue(reply, board, "move-opponent");
  } catch {
    return "move-opponent";
  }
}

export function createBoardSounds() {
  let enabled = true;
  try {
    enabled = window.localStorage.getItem(preferenceKey) !== "false";
  } catch { /* Use the in-memory preference if storage is unavailable. */ }
  const players = new Map();
  let preparing = false;

  function stop(player) {
    clearTimeout(player.pending);
    player.pending = undefined;
    try { player.audio.pause(); } catch { /* Audio is optional. */ }
  }

  function cancel() {
    for (const player of players.values()) stop(player);
  }

  async function prepare() {
    if (!enabled || preparing) return;
    preparing = true;
    // Starting every media request at once can leave a clip stalled in Chrome.
    try {
      for (const clip of clips) {
        if (!enabled) break;
        if (players.has(clip)) continue;
        try {
          const audio = new Audio();
          audio.preload = "auto";
          audio.volume = 0.72;
          await new Promise(resolve => {
            const deadline = setTimeout(finish, preloadDeadlineMs);
            function finish() {
              clearTimeout(deadline);
              audio.removeEventListener("loadeddata", finish);
              audio.removeEventListener("error", finish);
              resolve();
            }
            audio.addEventListener("loadeddata", finish);
            audio.addEventListener("error", finish);
            audio.src = `/assets/${clip}.mp3`;
            players.set(clip, { audio, pending: undefined });
          });
        } catch { /* Missing media support must leave the board usable. */ }
      }
    } finally {
      preparing = false;
    }
  }

  function play(clip) {
    if (!enabled) return;
    const player = players.get(clip);
    if (!player || player.audio.readyState < 2) return;
    try {
      if (player.pending !== undefined) stop(player);
      player.audio.currentTime = 0;
      const request = player.audio.play();
      const deadline = setTimeout(() => stop(player), playbackDeadlineMs);
      player.pending = deadline;
      const settled = () => {
        if (player.pending !== deadline) return;
        clearTimeout(deadline);
        player.pending = undefined;
      };
      void request.then(settled, settled);
    } catch { /* Missing or blocked audio must leave the board usable. */ }
  }

  return {
    get enabled() { return enabled; },
    setEnabled(value) {
      enabled = value;
      try { window.localStorage.setItem(preferenceKey, String(value)); } catch { /* This tab still honors the choice. */ }
      if (enabled) void prepare();
      else cancel();
    },
    prepare,
    play,
    cancel,
  };
}
