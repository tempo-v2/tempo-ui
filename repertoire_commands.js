import { commandRecovery, postCommand } from "./content_transport.js";
import { freeze, string, validateErrorView } from "./wire_values.js";

const recovery = commandRecovery("tempo-repertoire-recovery-v4");
export const readPendingRepertoireCommand = recovery.load;
export const savePendingRepertoireCommand = recovery.save;

export function hasPendingRepertoireCommand() {
  try {
    return !!recovery.load();
  } catch {
    return false;
  }
}

export async function sendRepertoireCommand(command) {
  const reply = validateRepertoireReply(await postCommand("/api/repertoires", command), command.command);
  if (reply.status === "progress_reset" &&
      (reply.dataset_id !== command.dataset_id || reply.repertoire_id !== command.repertoire_id))
    throw new Error("The reset reply belongs to a different repertoire.");
  return reply;
}

const COUNT_FIELDS = ["positions", "routes", "added", "removed", "changed", "affected_learning"];

function count(value, field) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TypeError(`Invalid repertoire count for ${field}`);
  return value;
}

export function validateRepertoireReply(reply, command) {
  if (!reply || typeof reply !== "object" || reply.schema_version !== 4)
    throw new TypeError("Expected a repertoire reply with schema_version 4");
  if (reply.status === "error") return validateErrorView(reply);
  if (command === "reset_progress") {
    if (reply.status !== "progress_reset") throw new TypeError("Invalid repertoire reset reply");
    return freeze({
      status: "progress_reset",
      dataset_id: string(reply.dataset_id, "dataset_id", true),
      repertoire_id: string(reply.repertoire_id, "repertoire_id", true),
    });
  }
  if (command === "read_document") {
    if (reply.status !== "document" || !["white", "black"].includes(reply.learner_color))
      throw new TypeError("Invalid repertoire document");
    const document = reply.document;
    if (!document || !["available", "unavailable"].includes(document.status))
      throw new TypeError("Invalid repertoire document availability");
    return freeze({
      status: "document",
      dataset_id: string(reply.dataset_id, "dataset_id", true),
      repertoire_id: string(reply.repertoire_id, "repertoire_id", true),
      name: string(reply.name, "name", true),
      learner_color: reply.learner_color,
      revision: count(reply.revision, "revision"),
      document: document.status === "available"
        ? { status: "available", pgn: string(document.pgn, "pgn", true) }
        : { status: "unavailable" },
    });
  }
  const isPreview = command === "preview" || command === "edit_preview";
  if (reply.status === "preview" && isPreview) {
    return freeze({
      status: reply.status,
      token: string(reply.token, "token", true),
      ...Object.fromEntries(COUNT_FIELDS.map((field) => [field, count(reply[field], field)])),
    });
  }
  if (reply.status !== "repertoires" || isPreview || !Array.isArray(reply.repertoires))
    throw new TypeError("Invalid repertoire list");
  return freeze({
    status: reply.status,
    dataset_id: string(reply.dataset_id, "dataset_id", true),
    repertoires: reply.repertoires.map((item) => {
      if (!item || !["white", "black"].includes(item.learner_color))
        throw new TypeError("Invalid repertoire learner color");
      return {
        id: string(item.id, "id", true),
        name: string(item.name, "name", true),
        learner_color: item.learner_color,
        positions: count(item.positions, "positions"),
      };
    }),
  });
}
