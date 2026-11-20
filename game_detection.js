// Detection is an ephemeral read. Its request identity never enters command recovery.
import { validateFen } from "chess.js";
import { SMALL_READ_TIMEOUT_MS } from "./bounded_read.js";
import { JsonHttpError, requestJson } from "./content_transport.js";
import { object, string } from "./wire_values.js";

const schemaVersion = 1;
const address = ["schema_version", "request_id", "dataset_id", "status"];
const gameAddress = [...address, "source", "game_id", "detector"];
const terminal = new Set(["cancelled", "timed_out", "unsupported", "invalid_result", "failed", "source_unavailable"]);
const errors = new Set(["invalid_request", "invalid_perspective", "conflict", "busy", "unconfigured",
  "unknown_detector", "source_unavailable", "unavailable", "stale", "expired"]);
const roles = new Set(["pawn", "knight", "bishop", "rook", "queen", "king"]);

const require = (valid, message) => {
  if (!valid) throw new TypeError(message);
};

function color(value) {
  return value === "white" || value === "black";
}

function nonempty(value, name) {
  require(string(value, name).trim().length > 0, `${name} is empty`);
}

function descriptor(value) {
  object(value, ["id", "revision", "configuration_fingerprint", "label"], "detector");
  nonempty(value.id, "detector ID");
  nonempty(value.revision, "detector revision");
  nonempty(value.configuration_fingerprint, "detector configuration");
  string(value.label, "detector label");
}

export function validateRegistry(value) {
  object(value, ["schema_version", "status", "detectors"], "detector registry");
  require(value.schema_version === schemaVersion && Array.isArray(value.detectors), "Invalid detector registry.");
  require(value.status === (value.detectors.length ? "available" : "unconfigured"), "Invalid detector availability.");
  const ids = new Set();
  for (const item of value.detectors) {
    descriptor(item);
    require(!ids.has(item.id), "Duplicate detector ID.");
    ids.add(item.id);
  }
  return value;
}

function digest(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function finding(value, count) {
  object(value, ["finding_id", "occurrence", "code", "subjects", "candidate_move",
    "candidate_san", "explanation", "fen", "position", "side_to_move"], "finding");
  require(digest(value.finding_id) && Number.isSafeInteger(value.occurrence)
    && value.occurrence >= 0 && value.occurrence < count, "Invalid finding anchor.");
  nonempty(value.code, "finding code");
  string(value.explanation, "finding explanation");
  nonempty(value.position, "position key");
  require(color(value.side_to_move) && typeof value.fen === "string" && validateFen(value.fen).ok
    && value.fen.split(" ")[1] === value.side_to_move[0], "Invalid finding board.");
  require(Array.isArray(value.subjects), "Invalid finding subjects.");
  const squares = new Set();
  for (const subject of value.subjects) {
    object(subject, ["square", "role", "color"], "board subject");
    require(typeof subject.square === "string" && /^[a-h][1-8]$/.test(subject.square)
      && roles.has(subject.role) && color(subject.color) && !squares.has(subject.square), "Invalid board subject.");
    squares.add(subject.square);
  }
  if (value.candidate_move !== null) {
    object(value.candidate_move, ["uci"], "candidate move");
    require(typeof value.candidate_move.uci === "string"
      && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(value.candidate_move.uci), "Invalid candidate move.");
    nonempty(value.candidate_san, "candidate SAN");
  } else {
    require(value.candidate_san === null, "Unexpected candidate SAN.");
  }
}

export function validateDetection(value, request, expectedDetector) {
  require(value?.schema_version === schemaVersion && value.request_id === request.request_id
    && value.dataset_id === request.dataset_id, "Unexpected detection request or dataset.");
  if (value.status === "error") {
    object(value, [...address, "code"], "detection error");
    require(errors.has(value.code), "Unrecognized detection error.");
    return value;
  }
  const complete = value.status === "complete";
  require(complete || value.status === "running" || terminal.has(value.status), "Unrecognized detection status.");
  object(value, complete
    ? [...gameAddress, "learner_color", "input_key", "analysis_key", "occurrence_count", "findings"]
    : gameAddress, "detection reply");
  descriptor(value.detector);
  require(value.source === request.source && value.game_id === request.game_id
    && value.detector.id === request.detector_id && value.detector.revision === expectedDetector.revision
    && value.detector.configuration_fingerprint === expectedDetector.configuration_fingerprint,
  "Unexpected detection game or detector.");
  if (complete) {
    require(color(value.learner_color) && digest(value.input_key) && digest(value.analysis_key)
      && Number.isSafeInteger(value.occurrence_count) && value.occurrence_count > 0
      && Array.isArray(value.findings), "Invalid complete detection result.");
    const ids = new Set();
    for (const item of value.findings) {
      finding(item, value.occurrence_count);
      require(!ids.has(item.finding_id), "Duplicate finding ID.");
      ids.add(item.finding_id);
    }
  }
  return value;
}

export async function readDetectors(signal) {
  return validateRegistry(await requestJson("/api/games/detectors", {
    signal, cache: "no-store", timeoutMs: SMALL_READ_TIMEOUT_MS,
  }));
}

async function detect(route, payload, request, detector, signal) {
  let value;
  try {
    value = await requestJson(route, {
      method: "POST", payload, signal, timeoutMs: SMALL_READ_TIMEOUT_MS,
    });
  } catch (error) {
    if (!(error instanceof JsonHttpError) || !error.details) throw error;
    value = error.details;
  }
  return validateDetection(value, request, detector);
}

function waitBeforePoll(signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, 200);
    signal.addEventListener("abort", cancel, { once: true });
  });
}

export async function scanGame({ dataset, source, gameId, learner, detector }, signal) {
  const correlation = {
    schema_version: schemaVersion, request_id: crypto.randomUUID(), dataset_id: dataset,
  };
  const request = {
    ...correlation, source, game_id: gameId, learner, detector_id: detector.id,
  };
  let reply = await detect("/api/games/detection", request, request, detector, signal);
  while (reply.status === "running") {
    await waitBeforePoll(signal);
    reply = await detect("/api/games/detection-result", correlation, request, detector, signal);
  }
  signal.throwIfAborted();
  return reply;
}
