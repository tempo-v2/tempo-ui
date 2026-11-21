import { validateCardDetails } from "./card_details.js";
import { UCI } from "./validate_study_view.js";

export function validateAnalysisOrigin(origin, address) {
  const { dataset_id, attempt_id, content_version, revision } = address;
  if (origin?.datasetId !== dataset_id ||
      (attempt_id !== undefined && origin.attemptId !== attempt_id) ||
      (content_version !== undefined && origin.contentVersion !== content_version) ||
      (revision !== undefined && origin.revision !== revision) ||
      typeof origin.fen !== "string" || !["white", "black"].includes(origin.color) ||
      (origin.repertoireId !== null && typeof origin.repertoireId !== "string") ||
      (origin.name !== null && typeof origin.name !== "string") ||
      (origin.playedUci !== null && !UCI.test(origin.playedUci)) || !UCI.test(origin.prescribedUci))
    throw new Error("Tempo could not verify this Study position.");
  if (origin.cardDetails !== undefined) validateCardDetails(origin.cardDetails);
  return origin;
}
