import type { StudyView } from "./study_view.js";

/** Reject malformed data and return an immutable copy of a version 1 view. */
export function validateStudyView(value: unknown): StudyView;
