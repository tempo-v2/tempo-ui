import { validateStudyView } from "./validate_study_view.js";
import { freeze, string } from "./wire_values.js";

const STORAGE_KEY = "tempo-repertoire-recovery-v4";

export function readPendingRepertoireCommand() {
  return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "null");
}

export function hasPendingRepertoireCommand() {
  try {
    return !!readPendingRepertoireCommand();
  } catch {
    return false;
  }
}

export function savePendingRepertoireCommand(command) {
  if (command) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(command));
  else sessionStorage.removeItem(STORAGE_KEY);
}

export async function sendRepertoireCommand(command) {
  const response = await fetch("/api/repertoires", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  if (!response.ok) throw new Error(`Server returned ${response.status}`);
  return validateRepertoireReply(await response.json(), command.command);
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
