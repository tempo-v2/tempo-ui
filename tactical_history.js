// Durable tactical history is a bounded read, separate from Study commands.
import { Chess, validateFen } from "chess.js";
import { requestJson } from "./content_transport.js";
import { SMALL_READ_TIMEOUT_MS } from "./bounded_read.js";
import { object, string } from "./wire_values.js";

export const tacticalOutcomes = Object.freeze({
  took_good_capture: "Captured",
  good_alternative: "Equally good alternative",
  missed_good_capture: "Missed capture",
  took_inferior_capture: "Took an inferior capture",
  declined_inferior_capture: "Declined an inferior capture",
  uncertain: "Uncertain",
  winning_mate: "Winning mate",
});

const valid = condition => {
  if (!condition) throw new TypeError("Tempo could not read the tactical history.");
};
const count = (value, positive = false) => valid(Number.isSafeInteger(value) && value >= (positive ? 1 : 0));
const nonempty = value => valid(typeof value === "string" && value.trim().length > 0);
const color = value => value === "white" || value === "black";
const roleNames = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };

function move(value, legal) {
  object(value, ["uci"], "tactical move");
  valid(typeof value.uci === "string" && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(value.uci));
  if (legal) valid(legal.has(value.uci));
}

function score(value, allowZeroMate = false) {
  object(value, ["kind", "value"], "engine score");
  valid(["centipawns", "mate"].includes(value.kind) && Number.isSafeInteger(value.value)
    && (allowZeroMate || value.kind !== "mate" || value.value !== 0));
}

function evaluation(value, legal, complete) {
  object(value, ["provenance", "depth", "nodes", "roots"], "engine comparison");
  object(value.provenance, ["engine", "engine_version", "configuration_fingerprint"], "engine identity");
  for (const item of Object.values(value.provenance)) nonempty(item);
  count(value.depth, complete);
  count(value.nodes, complete);
  valid(Array.isArray(value.roots));
  const seen = new Set();
  for (const root of value.roots) {
    object(root, ["uci", "score", "bound"], "engine root");
    move({ uci: root.uci }, complete ? legal : undefined);
    score(root.score, !complete);
    valid(["exact", "lower", "upper"].includes(root.bound));
    if (complete) valid(root.bound === "exact" && !seen.has(root.uci));
    seen.add(root.uci);
  }
  if (complete) valid(seen.size === legal.size);
}

function evaluationStatus(value, legal) {
  valid(value && ["complete", "incomplete", "unavailable", "failed"].includes(value.status));
  if (["complete", "incomplete"].includes(value.status)) {
    object(value, ["status", "evaluation"], "evaluation availability");
    if (value.evaluation !== null) evaluation(value.evaluation, legal, value.status === "complete");
    else valid(value.status === "incomplete");
  } else object(value, ["status"], "evaluation availability");
}

function boardMoves(fen) {
  valid(typeof fen === "string" && validateFen(fen).ok);
  const board = new Chess(fen);
  const legal = new Map(board.moves({ verbose: true }).map(mv => [mv.from + mv.to + (mv.promotion ?? ""), mv]));
  return { board, legal };
}

