import { commandRecovery, postCommand } from "./content_transport.js";
import { freeze, string, validateErrorView } from "./wire_values.js";

export const tacticRecovery = commandRecovery("tempo-tactics-recovery-v4");

export function hasPendingTacticCommand() {
  try {
    return !!tacticRecovery.load();
  } catch {
    return false;
  }
}

export async function sendTacticCommand(command) {
  return validateTacticReply(await postCommand("/api/tactics", command), command.command);
}

const ROW_STATUSES = new Set(["valid", "selection_required", "invalid"]);
const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

function integer(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`Invalid ${name}`);
  return value;
}

function validateRow(row) {
  if (!row || !ROW_STATUSES.has(row.status)) throw new TypeError("Unknown tactic preview status");
  const result = { record: integer(row.record, "record index"), status: row.status };
  for (const key of ["label", "message", "solver_fen", "learner_color"]) {
    if (row[key] != null) result[key] = string(row[key], key, true);
  }
  if (row.status === "valid" &&
      (!result.solver_fen || !Array.isArray(row.solution) || !row.solution.length ||
       row.solution.some((move) => typeof move !== "string" || !UCI.test(move)))) {
    throw new TypeError("Invalid solver position or solution");
  }
  if (row.status === "valid") result.solution = [...row.solution];
  if (row.capture_identity != null) result.capture_identity = string(row.capture_identity, "capture identity", true);
  if (row.replay != null) {
    if (!Array.isArray(row.replay.moves) || row.replay.moves.length !== result.solution?.length)
      throw new TypeError("Invalid capture replay");
    result.replay = {
      start_fen: string(row.replay.start_fen, "replay start", true),
      moves: row.replay.moves.map(({ notation, fen }) => ({
        notation: string(notation, "replay move", true),
        fen: string(fen, "replay position", true),
      })),
    };
  }
  if (row.routes != null && !Array.isArray(row.routes)) throw new TypeError("Invalid variation list");
  result.routes = (row.routes ?? []).map((route) => {
    if (!Array.isArray(route?.moves)) throw new TypeError("Invalid game variation");
    return {
      route: integer(route.route, "route index"),
      moves: route.moves.map((move) => ({
        san: string(move.san, "SAN move", true),
        fen_before: string(move.fen_before, "position", true),
      })),
    };
  });
  if (row.alternate_solutions != null)
    result.alternate_solutions = integer(row.alternate_solutions, "alternate solution count");
  return result;
}

export function validateTacticReply(reply, command) {
  if (!reply || typeof reply !== "object" || reply.schema_version !== 4)
    throw new TypeError("Expected a tactic reply with schema_version 4");
  if (reply.status === "error") return validateErrorView(reply);
  if (command === "preview" && reply.status === "tactics_preview" && Array.isArray(reply.rows)) {
    const rows = reply.rows.map(validateRow);
    if (new Set(rows.map((row) => row.record)).size !== rows.length)
      throw new TypeError("Duplicate tactic record");
    return freeze({ status: reply.status, token: string(reply.token, "token", true), rows });
  }
  if (command === "save" && reply.status === "tactics_saved") {
    return freeze({
      status: reply.status,
      count: integer(reply.count, "saved count"),
      ...(reply.ready_for_review !== undefined && { ready_for_review: integer(reply.ready_for_review, "ready for review count") }),
      alternate_solutions: integer(reply.alternate_solutions ?? 0, "alternate solution count"),
    });
  }
  throw new TypeError("Invalid tactic capture reply");
}
