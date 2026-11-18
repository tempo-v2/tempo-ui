import { validateStudyView } from "./validate_study_view.js";
import { freeze, string } from "./wire_values.js";

import { commandRecovery, postCommand } from "./content_transport.js";

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
  return validateRepertoireReply(await postCommand("/api/repertoires", command), command.command);
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
  if (reply.status === "error") return validateStudyView(reply);
  if (reply.status === "preview" && command === "preview") {
    return freeze({
      status: reply.status,
      token: string(reply.token, "token", true),
      ...Object.fromEntries(COUNT_FIELDS.map((field) => [field, count(reply[field], field)])),
    });
  }
  if (reply.status !== "repertoires" || command === "preview" || !Array.isArray(reply.repertoires))
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
