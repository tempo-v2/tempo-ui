import { Chess } from "chess.js";

const buckets = ["white", "draws", "black"];
const groups = ["current", "other"];
const uci = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const text = value => typeof value === "string" && value.length > 0;

function invalid() {
  throw new Error("Tempo could not read this source’s move evidence.");
}

function legalMove(value, legal) {
  return typeof value === "string" && uci.test(value) && legal.has(value);
}

function uniqueMoves(rows, legal, validRow) {
  if (!Array.isArray(rows)) return false;
  const seen = new Set();
  return rows.every(row => {
    if (!record(row) || !legalMove(row.uci, legal) || seen.has(row.uci) || !validRow(row)) return false;
    seen.add(row.uci);
    return true;
  });
}

function counts(row) {
  return record(row) && buckets.every(key => count(row[key])) &&
    Number.isSafeInteger(row.white + row.draws + row.black);
}

export function checkedExplorer(data, legal) {
  if (!counts(data) || !uniqueMoves(data.moves, legal, counts)) invalid();
  for (const key of buckets) {
    let returned = 0;
    for (const row of data.moves) {
      returned += row[key];
      if (!Number.isSafeInteger(returned) || returned > data[key]) invalid();
    }
  }
  return data;
}

export function checkedMaia(data, legal) {
  if (!record(data) || !record(data.probabilities) || !text(data.profile) ||
      data.terminal !== (legal.size === 0)) invalid();
  const moves = Object.entries(data.probabilities);
  if (moves.length !== legal.size || moves.some(([move, probability]) =>
    !legalMove(move, legal) || !Number.isFinite(probability) || probability < 0)) invalid();
  const expected = data.terminal ? 0 : 1;
  if (Math.abs(moves.reduce((mass, [, probability]) => mass + probability, 0) - expected) > 1e-8) invalid();
  return data;
}

export function checkedStockfish(data, legal) {
  if (!record(data) || !text(data.engine) || !uniqueMoves(data.candidates, legal, row =>
    (Number.isSafeInteger(row.centipawns) && row.mate == null) ||
    (Number.isSafeInteger(row.mate) && row.centipawns == null))) invalid();
  return data;
}

function nearbyPositions(positions, legal) {
  return Array.isArray(positions) && positions.every(position => {
    if (!record(position) || !text(position.fen) || !Array.isArray(position.responses) ||
        (position.distance !== undefined && !count(position.distance))) return false;
    const example = new Chess(position.fen);
    const moves = new Set(example.moves({ verbose: true })
      .map(move => move.from + move.to + (move.promotion ?? "")));
    return position.responses.every(response =>
      record(response) && text(response.repertoire_id) && text(response.san) &&
      legalMove(response.uci, moves) && typeof response.reusable === "boolean" &&
      (!response.reusable || legal.has(response.uci)));
  });
}

function checkedNearby(data, legal) {
  if (!record(data) || !record(data.repertoire_names) ||
      !Object.values(data.repertoire_names).every(name => typeof name === "string") ||
      !record(data.nearby) || !record(data.similar_responses) ||
      !groups.every(group => nearbyPositions(data.nearby[group], legal) &&
        uniqueMoves(data.similar_responses[group], legal, row =>
          count(row.position_count) && row.position_count > 0))) invalid();
  return data;
}

export function checkedPositionEvidence(source, data, legal) {
  switch (source) {
    case "masters":
    case "rated":
      return checkedExplorer(data, legal);
    case "maia":
      return checkedMaia(data, legal);
    case "stockfish":
      if (typeof data?.comparison_complete !== "boolean") invalid();
      return checkedStockfish(data, legal);
    case "repertoire":
      if (!Array.isArray(data?.exact) || !data.exact.every(row =>
        record(row) && legalMove(row.uci, legal) && text(row.repertoire_id))) invalid();
      return checkedNearby(data, legal);
    default:
      return invalid();
  }
}

function checkedRecommendation(value, legal) {
  if (!record(value) || !legalMove(value.uci, legal)) invalid();
  if (value.basis === "similar" && groups.includes(value.scope) && count(value.position_count) &&
      value.position_count > 0 && count(value.loss_centipawns)) return value;
  if (value.basis === "stockfish" && count(value.nearest_loss_centipawns)) return value;
  return invalid();
}

export function checkedGapAnalysis(result, legal) {
  if (result.status !== "running" && result.status !== "complete") invalid();
  const checked = { status: result.status };
  if (result.nearby != null) {
    try {
      const { nearby, similar_responses, repertoire_names } = checkedNearby(result, legal);
      Object.assign(checked, { nearby, similar_responses, repertoire_names });
    } catch {
      checked.neighbors_error = "Tempo could not read the nearby repertoire positions.";
    }
  } else if (result.neighbors_error != null) {
    checked.neighbors_error = text(result.neighbors_error)
      ? result.neighbors_error : "Nearby repertoire positions are unavailable.";
  }
  if (result.stockfish != null) {
    try {
      checked.stockfish = checkedStockfish(result.stockfish, legal);
    } catch {
      checked.stockfish_error = "Tempo could not read the Stockfish candidates.";
    }
  } else if (result.stockfish_error != null || result.status === "complete") {
    checked.stockfish_error = text(result.stockfish_error)
      ? result.stockfish_error : "Stockfish is unavailable.";
  }
  if (result.status === "complete" && checked.stockfish && checked.nearby &&
      result.recommendation != null) {
    try {
      checked.recommendation = checkedRecommendation(result.recommendation, legal);
    } catch {
      // An invalid recommendation does not invalidate either underlying source.
    }
  }
  return checked;
}

export function checkedGapExplorer(result, legal) {
  if (result.status === "running") return { status: "running" };
  if (result.status === "complete") return {
    status: "complete",
    statistics: checkedExplorer(result.statistics, legal),
  };
  if (result.status === "unavailable" && text(result.code) &&
      (result.token_path === undefined || text(result.token_path))) return {
    status: "unavailable",
    code: result.code,
    token_path: result.token_path,
  };
  return invalid();
}
