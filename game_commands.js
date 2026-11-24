import { validateGameReview } from "./validate_game_review.js";
import { SHORT_ACK_TIMEOUT_MS, SMALL_READ_TIMEOUT_MS } from "./bounded_read.js";
import { requestJson } from "./content_transport.js";
import { string } from "./wire_values.js";

const endpoint = "/api/games";

export const sourceNames = Object.freeze({
  lichess: "Lichess",
  chess_com: "Chess.com",
  pgn: "PGN file",
});

export const gameEffects = Object.freeze({
  again_applied: "Game Again recorded. Repair is ready in Study.",
  choice_required: "Multiple corrective targets",
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
  };
}

export async function recoverGameRefresh(payload, signal) {
  let reply;
  try {
    reply = await request("/refresh", payload, signal, {
      expectedStatus: 202, timeoutMs: SHORT_ACK_TIMEOUT_MS,
    });
  } catch (error) {
    if (error.status === 410 && error.code === "retired_feature" && error.retryable === false &&
        error.details.dataset_id === payload.dataset_id && error.details.command_id === payload.command_id)
      return { status: "retired", message: error.message };
    throw error;
  }
  const address = jobAddress(reply);
  if (address.commandId !== payload.command_id || address.datasetId !== payload.dataset_id)
    throw new Error("The Refresh reply belongs to a different request or dataset.");
  if (reply.status === "complete") return { status: "complete", ...address, report: gameReport(reply.report) };
  throw new TypeError("Invalid Refresh receipt.");
}

export async function importGamePgn(payload, signal) {
  return gameReport(await request("/import", payload, signal));
}

export async function recoverGameChoice(payload, signal) {
  try {
    return { status: "complete", report: gameReport(await request("/choose", payload, signal)) };
  } catch (error) {
    if (error.status === 410 && error.code === "retired_feature" && error.retryable === false &&
        error.details?.dataset_id === payload.dataset_id && error.details?.command_id === payload.command_id)
      return { status: "retired", message: error.message };
    throw error;
  }
}

export async function recoverReprocessGames(payload, signal) {
  let reply;
  try {
    reply = await request("/reprocess", payload, signal);
  } catch (error) {
    if (error.status === 410 && error.code === "retired_feature" && error.retryable === false &&
        error.details.dataset_id === payload.dataset_id && error.details.command_id === payload.command_id)
      return { status: "retired", message: error.message };
    throw error;
  }
  return { status: "complete", report: gameReport(reply) };
}

export async function recoverHistorical(payload, retry, signal) {
  const jobId = retry ? payload.job_id : payload.command_id;
  function matches({ dataset_id, job_id, command_id }) {
    return jobId && job_id === jobId && dataset_id === payload.dataset_id &&
      command_id === payload.command_id;
  }
  let reply;
  try {
    reply = await request(retry ? "/backfill/retry" : "/backfill", payload, signal, {
      expectedStatus: 200, timeoutMs: SHORT_ACK_TIMEOUT_MS,
    });
  } catch (error) {
    if (error.status === 410 && error.code === "retired_feature" && error.retryable === false &&
        matches(error.details)) return { status: "retired", message: error.message };
    throw error;
  }
  if (!matches({ ...reply, dataset_id: reply?.request?.dataset_id })) {
    throw new Error("The historical reply belongs to a different request, job, or dataset.");
  }
  if (reply.execution !== "retired" || !["complete", "incomplete"].includes(reply.status)) {
    throw new Error("Tempo did not confirm the archived historical request.");
  }
  return {
    status: reply.status, datasetId: payload.dataset_id,
    pendingWindows: count(reply.pending_windows, "stopped windows"),
    incompleteWindows: count(reply.incomplete_windows, "incomplete windows"),
  };
}

export async function readGaps(signal, offset = 0, forecastRepertoire = null) {
  const reply = await read("/gaps", signal, offset || forecastRepertoire
    ? { offset, ...(forecastRepertoire ? { forecast_repertoire: forecastRepertoire } : {}) }
    : undefined);
  if (!Array.isArray(reply.gaps) || reply.gaps.some(gap => !gap || typeof gap !== "object"))
    throw new Error("Invalid opponent gaps response.");
  // Older replies omitted the kind and can still use the historical editor.
  if (reply.gaps.some(gap => Object.hasOwn(gap, "gap_kind") && !["observed", "forecast"].includes(gap.gap_kind)))
    throw new Error("Unsupported opponent gap kind.");
  return reply;
}

export function validCoverageLine(setting) {
  return setting && Number.isSafeInteger(setting.revision) && setting.revision >= 0 &&
    Array.isArray(setting.moves) && setting.moves.length < 40 &&
    setting.moves.every(uci => typeof uci === "string" && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci));
}

export async function coverageStartingLine(payload, signal) {
  return coverageLineReply(await request("/coverage/starting-line", payload, signal));
}

export async function saveCoverageStartingLine(payload, signal) {
  return coverageLineReply(await request("/coverage/starting-line/save", payload, signal));
}

function coverageLineReply(reply) {
  const line = reply.line;
  if (!validCoverageLine(reply.saved) || (line && (!Array.isArray(line.san) ||
      !line.san.every(move => typeof move === "string") || !line.choices ||
      Object.values(line.choices).some(move => typeof move !== "string"))) ||
      (reply.minimum_move !== null && !Number.isInteger(reply.minimum_move))) {
    throw new Error("Invalid coverage starting line.");
  }
  return reply;
}

export const gapDraft = (payload, signal) => request("/gap-draft", payload, signal);

export async function readGameReview(address, signal) {
  const reply = await read("/review", signal, address);
  if (reply.status === "error") throw new Error(reply.message);
  return validateGameReview(reply, address);
}
