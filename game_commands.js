import { validateGameReview } from "./validate_game_review.js";
import { SHORT_ACK_TIMEOUT_MS, SMALL_READ_TIMEOUT_MS } from "./bounded_read.js";
import { requestJson } from "./content_transport.js";
import { string } from "./wire_values.js";

const endpoint = "/api/games";
export const utcDayMs = 86_400_000;

export const sourceNames = Object.freeze({
  lichess: "Lichess",
  chess_com: "Chess.com",
  pgn: "PGN file",
});

export const gameEffects = Object.freeze({
  again_applied: "Game Again recorded. Repair is ready in Study.",
  choice_required: "Choose a repertoire for the correction",
  recorded_only: "Recorded only",
  requested_review: "Study Test requested",
  already_addressed: "Already addressed in Study",
  prioritized_teaching: "Teaching route prioritized",
  stale_content: "Compared with a previous answer version",
  unsupported: "Unsupported game",
  ambiguous: "Learner or repertoire could not be identified",
});

function count(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Invalid game count for ${field}`);
  }
  return value;
}

const departureKinds = new Set(["learner_move", "opponent_gap", "authored_endpoint", "outside_context"]);

function comparisonPly(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("Invalid repertoire comparison ply");
  return value;
}

function repertoireComparisons(result) {
  if (!Object.hasOwn(result, "repertoires")) return null;
  if (!Array.isArray(result.repertoires)) throw new TypeError("Invalid repertoire comparisons");
  return result.repertoires.map(book => {
    if (typeof book?.source_available !== "boolean") throw new TypeError("Invalid repertoire comparison availability");
    const departure = book.first_departure;
    if (departure !== null && !departureKinds.has(departure?.kind))
      throw new TypeError("Invalid repertoire departure");
    return {
      repertoire_id: string(book.repertoire_id, "comparison repertoire", true),
      source_available: book.source_available,
      first_departure: departure === null ? null : { kind: departure.kind, ply: comparisonPly(departure.ply) },
      reentry_ply: book.reentry_ply === null ? null : comparisonPly(book.reentry_ply),
    };
  });
}

function gameResults(results) {
  if (!Array.isArray(results)) throw new TypeError("Invalid game results");
  return results.map(result => {
    const effect = result.effect;
    if (!Object.hasOwn(gameEffects, effect)) throw new TypeError("Invalid Study effect");
    const firstDeviation = result.first_deviation_ply;
    if (result.correction_choice_status !== undefined && result.correction_choice_status !== "compare_again")
      throw new TypeError("Invalid corrective choice status");
    return {
      comparison_id: result.comparison_id === undefined
        ? null : string(result.comparison_id, "comparison_id", true),
      source: string(result.source, "source", true),
      game_id: string(result.game_id, "game_id", true),
      ...(result.players && {
        players: { white: string(result.players.white, "White"), black: string(result.players.black, "Black"),
          played_date_ms: result.players.played_date_ms == null ? null : count(result.players.played_date_ms, "game date") },
      }),
      url: safeGameLink(result.url),
      repertoire_id: string(result.repertoire_id, "repertoire_id"),
      learner: string(result.learner, "learner", true),
      matches: count(result.matches, "matches"),
      deviations: count(result.deviations, "deviations"),
      first_deviation_ply: firstDeviation === null ? null : count(firstDeviation, "first_deviation_ply"),
      coverage_gaps: count(result.coverage_gaps, "coverage_gaps"),
      opponent_deviations: count(result.opponent_deviations, "opponent_deviations"),
      occurrence_end_ms: result.occurrence_end_ms == null
        ? null : count(result.occurrence_end_ms, "occurrence_end_ms"),
      ...(result.correction_choice_status && { correction_choice_status: result.correction_choice_status }),
      choices: (result.choices ?? []).map(choice => ({
        ply: count(choice.ply, "choice ply"),
        candidates: choice.candidates.map(candidate => ({
          repertoire_id: string(candidate.repertoire_id, "choice repertoire", true),
          target_id: string(candidate.target_id, "choice target", true),
        })),
      })),
      disagreements: (result.disagreements ?? []).map(item => ({
        repertoire_id: string(item.repertoire_id, "disagreement repertoire", true),
        plies: item.plies.map(ply => count(ply, "disagreement ply")),
      })),
      repertoires: repertoireComparisons(result),
      effect,
    };
  });
}

export function safeGameLink(link) {
  if (link === null) return null;
  try {
    const url = new URL(link);
    if (url.protocol === "https:" && !url.username && !url.password) return url.href;
  } catch { /* A URL outside the link contract is plain text in the list. */ }
  return null;
}

function gameReport(reply) {
  if (!reply || !Array.isArray(reply.errors)) throw new TypeError("Invalid game report");
  return {
    fetched: count(reply.fetched, "fetched"),
    new_games: count(reply.new_games, "new_games"),
    duplicates: count(reply.duplicates, "duplicates"),
    opposite_color_skipped: count(reply.opposite_color_skipped ?? 0, "opposite_color_skipped"),
    matches: count(reply.matches, "matches"),
    deviations: count(reply.deviations, "deviations"),
    errors: reply.errors.map(error => string(error, "game error", true)),
    results: gameResults(reply.results),
  };
}

function request(path, payload, signal, { timeoutMs, expectedStatus } = {}) {
  return requestJson(endpoint + path, {
    method: payload === undefined ? "GET" : "POST",
    cache: payload === undefined ? "no-store" : undefined,
    payload,
    signal,
    timeoutMs,
    expectedStatus,
  });
}

function read(path, signal, payload) {
  return request(path, payload, signal, { timeoutMs: SMALL_READ_TIMEOUT_MS });
}

function jobAddress(reply) {
  return {
    commandId: string(reply.command_id, "refresh command", true),
    datasetId: string(reply.dataset_id, "refresh dataset", true),
  };
}

export async function readGameLibraryPage(dataset, through, before, signal) {
  const page = await read("/library", signal, {dataset_id:dataset, through, before});
  if (page.dataset_id !== dataset || !Array.isArray(page.entries) || !Number.isSafeInteger(page.through) ||
      (through !== undefined && page.through !== through) || (page.next_before !== null &&
       (!Number.isSafeInteger(page.next_before) || page.next_before <= 0 ||
        page.next_before > page.through || before !== undefined && page.next_before >= before)))
    throw new TypeError("Invalid game library page");
  const entries = page.entries.map(game => {
    if (![null,"white","black"].includes(game.color) || !Array.isArray(game.moves) ||
        !game.moves.every(move => typeof move === "string") || !Array.isArray(game.repertoires))
      throw new TypeError("Invalid game opening");
    for (const field of ["white","black","source","game_id","learner"]) string(game[field],field,true);
    for (const field of ["opening","eco"]) if (game[field] !== null) string(game[field],field);
    if (game.played_ms !== null) count(game.played_ms,"played date");
    return {...game, repertoires:repertoireComparisons(game)};
  });
  return {...page, entries};
}

export async function readGameHistory(signal) {
  const reply = await read("", signal);
  return {
    results: gameResults(reply.results),
    lastSuccessfulRefresh: reply.last_successful_refresh_ms === null
      ? null : count(reply.last_successful_refresh_ms, "last_successful_refresh_ms"),
  };
}

export async function readGameJob(signal) {
  const reply = await read("/job", signal);
  switch (reply.status) {
    case "idle":
      return { status: "idle" };
    case "running":
      return { status: "running", ...jobAddress(reply) };
    case "complete":
      return { status: "complete", ...jobAddress(reply), report: gameReport(reply.report) };
    case "failed":
      return {
        status: "failed",
        ...jobAddress(reply),
        error: string(reply.error, "refresh error", true),
        report: reply.report ? gameReport(reply.report) : null,
      };
    default:
      throw new TypeError("Invalid game refresh status");
  }
}

export async function refreshGames(payload, signal) {
  const reply = await request("/refresh", payload, signal, {
    expectedStatus: 202, timeoutMs: SHORT_ACK_TIMEOUT_MS,
  });
  const address = jobAddress(reply);
  if (address.commandId !== payload.command_id || address.datasetId !== payload.dataset_id)
    throw new Error("The Refresh reply belongs to a different request or dataset.");
  if (reply.status === "running") return { status: "running", ...address };
  if (reply.status === "complete") return { status: "complete", ...address, report: gameReport(reply.report) };
  throw new TypeError("Invalid Refresh acknowledgement.");
}

export async function importGamePgn(payload, signal) {
  return gameReport(await request("/import", payload, signal));
}

export async function chooseGameCorrection(payload, signal) {
  return gameReport(await request("/choose", payload, signal));
}

export async function reprocessGames(payload, signal) {
  return gameReport(await request("/reprocess", payload, signal));
}

export const historicalStatus = signal => read("/backfill", signal);

async function acknowledgeHistorical(path, payload, jobId, signal) {
  const reply = await request(path, payload, signal, { timeoutMs: SHORT_ACK_TIMEOUT_MS });
  if (!jobId || !payload.dataset_id || reply?.job_id !== jobId || reply?.request?.dataset_id !== payload.dataset_id)
    throw new Error("The historical reply belongs to a different job or dataset.");
  if (!["running", "incomplete", "complete"].includes(reply.status))
    throw new Error("Tempo did not acknowledge the historical request.");
  return reply;
}

export const startHistorical = (payload, signal) =>
  acknowledgeHistorical("/backfill", payload, payload.command_id, signal);
export const retryHistorical = (payload, signal) =>
  acknowledgeHistorical("/backfill/retry", payload, payload.job_id, signal);

function modelReply(reply) {
  if (!["idle", "running", "complete", "incomplete"].includes(reply?.status))
    throw new TypeError("Invalid Maia status.");
  if (reply.status !== "idle") string(reply.dataset_id, "model dataset", true);
  if (reply.projection == null) return reply;
  const projection = reply.projection;
  return {
    ...reply,
    projection: {
      dataset_id: string(projection.dataset_id, "projection dataset", true),
      complete_current: count(projection.complete_current, "complete projections"),
      partial_current: count(projection.partial_current, "partial projections"),
      unavailable: count(projection.unavailable, "unavailable projections"),
      pending: count(projection.pending, "pending projections"),
    },
  };
}

export async function modelStatus(signal) {
  return modelReply(await read("/model", signal));
}

export async function startModel(payload, signal) {
  const reply = modelReply(await request("/model", payload, signal, { timeoutMs: SHORT_ACK_TIMEOUT_MS }));
  if (reply.dataset_id !== payload.dataset_id)
    throw new Error("The Maia acknowledgement belongs to a different dataset.");
  return reply;
}
export const readGaps = (signal, offset = 0, forecastRepertoire = null) =>
  read("/gaps", signal, offset || forecastRepertoire ? { offset, ...(forecastRepertoire ? { forecast_repertoire: forecastRepertoire } : {}) } : undefined);

function coverageReply(reply, address) {
  if (reply.dataset_id !== address.dataset_id || reply.repertoire_id !== address.repertoire_id)
    throw new Error("Coverage status belongs to a different repertoire.");
  if (!["idle", "running", "complete", "failed"].includes(reply.status) || typeof reply.busy !== "boolean")
    throw new Error("Invalid coverage status.");
  const report = reply.report;
  if (report && (!Number.isFinite(report.covered) || !Number.isFinite(report.unresolved) ||
      report.covered < 0 || report.unresolved < 0 || report.covered + report.unresolved > 1.000000001))
    throw new Error("Invalid coverage estimate.");
  return reply;
}

export async function readCoverage(address, signal) {
  return coverageReply(await read("/coverage/status", signal, address), address);
}

export async function startCoverage(payload, signal) {
  const { request_id, dataset_id, repertoire_id, target_percent, through_move, prior_report_id } = payload;
  const command = { request_id, dataset_id, repertoire_id, target_percent, through_move, prior_report_id };
  return coverageReply(await request("/coverage", command, signal, { timeoutMs: SHORT_ACK_TIMEOUT_MS }), command);
}
export const gapDraft = (payload, signal) => request("/gap-draft", payload, signal);
export const startGapAnalysis = (payload, signal) => request("/gap-analysis", payload, signal);
export const readGapAnalysis = signal => request("/gap-analysis", undefined, signal);

export const startGapExplorer = (payload, signal) => request("/gap-explorer", payload, signal);
export const readGapExplorer = signal => request("/gap-explorer", undefined, signal);

export function utcDateRange(first, last, limit = 31) {
  const day = value => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
    const time = Date.parse(`${value}T00:00:00Z`);
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
      ? time : NaN;
  };
  const from_ms = day(first);
  const to_ms = day(last) + utcDayMs;
  if (!(from_ms >= 0 && to_ms > from_ms)) throw new Error("Enter a valid date range.");
  if (to_ms - from_ms > limit * utcDayMs) throw new Error(`Choose a range of up to ${limit} UTC days.`);
  return { from_ms, to_ms };
}

export async function readGameReview(address, signal) {
  const reply = await read("/review", signal, address);
  if (reply.status === "error") throw new Error(reply.message);
  return validateGameReview(reply, address);
}
