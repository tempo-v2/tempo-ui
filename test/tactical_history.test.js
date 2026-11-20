import assert from "node:assert/strict";
import test from "node:test";
import { readTacticalHistory, tacticalNotation, tacticalScore, validateTacticalHistory } from "../tactical_history.js";
import { tacticalFen, tacticalObservation, tacticalReport } from "./tactical_history_fixture.js";

const check = value => validateTacticalHistory(value, "tactics-fixture");

test("history preserves all six observed outcomes and their measured decision counts", () => {
  const names = ["took_good_capture", "good_alternative", "missed_good_capture", "took_inferior_capture", "declined_inferior_capture", "uncertain"];
  const report = tacticalReport({ observations: names.map((name, index) => tacticalObservation(6 - index, name)) });
  assert.equal(check(report), report);
  assert.equal(report.statistics.observations, 6);
  assert.equal(report.observations[2].details.assessment.puzzle.answer.uci, "a1a7");
  assert.equal(tacticalNotation(tacticalFen, "a1a7"), "Rxa7");
  assert.equal(tacticalScore({ kind: "centipawns", value: 125 }), "+1.25");
  assert.equal(tacticalScore({ kind: "mate", value: -3 }), "Mated in 3");
  assert.equal(tacticalScore(null), "Not established");
});

test("history rejects wrong dataset, unsupported version, invalid counts, and cursor loops", () => {
  const original = tacticalReport();
  for (const fields of [{ dataset_id: "other" }, { schema_version: 2 }, { status: "complete" },
    { observations: [original.observations[0], original.observations[0]] },
    { observations: [...original.observations].reverse() }, { next_before: 3 }]) {
    assert.throws(() => check({ ...original, ...fields }));
  }
  for (const value of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => check({ ...original, statistics: { ...original.statistics, decisions_scanned: value } }));
  }
  assert.throws(() => check({ ...original, statistics: { ...original.statistics, observations: 8 } }));
  assert.throws(() => check({ ...original, statistics: { ...original.statistics, outcomes: { recognition: 3 } } }));
  assert.throws(() => validateTacticalHistory(original, "tactics-fixture", 3));
  assert.doesNotThrow(() => check({ ...original, next_before: 1 }));
});

test("complete evidence requires exact legal root scores and consistent observed board facts", () => {
  const modifications = [
    row => { row.details.side_to_move = "black"; },
    row => { row.details.assessment.played.uci = "a1a8"; },
    row => { row.details.assessment.candidates[0].capture.target.square = "b7"; },
    row => { row.details.assessment.candidates[0].score = { kind: "mate", value: 0 }; },
    row => { row.details.assessment.analysis.evaluation.roots.pop(); },
    row => { row.details.assessment.analysis.evaluation.roots[0].bound = "lower"; },
    row => { row.details.assessment.outcome = "good_alternative"; },
    row => { row.details.assessment.puzzle.answer.uci = "g1g2"; },
    row => { row.puzzle.version = 0; },
  ];
  for (const modify of modifications) {
    const report = tacticalReport({ observations: [tacticalObservation(1)] });
    modify(report.observations[0]);
    assert.throws(() => check(report));
  }
  assert.doesNotThrow(() => check(tacticalReport({ observations: [tacticalObservation(1, "uncertain")] })));
});

test("service unavailable is distinct from an analyzed empty page", () => {
  const unavailable = { schema_version: 1, dataset_id: "tactics-fixture", status: "unavailable", message: "Stockfish is unavailable." };
  assert.equal(check(unavailable), unavailable);
  assert.throws(() => check({ ...unavailable, observations: [] }));
  assert.doesNotThrow(() => check(tacticalReport({ observations: [] })));
});

test("the read is addressed and an ignored abort cannot deliver a foreign late reply", async t => {
  const saved = globalThis.fetch;
  t.after(() => { globalThis.fetch = saved; });
  let deliver;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Promise(resolve => { deliver = resolve; });
  };
  const owner = new AbortController();
  const read = readTacticalHistory("tactics-fixture", 12, owner.signal);
  await Promise.resolve();
  assert.equal(request.url, "/api/games/tactics");
  assert.equal(request.options.method, "POST");
  assert.deepEqual(JSON.parse(request.options.body), { dataset_id: "tactics-fixture", before: 12 });
  owner.abort(new DOMException("Selection changed", "AbortError"));
  await assert.rejects(read, { name: "AbortError" });
  deliver({ ok: true, status: 200, json: async () => tacticalReport() });
});

test("optional Analysis wait reasons agree with the server's waiting status", () => {
  const report = tacticalReport();
  assert.doesNotThrow(() => check(report));
  for (const wait_reason of ["wall_power", "study_in_front", "study_quiet_period", "foreground_engine", null]) {
    assert.doesNotThrow(() => check({ ...report, waiting_for_idle: wait_reason !== null, wait_reason }));
  }
  assert.throws(() => check({ ...report, waiting_for_idle: false, wait_reason: "study_in_front" }));
  assert.throws(() => check({ ...report, waiting_for_idle: true, wait_reason: "mouse" }));
});
