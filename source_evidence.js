import { Chess } from "chess.js";

const buckets = ["white", "draws", "black"];
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