function assessment(value, fen, expectedOutcome) {
  object(value, ["kind", "candidates", "played", "outcome", "analysis", "standalone_analysis",
    "accepted_moves", "puzzle", "equivalence_cp"], "tactical assessment");
  const mate = value.outcome === "winning_mate";
  valid(value.kind === (mate ? "winning_mate" : "hanging_material") && Object.hasOwn(tacticalOutcomes, value.outcome)
    && value.outcome === expectedOutcome);
  count(value.equivalence_cp);
  const { board, legal } = boardMoves(fen);
  move(value.played, legal);
  valid(Array.isArray(value.candidates) && (mate ? value.candidates.length === 0 : value.candidates.length > 0));
  const candidates = new Set();
  for (const item of value.candidates) {
    object(item, ["capture", "quality", "score"], "capture comparison");
    object(item.capture, ["answer", "target"], "capture");
    move(item.capture.answer, legal);
    valid(!candidates.has(item.capture.answer.uci));
    candidates.add(item.capture.answer.uci);
    const target = item.capture.target;
    object(target, ["square", "role", "color"], "capture target");
    valid(typeof target.square === "string" && /^[a-h][1-8]$/.test(target.square)
      && color(target.color) && target.color[0] !== board.turn() && target.role !== "king");
    const piece = board.get(target.square);
    const mv = legal.get(item.capture.answer.uci);
    valid(piece && roleNames[piece.type] === target.role && piece.color === target.color[0]
      && roleNames[mv.captured] === target.role
      && target.square === (mv.flags.includes("e") ? mv.to[0] + mv.from[1] : mv.to));
    valid(["best_or_equivalent", "inferior", "uncertain"].includes(item.quality));
    if (item.score !== null) score(item.score);
  }
  valid(Array.isArray(value.accepted_moves));
  const accepted = new Set();
  for (const answer of value.accepted_moves) {
    move(answer, legal);
    valid(!accepted.has(answer.uci));
    accepted.add(answer.uci);
  }
  evaluationStatus(value.analysis, legal);
  if (mate) {
    valid(value.analysis.status === "complete" && value.standalone_analysis === null && value.puzzle === null);
    valid(accepted.size > 0 && [...accepted].every(uci =>
      value.analysis.evaluation.roots.some(root => root.uci === uci && root.score.kind === "mate" && root.score.value > 0)));
  }

  if (value.standalone_analysis !== null) evaluationStatus(value.standalone_analysis, legal);
  if (value.puzzle !== null) {
    object(value.puzzle, ["fen", "answer"], "generated puzzle");
    const standalone = boardMoves(value.puzzle.fen);
    move(value.puzzle.answer, standalone.legal);
    valid(value.outcome === "missed_good_capture" && candidates.has(value.puzzle.answer.uci));
  }
  if (value.outcome === "missed_good_capture") valid(value.puzzle !== null);
}

const statisticFields = ["completed_games", "failed_games", "timed_out_games", "unsupported_games",
  "pending_games", "decisions_scanned", "observations", "outcomes", "pending_requests"];

