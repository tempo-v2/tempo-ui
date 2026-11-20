import assert from "node:assert/strict";
import test from "node:test";
import { validateDetection, validateRegistry } from "../game_detection.js";

const detector = { id: "example", revision: "1", configuration_fingerprint: "configuration", label: "Demo" };
const request = {
  schema_version: 1, dataset_id: "dataset", request_id: "request",
  source: "pgn", game_id: "game", learner: "Learner", detector_id: detector.id,
};
const report = {
  schema_version: 1, dataset_id: "dataset", request_id: "request", source: "pgn",
  game_id: "game", detector, status: "complete", learner_color: "black",
  input_key: "a".repeat(64), analysis_key: "b".repeat(64), occurrence_count: 5,
  findings: [{
    finding_id: "c".repeat(64), occurrence: 0, code: "example",
    subjects: [{ square: "e7", role: "pawn", color: "black" }],
    candidate_move: { uci: "e7e5" }, candidate_san: "e5", explanation: "",
    fen: "4k3/4p3/8/8/8/8/4P3/4K3 b - - 7 12",
    position: "4k3/4p3/8/8/8/8/4P3/4K3 b - -", side_to_move: "black",
  }],
};

test("registry requires a recognized version and distinct semantic detector IDs", () => {
  assert.doesNotThrow(() => validateRegistry({ schema_version: 1, status: "unconfigured", detectors: [] }));
  assert.doesNotThrow(() => validateRegistry({ schema_version: 1, status: "available", detectors: [detector] }));
  for (const detectors of [[], [detector, { ...detector, revision: "2" }]]) {
    assert.throws(() => validateRegistry({ schema_version: 1, status: "available", detectors }));
  }
});

test("an addressed complete report allows display renames but rejects foreign identities and malformed claims", () => {
  const check = value => validateDetection(value, request, detector);
  assert.equal(check(report), report);
  assert.doesNotThrow(() => check({ ...report, detector: { ...detector, label: "Renamed" } }));
  for (const fields of [
    { dataset_id: "foreign" }, { request_id: "foreign" }, { source: "foreign" }, { game_id: "foreign" },
    { detector: { ...detector, id: "foreign" } }, { detector: { ...detector, revision: "2" } },
    { detector: { ...detector, configuration_fingerprint: "different" } },
    { schema_version: 2 }, { status: "done" }, { occurrence_count: 0 }, { occurrence_count: Infinity },
  ]) {
    assert.throws(() => check({ ...report, ...fields }), JSON.stringify(fields));
  }
  for (const fields of [
    { occurrence: -1 }, { occurrence: 0.1 }, { occurrence: Number.MAX_SAFE_INTEGER + 1 },
    { occurrence: 5 }, { side_to_move: "white" }, { fen: "invalid" },
    { candidate_move: { uci: "bad" } }, { candidate_san: null }, { subjects: [{ square: "i0", role: "pawn", color: "black" }] },
  ]) {
    assert.throws(() => check({ ...report, findings: [{ ...report.findings[0], ...fields }] }), JSON.stringify(fields));
  }
  assert.throws(() => check({ ...report, findings: [...report.findings, ...report.findings] }));
});

test("stops and addressed expiry cannot be presented as a successful empty report", () => {
  const { schema_version, dataset_id, request_id, source, game_id } = report;
  const address = { schema_version, dataset_id, request_id, source, game_id, detector };
  const check = value => validateDetection(value, request, detector);
  assert.doesNotThrow(() => check({ ...report, findings: [] }));
  for (const status of ["running", "cancelled", "timed_out", "unsupported", "invalid_result", "failed", "source_unavailable"]) {
    assert.equal(check({ ...address, status }).status, status);
    assert.throws(() => check({ ...address, status, findings: [] }));
  }
  const expired = { schema_version, dataset_id, request_id, status: "error", code: "expired" };
  assert.doesNotThrow(() => check(expired));
  assert.throws(() => check({ ...expired, request_id: "foreign" }));
  assert.throws(() => check({ ...expired, code: "guess" }));
});
