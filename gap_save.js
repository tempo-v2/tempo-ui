import { gapDraft } from "./game_commands.js";
import { pendingRepertoireEntry } from "./repertoire_recovery.js";

export const staleGapCodes = new Set(["stale_dataset", "stale_draft", "stale_gap", "stale_preview", "stale_repertoire", "unavailable_repertoire"]);

export function repertoireError(reply) {
  return Object.assign(new Error(reply.message), { code: reply.code });
}

export async function previewGapResponse(gap, response, signal) {
  const next = await gapDraft({
    ...gap.address,
    response,
    base_revision: gap.details.content_revision,
  }, signal);
  if (next.content_revision !== gap.details.content_revision ||
      typeof next.draft?.pgn !== "string" || typeof next.save_token !== "string" || !next.save_token) {
    throw Object.assign(new Error("The gap preview is no longer current. Reopen it before saving."), { code: "stale_repertoire" });
  }
  return {
    command: "save",
    dataset_id: gap.address.dataset_id,
    repertoire_id: gap.address.repertoire_id,
    name: next.repertoire_name,
    learner_color: next.learner_color,
    pgn: next.draft.pgn,
    token: next.save_token,
  };
}

const continuationKey = "tempo-gap-save-continuation-v1";

export function readGapContinuation() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(continuationKey) || "null");
    const entry = pendingRepertoireEntry();
    const pending = entry?.command;
    if (!saved?.token || !saved.gap?.address?.dataset_id || !saved.gap.address.repertoire_id ||
        !saved.gap.details?.draft?.legal_moves?.includes(saved.response) ||
        !Array.isArray(saved.gap.passed) || !Number.isSafeInteger(saved.gap.offset)) return null;
    if (pending) return pending.command === "save" && pending.token === saved.token &&
      pending.dataset_id === saved.gap.address.dataset_id && pending.repertoire_id === saved.gap.address.repertoire_id
      ? { ...saved, loadPending: entry.load } : null;
    return saved.accepted ? saved : null;
  } catch {
    return null;
  }
}

export function writeGapContinuation(value) {
  if (value) sessionStorage.setItem(continuationKey, JSON.stringify(value));
  else sessionStorage.removeItem(continuationKey);
}
