import { Chess } from "chess.js";
import { playBoardMove } from "./board_move.js";

const clips = ["move-self", "move-opponent", "capture", "check", "castle", "promote", "illegal"];
const playbackDeadlineMs = 250;
const preloadDeadlineMs = 500;

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
    return cue(playBoardMove(board, uci), board, "move-self");
  } catch {
    return "move-self";
  }
}

export function replyCue(fen, uci, autoplay) {
  if (!autoplay.length) return null;
  try {
    const board = new Chess(fen);
    playBoardMove(board, uci);
    let reply;
    for (const { uci } of autoplay) reply = playBoardMove(board, uci);
    // Tempo renders the replies in one transition to the final position.
    return cue(reply, board, "move-opponent");
  } catch {
    return "move-opponent";
  }
}

export function createBoardSounds(initialVolume, initialEnabled) {
  let enabled = initialEnabled;
  let volume = initialVolume;
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
          audio.volume = volume;
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
    setVolume(value) {
      volume = Math.max(0, Math.min(1, value));
      for (const player of players.values()) player.audio.volume = volume;
    },
    get enabled() { return enabled; },
    setEnabled(value) {
      if (enabled === value) return;
      enabled = value;
      if (enabled) void prepare();
      else cancel();
    },
    prepare,
    play,
    cancel,
  };
}
