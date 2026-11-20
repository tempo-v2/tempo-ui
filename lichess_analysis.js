import { Chess } from "chess.js";
import { playBoardMove } from "./board_move.js";

const analysis = "https://lichess.org/analysis";
const maxPgnPathLength = 5000;

export { lineFromBoard } from "./board_move.js";

// A Fix Response lead-in ends at the draft, before any staged response.
export function boardWithLeadIn(fen, route) {
  const draft = new Chess(fen);
  if (route?.length) {
    const board = new Chess();
    try {
      for (const uci of route) playBoardMove(board, uci);
      const position = value => value.split(" ", 4).join(" ");
      if (position(board.fen()) === position(draft.fen())) return board;
    } catch {
      // The draft position is independently usable.
    }
  }
  return draft;
}

export function lichessAnalysis(fen, line, orientation) {
  const color = orientation === "black" ? "black" : "white";
  if (!line?.moves.length) {
    const params = new URLSearchParams({ fen, color });
    return { href: analysis + "?" + params };
  }
  const moves = line.moves.map(({ notation }, index) =>
    index === 0 ? notation : notation.replace(/^\d+\.\.\. /, "")).join(" ");
  const pgn = '[SetUp "1"]\n[FEN "' + line.start_fen + '"]\n\n' + moves + " *";
  // Lichess normalizes plus signs to spaces before parsing PGN and derives check from the board.
  const path = encodeURIComponent(pgn.replaceAll("+", ""));
  return path.length <= maxPgnPathLength
    ? { href: analysis + "/pgn/" + path + "?color=" + color }
    : { href: analysis + "?color=" + color, downloadPgn: pgn };
}

// The user may close or navigate the reserved tab while Study is waiting.
function withReservedLichessTab(tab, action) {
  try {
    if (tab && !tab.closed && tab.location.href === "about:blank") action(tab);
  } catch {
    // A tab that became cross-origin belongs to the user. The manual link remains.
  }
}

export function reserveLichessTab() {
  let tab = null;
  try {
    tab = window.open("about:blank", "_blank");
    if (tab) {
      tab.opener = null;
      tab.document.title = "Opening Lichess";
    }
    return tab;
  } catch {
    closeReservedLichessTab(tab);
    return null;
  }
}

export function closeReservedLichessTab(tab) {
  withReservedLichessTab(tab, reserved => reserved.close());
}

export function navigateReservedLichessTab(tab, href) {
  withReservedLichessTab(tab, reserved => {
    const link = reserved.document.createElement("a");
    link.href = href;
    link.rel = "noreferrer";
    reserved.document.body.append(link);
    link.click();
  });
}
