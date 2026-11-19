import { gapDraft } from "./game_commands.js";
import { readPendingRepertoireCommand, sendRepertoireCommand } from "./repertoire_commands.js";

export const staleGapCodes = new Set(["stale_dataset", "stale_draft", "stale_gap", "stale_preview", "stale_repertoire", "unavailable_repertoire"]);

export function repertoireError(reply) {
  return Object.assign(new Error(reply.message), { code: reply.code });
}

export async function previewGapResponse(gap, response, signal) {
  const next = await gapDraft({ ...gap.address, response }, signal);
  if (next.content_revision !== gap.details.content_revision || !next.draft?.pgn) {
    throw Object.assign(new Error("The repertoire changed. Reopen this gap before saving."), { code: "stale_repertoire" });
  }
  const input = {
    dataset_id: gap.address.dataset_id,
    repertoire_id: gap.address.repertoire_id,
    name: next.repertoire_name,
    learner_color: next.learner_color,
    pgn: next.draft.pgn,
  };
  const preview = await sendRepertoireCommand({
    command: "edit_preview",
    ...input,
    base_revision: next.content_revision,
  }, signal);
  if (preview.status === "error") throw repertoireError(preview);
  if (preview.removed || preview.changed || preview.affected_learning) {
    throw new Error("This response would change existing repertoire positions or learning. It was not saved.");
  }
  return { command: "save", ...input, token: preview.token };
}

const continuationKey = "tempo-gap-save-continuation-v1";

export function readGapContinuation() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(continuationKey) || "null");
    const pending = readPendingRepertoireCommand();
    if (!saved?.token || !saved.gap?.address?.dataset_id || !saved.gap.address.repertoire_id ||
        !saved.gap.details?.draft?.legal_moves?.includes(saved.response) ||
        !Array.isArray(saved.gap.passed) || !Number.isSafeInteger(saved.gap.offset)) return null;
    if (pending) return pending.command === "save" && pending.token === saved.token &&
      pending.dataset_id === saved.gap.address.dataset_id && pending.repertoire_id === saved.gap.address.repertoire_id
      ? { ...saved, pending } : null;
    return saved.accepted ? saved : null;
  } catch {
    return null;
  }
}

export function writeGapContinuation(value) {
  if (value) sessionStorage.setItem(continuationKey, JSON.stringify(value));
  else sessionStorage.removeItem(continuationKey);
}
