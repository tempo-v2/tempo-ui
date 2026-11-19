import assert from "node:assert/strict";
import test from "node:test";
import { Chess } from "chess.js";
import { checkedGapAnalysis, checkedGapExplorer, checkedPositionEvidence } from "../source_evidence.js";

const legalAt = fen => new Set(new Chess(fen).moves({ verbose: true })
  .map(move => move.from + move.to + (move.promotion ?? "")));
const initial = legalAt();
const row = (uci, white, draws = 0, black = 0) => ({ uci, white, draws, black });

test("both Explorer consumers validate aggregate population, legal keys and arithmetic safety", () => {
  const statistics = { white: 10, draws: 4, black: 3, moves: [row("e2e4", 5, 2, 1)] };
  const checkShared = stats => checkedPositionEvidence("masters", stats, initial);
  const checkGap = stats => checkedGapExplorer({ status: "complete", statistics: stats }, initial).statistics;
  for (const check of [checkShared, checkGap]) {
    assert.deepEqual(check(statistics), statistics);
    assert.equal(check(statistics).moves[0].white / check(statistics).white, 0.5);
    assert.doesNotThrow(() => check({ white: 0, draws: 0, black: 0, moves: [] }));
    for (const invalid of [
      { ...statistics, moves: [row("e2e4", 11)] },
      { ...statistics, moves: [row("e2e4", 10), row("d2d4", 1)] },
      { ...statistics, white: Number.MAX_SAFE_INTEGER },
      { ...statistics, moves: [row("e2e5", 1)] },
      { ...statistics, moves: [row("e2e4", 1), row("e2e4", 1)] },
      { ...statistics, moves: [row("e2e4", 0.2)] },
    ]) assert.throws(() => check(invalid), /could not read/);
  }
  assert.deepEqual(checkedGapExplorer({ status: "unavailable", code: "token_missing", token_path: "/fixture" }, initial),
    { status: "unavailable", code: "token_missing", token_path: "/fixture" });
});

test("the board accepts verified terminal Maia data and requires every legal move with unit mass otherwise", () => {
  const terminal = legalAt("7k/6Q1/6K1/8/8/8/8/8 b - - 0 50");
  const valid = Object.fromEntries([...initial].map(move => [move, Number(move === "e2e4")]));
  const data = { profile: "Maia Rapid 1500", terminal: false, probabilities: valid };
  assert.equal(checkedPositionEvidence("maia", data, initial), data);
  const missing = { ...valid };
  delete missing.d2d4;
  for (const probabilities of [{ ...valid, d2d4: 1 }, missing, { ...missing, a1a8: 0 },
    { ...valid, d2d4: -1 }, { ...valid, d2d4: Infinity }, { ...valid, d2d4: NaN }, {}]) {
    assert.throws(() => checkedPositionEvidence("maia", { ...data, probabilities }, initial), /could not read/);
  }
  const empty = { ...data, terminal: true, probabilities: {} };
  assert.equal(checkedPositionEvidence("maia", empty, terminal), empty);
  assert.throws(() => checkedPositionEvidence("maia", empty, initial));
});

test("local gap evidence keeps validated nearby suggestions through Stockfish failure", () => {
  const fen = new Chess().fen();
  const nearby = {
    current: [{ fen, distance: 1, responses: [
      { uci: "e2e4", san: "e4", repertoire_id: "saved", reusable: true },
    ] }],
    other: [],
  };
  const partial = {
    status: "running",
    nearby,
    similar_responses: { current: [{ uci: "e2e4", position_count: 1 }], other: [] },
    repertoire_names: { saved: "Saved" },
  };
  assert.deepEqual(checkedGapAnalysis(partial, initial).nearby, nearby);
  const failure = checkedGapAnalysis({ ...partial, status: "complete", stockfish_error: "Engine offline." }, initial);
  assert.deepEqual(failure.nearby, nearby);
  assert.equal(failure.stockfish_error, "Engine offline.");
  assert.equal(failure.recommendation, undefined);
  const stockfish = { engine: "Test", candidates: [
    { uci: "e2e4", centipawns: 10 },
    { uci: "d2d4", mate: -2 },
  ] };
  const valid = checkedGapAnalysis({ ...partial, status: "complete", stockfish }, initial);
  assert.equal(valid.stockfish, stockfish);
  const invalidEngine = checkedGapAnalysis({ ...partial, status: "complete", stockfish: {
    ...stockfish, candidates: [{ uci: "e2e4", centipawns: 10, mate: 3 }],
  } }, initial);
  assert.match(invalidEngine.stockfish_error, /could not read/);
  assert.deepEqual(invalidEngine.nearby, nearby);
  const malformedNearby = checkedGapAnalysis({
    ...partial, status: "complete", nearby: { current: [null], other: [] }, stockfish,
  }, initial);
  assert.match(malformedNearby.neighbors_error, /could not read/);
  assert.equal(malformedNearby.stockfish, stockfish);
  assert.deepEqual(checkedPositionEvidence("stockfish", { ...stockfish, comparison_complete: false }, initial),
    { ...stockfish, comparison_complete: false });
});
