import assert from "node:assert/strict";
import test from "node:test";
import { lineFromBoard } from "../board_move.js";
import { appendCaptureSan, captureBoard, capturePgn, editSetupPieces, normalizeCaptureFen,
  readSetup, startingFen, writeSetup } from "../tactic_builder.js";

test("a FEN retains all six fields, including an en passant target and move counters", () => {
  const fen = "r3k2r/8/8/3pP3/8/8/8/R3K2R w KQkq d6 0 23";
  assert.equal(normalizeCaptureFen(`  ${fen.replaceAll(" ", "   ")}\n`), fen);
  assert.equal(normalizeCaptureFen(fen.replace("KQkq", "qkQK")), fen);
  assert.equal(writeSetup(readSetup(fen)), fen);
  assert.throws(() => normalizeCaptureFen(fen.replace("0 23", "0x 23")), /six-field FEN/);
  assert.throws(() => normalizeCaptureFen(fen.replace("KQkq", "KK")), /Invalid FEN castling rights/);
  assert.throws(() => normalizeCaptureFen(fen.replace("R3K2R", "R3K3")), /castling rights/);
  const edited = editSetupPieces(readSetup(fen), { h1: "." });
  assert.equal(writeSetup(edited), "r3k2r/8/8/3pP3/8/8/8/R3K3 w Qkq - 0 23");
  assert.equal(editSetupPieces(edited, { h1: "R" }).rights, "Qkq");
});

test("pasted SAN appends atomically to board moves and rejects the first invalid token", () => {
  const played = ["e2e4"];
  const pasted = appendCaptureSan(startingFen, played, "1...e5!?\n2.Nf3 Nc6 1-0");
  assert.deepEqual(pasted, ["e2e4", "e7e5", "g1f3", "b8c6"]);
  assert.throws(() => appendCaptureSan(startingFen, played, "e5 Ba9 Nc6"), /Move 2.*Ba9/);
  assert.throws(() => appendCaptureSan(startingFen, played, "--"), /Move 1/);
  assert.throws(() => appendCaptureSan(startingFen, played, "e7e5"), /Move 1/);
  assert.deepEqual(played, ["e2e4"]);
});

test("canonical PGN matches between board and SAN input and numbers a black start", () => {
  const fen = "r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 23";
  const pasted = appendCaptureSan(fen, [], "1...O-O 2. Ra2");
  assert.deepEqual(pasted, ["e8g8", "a1a2"]);
  const pgn = moves => capturePgn(fen, lineFromBoard(captureBoard(fen, moves)));
  assert.equal(pgn(pasted), pgn(["e8g8", "a1a2"]));
  assert.equal(pgn(pasted), `[SetUp "1"]\n[FEN "${fen}"]\n[TempoSetupPlies "0"]\n\n23... O-O 24. Ra2 *`);
  assert.deepEqual(appendCaptureSan(fen.replace(" b ", " w "), [], "O-O Ra2"), ["e1g1", "a8a2"]);
});

test("en passant and underpromotion keep their actual move and SAN", () => {
  const cases = [
    ["4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 23", "exd6", "e5d6"],
    ["7k/P7/8/8/8/8/8/7K w - - 0 1", "a8=N", "a7a8n"],
  ];
  for (const [fen, san, uci] of cases) {
    const moves = appendCaptureSan(fen, [], san);
    assert.deepEqual(moves, [uci]);
    const pgn = capturePgn(fen, lineFromBoard(captureBoard(fen, moves)));
    assert.ok(pgn.includes(`[FEN "${fen}"]`));
    assert.ok(pgn.endsWith(`${san} *`));
  }
});
