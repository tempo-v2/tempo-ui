export const CARD_DISCLOSURE_RECHECK_MS = 1500;

const strings = value => Array.isArray(value) && value.every(item => typeof item === "string");

export function validateCardDetails(details) {
  const full = details?.explanation;
  const game = full?.game;
  if (!["opening", "tactic"].includes(details?.kind) || !strings(details.sources) ||
      (full !== undefined && (!full || typeof full.title !== "string" || !strings(full.capture_method) ||
        !strings(full.themes) || !strings(full.links) ||
        (game !== null && (!game || typeof game.white !== "string" || typeof game.black !== "string" ||
          !Number.isSafeInteger(game.half_move) || game.half_move < 1 ||
          (game.finding !== null && typeof game.finding !== "string") ||
          (game.url !== null && typeof game.url !== "string")))))) {
    throw new Error("Tempo could not verify the card details.");
  }
  return details;
}
