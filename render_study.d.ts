import type { StudyView } from "./study_view.js";
import type { RenderState } from "./study_controller.js";

/** Pure escaped HTML; consumers attach events using the data-action attributes. */
export function renderStudy(
  view: StudyView | null,
  state?: Partial<RenderState>,
): string;
