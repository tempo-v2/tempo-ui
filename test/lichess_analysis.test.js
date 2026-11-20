import assert from "node:assert/strict";
import test from "node:test";
import { Chess } from "chess.js";
import { boardWithLeadIn, lichessAnalysis, lineFromBoard } from "../lichess_analysis.js";

function decodeAnalysis(href) {
  const url = new URL(href);
  const board = new Chess();
  const pgn = decodeURIComponent(url.pathname.slice("/analysis/pgn/".length));
  board.loadPgn(pgn);
  return { board, url };
}

test("Lichess PGN preserves a black move, castling, promotion and mate", () => {
  const castling = new Chess("r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 37");
  castling.move("O-O-O");
  castling.move("O-O");
  const line = lineFromBoard(castling);
  const { board, url } = decodeAnalysis(lichessAnalysis(castling.fen(), line, "black").href);
  assert.equal(url.origin, "https://lichess.org");
  assert.equal(url.searchParams.get("color"), "black");
  assert.deepEqual(board.history(), ["O-O-O", "O-O"]);
  assert.equal(board.fen(), castling.fen());

  const promotion = new Chess("7k/5KP1/8/8/8/8/8/8 w - - 0 34");
  promotion.move("g8=Q#");
  const promoted = decodeAnalysis(lichessAnalysis(promotion.fen(), lineFromBoard(promotion), "white").href);
  assert.equal(promoted.url.hash, "");
  assert.deepEqual(promoted.board.history(), ["g8=Q#"]);
  assert.equal(promoted.board.fen(), promotion.fen());
});

test("a whole replay is independent of the shown position and Lichess restores check", () => {
  const board = new Chess();
  for (const move of ["e4", "d5", "exd5", "Qxd5", "Nc3", "Qe5+"]) board.move(move);
  const line = lineFromBoard(board);
  const first = lichessAnalysis(line.start_fen, line, "white");
  assert.deepEqual(first, lichessAnalysis(line.moves[2].fen, line, "white"));
  assert.deepEqual(decodeAnalysis(first.href).board.history(), board.history());
});

test("long lines offer an intact download and position links retain exact FEN", () => {
  const board = new Chess();
  for (let cycle = 0; cycle < 180; cycle++) {
    for (const move of ["Nf3", "Nf6", "Ng1", "Ng8"]) board.move(move);
  }
  const long = lichessAnalysis(board.fen(), lineFromBoard(board), "black");
  assert.equal(long.href, "https://lichess.org/analysis?color=black");
  const downloaded = new Chess();
  downloaded.loadPgn(long.downloadPgn);
  assert.deepEqual(downloaded.history(), board.history());
  const position = new URL(lichessAnalysis(board.fen(), null, "white").href);
  assert.equal(position.searchParams.get("fen"), board.fen());
});

test("a Fix Response lead-in must reach the draft position", () => {
  const draft = new Chess();
  for (const move of ["e4", "c5"]) draft.move(move);
  const anchored = boardWithLeadIn(draft.fen().replace(" - 0 ", " c6 0 "), ["e2e4", "c7c5"]);
  assert.deepEqual(anchored.history(), ["e4", "c5"]);
  assert.equal(boardWithLeadIn(draft.fen(), ["e2e4", "e7e5"]).fen(), draft.fen());
  assert.equal(boardWithLeadIn(draft.fen(), ["e2e4", "e7e4"]).fen(), draft.fen());
});
