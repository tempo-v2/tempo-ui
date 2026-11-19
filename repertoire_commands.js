import { boundedRead } from "./bounded_read.js";
import { postCommand } from "./content_transport.js";
import { freeze, string, validateErrorView } from "./wire_values.js";

export {
  hasPendingRepertoireCommand,
  readPendingRepertoireCommand,
  savePendingRepertoireCommand,
} from "./repertoire_recovery.js";

export async function sendRepertoireCommand(command, signal) {
  const reply = validateRepertoireReply(await postCommand("/api/repertoires", command, signal), command.command);
  if (reply.status === "progress_reset" &&
      (reply.dataset_id !== command.dataset_id || reply.repertoire_id !== command.repertoire_id))
    throw new Error("The reset reply belongs to a different repertoire.");
  if (command.command === "marked_preview" && reply.status === "preview") {
    const save = reply.save_command;
    if (save.dataset_id !== command.dataset_id || save.repertoire_id !== (command.repertoire_id ?? null) ||
        save.name !== command.name || save.learner_color !== command.learner_color ||
        (command.repertoire_id && command.repertoire_id !== reply.repertoire_id))
      throw new TypeError("The preview belongs to another repertoire.");
  }
  return reply;
}

export async function readRepertoireCatalog(signal) {
  const reply = await boundedRead(signal, readSignal => sendRepertoireCommand({ command: "list" }, readSignal));
  if (reply.status === "error") throw new Error(reply.message);
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
  const isPreview = ["preview", "edit_preview", "marked_preview"].includes(command);
  if (reply.status === "preview" && isPreview) {
    return freeze({
      status: reply.status,
      token: string(reply.token, "token", true),
      ...(command === "marked_preview" ? markedDetails(reply) : {}),
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

function markedDetails(reply) {
  const save = reply.save_command;
  if (save?.command !== "save" || save.token !== reply.token ||
      !["white", "black"].includes(save.learner_color) || !Array.isArray(reply.replacements) ||
      !Array.isArray(reply.retired_routes)) throw new TypeError("Invalid marked-line preview");
  return {
    repertoire_id: string(reply.repertoire_id, "repertoire_id", true),
    save_command: {
      command: "save", token: save.token,
      dataset_id: string(save.dataset_id, "dataset_id", true),
      repertoire_id: save.repertoire_id === null ? null : string(save.repertoire_id, "repertoire_id", true),
      name: string(save.name, "name", true), learner_color: save.learner_color, pgn: string(save.pgn, "pgn", true),
    },
    replacements: reply.replacements.map(change => ({
      route: string(change.route, "route"), old_move: string(change.old_move, "old_move", true),
      new_move: string(change.new_move, "new_move", true),
    })),
    retired_routes: reply.retired_routes.map(route => string(route, "route", true)),
  };
}
