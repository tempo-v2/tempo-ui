import { Chess } from "chess.js";
import { playBoardMove } from "./board_move.js";

const uci = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const addressFields = ["dataset_id", "source", "game_id", "learner", "repertoire_id"];
const departures = new Set(["learner_move", "opponent_gap", "authored_endpoint", "outside_context"]);
const boardKey = board => board.fen().split(" ").slice(0, 4).join(" ");

function requireFact(ok) {
  if (!ok) throw new TypeError("The game review could not be verified. Reload the comparison.");
}

function verifiedMove(board, move) {
  requireFact(typeof move === "string" && uci.test(move));
  requireFact(playBoardMove(board, move).lan === move);
}

function verifyPreparation(board, entry, available) {
  requireFact(Array.isArray(entry.prepared_uci) &&
    new Set(entry.prepared_uci).size === entry.prepared_uci.length);
  if (!available) requireFact(entry.book_state === "unavailable");
  else requireFact(["position", "endpoint", "outside"].includes(entry.book_state));
  requireFact((entry.book_state === "position") === (entry.prepared_uci.length > 0));
  for (const move of entry.prepared_uci) {
    verifiedMove(board, move);
    board.undo();
  }
}

// Verify the data needed by the board and annotated save preview before either can render.
// Canonical board equality ignores move counters when checking a transposition.
export function validateGameReview(reply, address) {
  try {
    requireFact(reply?.status === "review" && addressFields.every(key => reply[key] === address[key]));
    requireFact(["white", "black"].includes(reply.learner_color) &&
      [reply.white, reply.black, reply.result].every(s => typeof s === "string" && s.length > 0));
    requireFact(Array.isArray(reply.positions) && reply.positions.length > 0);
    const last = reply.positions.length - 1;
    const validPly = n => Number.isSafeInteger(n) && n > 0 && n <= last;
    const report = reply.comparison;
    if (address.repertoire_id === null) {
      requireFact(report === null && reply.document_id === null && reply.revision === null);
    } else {
      requireFact(report?.repertoire_id === address.repertoire_id &&
        typeof report.source_available === "boolean" && Number.isSafeInteger(reply.revision) && reply.revision >= 0);
      requireFact(reply.document_id === null || (typeof reply.document_id === "string" && reply.document_id.length > 0));
      requireFact(!report.source_available || reply.document_id !== null);
      const dep = report.first_departure;
      requireFact(dep === null || (report.source_available && departures.has(dep?.kind) && validPly(dep.ply)));
      requireFact(report.reentry_ply === null || (dep && validPly(report.reentry_ply) && report.reentry_ply > dep.ply));
    }
    const root = reply.positions[0].fen;
    const played = new Chess(root);
    for (const [index, position] of reply.positions.entries()) {
      requireFact(typeof position.fen === "string" && new Chess(position.fen).fen() === played.fen());
      verifyPreparation(played, position, report?.source_available);
      requireFact(position.introduced === null || typeof position.introduced === "boolean");
      if (position.introduced !== null) requireFact(["position","endpoint"].includes(position.book_state) &&
        played.turn() === reply.learner_color[0]);
      if (position.other_route !== null) {
        requireFact(Array.isArray(position.other_route) && ["position","endpoint"].includes(position.book_state));
        const alt = new Chess(root);
        for (const move of position.other_route) verifiedMove(alt, move);
        requireFact(boardKey(alt) === boardKey(played));
      }
      if (index === last) requireFact(position.played_uci === null);
      else verifiedMove(played, position.played_uci);
    }
    const requested = address.line?.moves ?? [];
    requireFact(Array.isArray(reply.line) && reply.line.length === requested.length);
    if (address.line) {
      const board = new Chess(reply.positions[address.line.from_ply].fen);
      for (const [i, entry] of reply.line.entries()) {
        requireFact(entry.uci === requested[i] && typeof entry.fen === "string" &&
          new Chess(entry.fen).fen() === board.fen());
        verifyPreparation(board, entry, report?.source_available);
        verifiedMove(board, entry.uci);
      }
    }
    return reply;
  } catch {
    throw new TypeError("The game review could not be verified. Reload the comparison.");
  }
}