export function validateTacticalHistory(value, dataset, before) {
  valid(value?.schema_version === 1 && value.dataset_id === dataset);
  if (value.status === "unavailable") {
    object(value, ["schema_version", "dataset_id", "status", "message"], "tactical availability");
    nonempty(value.message);
    return value;
  }
  valid(value.status === "running" || value.status === "ready");
  const controlFields = ["paused", "waiting_for_idle"].filter(field => Object.hasOwn(value, field));
  for (const field of controlFields) valid(typeof value[field] === "boolean");
  object(value, [...(Object.hasOwn(value, "games") ? ["games"] : []), ...controlFields, "schema_version", "dataset_id", "status", "detector", "analysis_version", "last_error",
    "active_game", "statistics", "observations", "next_before"], "tactical history");
  if (value.games !== undefined) {
    valid(Array.isArray(value.games) && value.games.length <= 30);
    for (const game of value.games) {
      object(game, ["source", "game_id", "white", "black", "checked", "pending", "inconclusive", "preparing"], "game progress");
      for (const field of ["source", "game_id", "white", "black"]) nonempty(game[field]);
      for (const field of ["checked", "pending", "inconclusive"]) count(game[field]);
      valid(typeof game.preparing === "boolean");
    }
  }
  object(value.detector, ["id", "revision", "configuration_fingerprint", "label"], "tactical detector");
  for (const field of ["id", "revision", "configuration_fingerprint"]) nonempty(value.detector[field]);
  string(value.detector.label, "detector label");
  nonempty(value.analysis_version);
  if (value.last_error !== null) string(value.last_error, "analysis issue");
  if (value.active_game !== null) {
    object(value.active_game, ["source", "game_id", "learner"], "active game");
    Object.values(value.active_game).forEach(nonempty);
  }
  const taskFields = ["pending_positions", "inconclusive_positions"].filter(field => Object.hasOwn(value.statistics, field));
  object(value.statistics, [...statisticFields, ...taskFields], "tactical statistics");
  taskFields.forEach(field => count(value.statistics[field]));
  for (const field of statisticFields.filter(field => field !== "outcomes")) count(value.statistics[field]);
  valid(value.statistics.outcomes && typeof value.statistics.outcomes === "object" && !Array.isArray(value.statistics.outcomes));
  let total = 0;
  for (const [outcome, amount] of Object.entries(value.statistics.outcomes)) {
    valid(Object.hasOwn(tacticalOutcomes, outcome));
    count(amount);
    total += amount;
    count(total);
  }
  valid(total === value.statistics.observations && Array.isArray(value.observations) && value.observations.length <= 30);
  let previous = before ?? Infinity;
  for (const row of value.observations) {
    object(row, ["id", "source", "game_id", "learner", "ply", "outcome", "details", "puzzle", "request_id", "fulfilled", "analysis_version"], "tactical observation");
    count(row.id, true);
    valid(row.id < previous);
    previous = row.id;
    for (const field of ["source", "game_id", "learner", "analysis_version"]) nonempty(row[field]);
    count(row.ply);
    valid(Object.hasOwn(tacticalOutcomes, row.outcome) && typeof row.fulfilled === "boolean");
    const setupFields = Object.hasOwn(row.details, "opponent_lead_in") ? ["opponent_lead_in"] : [];
    object(row.details, [...setupFields, "schema_version", "fen", "position", "side_to_move", "assessment"], "observation detail");
    valid(row.details.schema_version === 1 && color(row.details.side_to_move)
      && typeof row.details.fen === "string" && row.details.fen.split(/\s+/)[1] === row.details.side_to_move[0]);
    nonempty(row.details.position);
    assessment(row.details.assessment, row.details.fen, row.outcome);
    if (row.puzzle !== null) {
      object(row.puzzle, ["target", "version"], "puzzle identity");
      nonempty(row.puzzle.target);
      count(row.puzzle.version, true);
    }
    if (row.request_id !== null) {
      count(row.request_id, true);
      valid(row.puzzle !== null);
    } else valid(!row.fulfilled);
  }
  if (value.next_before !== null) {
    count(value.next_before, true);
    valid(value.observations.length > 0 && value.next_before === value.observations.at(-1).id
      && (before === undefined || value.next_before < before));
  }
  return value;
}

export async function readTacticalHistory(dataset, before, signal) {
  nonempty(dataset);
  if (before !== undefined) count(before, true);
  const value = await requestJson("/api/games/tactics", {
    method: "POST", payload: { dataset_id: dataset, ...(before === undefined ? {} : { before }) },
    signal, cache: "no-store", timeoutMs: SMALL_READ_TIMEOUT_MS,
  });
  return validateTacticalHistory(value, dataset, before);
}

export function tacticalNotation(fen, uci) {
  const { legal } = boardMoves(fen);
  const move = legal.get(uci);
  valid(move);
  return move.san;
}

export function tacticalScore(score) {
  if (score === null) return "Not established";
  if (score.kind === "mate") return score.value > 0 ? `Mate in ${score.value}` : `Mated in ${Math.abs(score.value)}`;
  return `${score.value > 0 ? "+" : ""}${(score.value / 100).toFixed(2)}`;
}

export async function commandTacticalAnalysis(dataset, action, fields = {}) {
  const value = await requestJson("/api/games/tactics/command", {
    method: "POST", payload: {dataset_id: dataset, action, ...fields},
    cache: "no-store", timeoutMs: SMALL_READ_TIMEOUT_MS,
  });
  valid(value?.accepted === true);
}
