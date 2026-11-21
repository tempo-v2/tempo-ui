import { gapDraft } from "./game_commands.js";
import { pendingRepertoireEntry } from "./repertoire_recovery.js";

export const staleGapCodes = new Set(["stale_coverage", "stale_dataset", "stale_draft", "stale_gap", "stale_preview", "stale_repertoire", "suspended_repertoire", "unavailable_repertoire"]);

export function gapKey(gap) {
  return JSON.stringify([gap.repertoire_id, gap.position, gap.actual_move]);
}

export function gapAddress(datasetId, gap) {
  return {
    dataset_id: datasetId, repertoire_id: gap.repertoire_id, position: gap.position,
    actual_move: gap.actual_move, document_revision: gap.document_revision,
    ...(Object.hasOwn(gap, "gap_kind") ? { gap_kind: gap.gap_kind } : {}),
  };
}

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
        !Number.isSafeInteger(saved.gap.offset)) return null;
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
