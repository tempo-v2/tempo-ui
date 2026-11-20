import { Chess, DEFAULT_POSITION, SQUARES, validateFen } from "chess.js";
import { playBoardMove } from "./board_move.js";

export const startingFen = DEFAULT_POSITION;
export const emptyFen = "8/8/8/8/8/8/8/8 w - - 0 1";

const castlingPieces = {
  K: { e1: "K", h1: "R" },
  Q: { e1: "K", a1: "R" },
  k: { e8: "k", h8: "r" },
  q: { e8: "k", a8: "r" },
};

export function readSetup(fen) {
  const [placement, turn, rights, enPassant, halfmove, fullmove] = fen.split(" ");
  const cells = placement.replaceAll("/", "").replace(/[1-8]/g, count => ".".repeat(Number(count)));
  const pieces = Object.fromEntries(SQUARES.map((square, index) => [square, cells[index]]));
  return { pieces, turn, rights, enPassant, halfmove, fullmove };
}

export function writeSetup({ pieces, turn, rights, enPassant, halfmove, fullmove }) {
  const ranks = Array.from({ length: 8 }, (_, rank) => SQUARES.slice(rank * 8, rank * 8 + 8)
    .map(square => pieces[square]).join("").replace(/\.+/g, run => String(run.length)));
  return [ranks.join("/"), turn, rights || "-", enPassant, halfmove, fullmove].join(" ");
}

export function canSetCastling(pieces, right) {
  return Object.entries(castlingPieces[right]).every(([square, piece]) => pieces[square] === piece);
}

export function editSetupPieces(setup, changes) {
  if (Object.entries(changes).every(([square, piece]) => setup.pieces[square] === piece)) return setup;
  const pieces = { ...setup.pieces, ...changes };
  const rights = [..."KQkq"].filter(right => setup.rights.includes(right) && canSetCastling(pieces, right)).join("");
  return { ...setup, pieces, rights, enPassant: "-" };
}

export function normalizeCaptureFen(text) {
  const fen = text.trim().replace(/\s+/g, " ");
  const validation = validateFen(fen);
  if (!validation.ok) throw new Error(validation.error);
  const setup = readSetup(fen);
  if (fen.split(" ")[0].includes("0") || ![setup.halfmove, setup.fullmove].every(counter =>
    /^\d+$/.test(counter) && Number.isSafeInteger(Number(counter)))) {
    throw new Error("Enter a valid six-field FEN.");
  }
  if (setup.rights !== "-" && (!/^K?Q?k?q?$/.test(setup.rights) ||
      [...setup.rights].some(right => !canSetCastling(setup.pieces, right)))) {
    throw new Error("FEN castling rights must match the kings and rooks on their starting squares.");
  }
  return writeSetup({ ...setup, halfmove: String(Number(setup.halfmove)), fullmove: String(Number(setup.fullmove)) });
}

export function captureBoard(fen, moves) {
  const board = new Chess(fen);
  for (const move of moves) playBoardMove(board, move);
  return board;
}

export function appendCaptureSan(fen, moves, text) {
  const board = captureBoard(fen, moves);
  // Move numbers are display cues. The starting position determines turn and numbering.
  const tokens = text.trim().replace(/(^|\s)\d+(?:\.{3}|\.)(?!\.)/g, "$1").trim().split(/\s+/);
  if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(tokens.at(-1))) tokens.pop();
  if (!tokens[0]) throw new Error("Enter at least one SAN move.");
  const appended = tokens.map((token, index) => {
    const san = token.replace(/[!?]+$/, "");
    try {
      if (san !== "--") {
        const move = board.move(san, { strict: true });
        if (move.san === san) return move.lan;
      }
    } catch {
      // The draft board is discarded on the first invalid move.
    }
    throw new Error(`Move ${index + 1} in the pasted line (${token}) is not legal SAN for this position.`);
  });
  return [...moves, ...appended];
}

export function capturePgn(fen, line) {
  return `[SetUp "1"]\n[FEN "${fen}"]\n[TempoSetupPlies "0"]\n\n${line.moves.map(move => move.notation).join(" ")} *`;
}
