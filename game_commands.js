import { string } from "./wire_values.js";

const endpoint = "/api/games";
export const utcDayMs = 86_400_000;
export const maxGameCommandBytes = 2 * 1024 * 1024;

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

function gameResults(results) {
  if (!Array.isArray(results)) throw new TypeError("Invalid game results");
  return results.map(result => {
    const effect = result.effect;
    if (!Object.hasOwn(gameEffects, effect)) throw new TypeError("Invalid Study effect");
    const firstDeviation = result.first_deviation_ply;
    return {
      comparison_id: result.comparison_id === undefined
        ? null : string(result.comparison_id, "comparison_id", true),
      source: string(result.source, "source", true),
      game_id: string(result.game_id, "game_id", true),
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
      repertoires: (result.repertoires ?? []).map(book => ({
        repertoire_id: string(book.repertoire_id, "comparison repertoire", true),
        source_available: book.source_available === true,
        first_departure: book.first_departure ?? null,
        reentry_ply: book.reentry_ply ?? null,
      })),
      effect,
    };
  });
}

function safeGameLink(link) {
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

async function request(path, payload, signal) {
  const json = payload === undefined ? undefined : JSON.stringify(payload);
  if (path === "/import" && new TextEncoder().encode(json).length > maxGameCommandBytes) {
    throw new Error("This PGN import exceeds 2 MiB. Split the games into smaller batches.");
  }
  const init = json === undefined
    ? { cache: "no-store", signal }
    : {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: json,
        signal,
      };
  const response = await fetch(endpoint + path, init);
  if (response.status === 202 && path === "/refresh") return;
  let body;
  try { body = await response.json(); } catch {
    throw new Error(`Unexpected Games response (HTTP ${response.status}).`);
  }
  if (!response.ok || body?.status === "error") {
    const error = new Error(body?.message || body?.error || `Games request failed (HTTP ${response.status}).`);
    error.code = body?.code;
    throw error;
  }
  if (path === "/refresh") throw new Error("Tempo did not confirm that the refresh started.");
  return body;
}

export async function readGameHistory(signal) {
  const reply = await request("", undefined, signal);
  return {
    results: gameResults(reply.results),
    lastSuccessfulRefresh: reply.last_successful_refresh_ms === null
      ? null : count(reply.last_successful_refresh_ms, "last_successful_refresh_ms"),
  };
}

export async function readGameJob(signal) {
  const reply = await request("/job", undefined, signal);
  switch (reply.status) {
    case "idle":
    case "running":
      return { status: reply.status, commandId: reply.command_id ?? null };
    case "complete":
      return { status: "complete", commandId: reply.command_id ?? null, report: gameReport(reply.report) };
    case "failed":
      return {
        status: "failed",
        commandId: reply.command_id ?? null,
        error: string(reply.error, "refresh error", true),
        report: reply.report ? gameReport(reply.report) : null,
      };
    default:
      throw new TypeError("Invalid game refresh status");
  }
}

export async function refreshGames(payload, signal) {
  await request("/refresh", payload, signal);
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

export const historicalStatus = signal => request("/backfill", undefined, signal);
export const startHistorical = (payload, signal) => request("/backfill", payload, signal);
export const retryHistorical = (payload, signal) => request("/backfill/retry", payload, signal);

export async function modelStatus(signal) {
  const reply = await request("/model", undefined, signal);
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

export const startModel = (payload, signal) => request("/model", payload, signal);
export const readGaps = (signal, offset = 0) => request("/gaps", offset ? { offset } : undefined, signal);
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
