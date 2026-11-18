/** Pure presentation of application replies; no network or domain state. */
import { validateStudyView } from "./validate_study_view.js";

function escape(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );
}

/**
 * Use when a caller needs HTML for its latest view and controller state.
 * Returns escaped markup with data-action hooks; the caller binds events and
 * chooses where to put the markup. Passing null displays the initial Next action.
 *
 * @example
 * const html = renderStudy(null, { busy: false, canRetry: false });
 */
export function renderStudy(input, { busy = false, canRetry = false } = {}) {
  const view = input === null ? null : validateStudyView(input);
  const disabled = busy || canRetry ? " disabled" : "";
  const status = view?.status ?? "initial";
  let body = "<p>Select Next to begin.</p>";
  if (status === "ready") {
    body =
      `<p>${escape(view.prompt.instruction)}</p>` +
      `<p>Decision ${view.prompt.decision_index + 1} of ${view.prompt.decision_count}</p>` +
      `<figure><figcaption>Position (board rendering placeholder)</figcaption>` +
      `<pre aria-label="Position FEN">${escape(view.prompt.fen)}</pre></figure>` +
      `<form data-action="answer"><label>Move (UCI) ` +
      `<input name="uci" autocomplete="off" required${disabled}></label>` +
      `<button type="submit"${disabled}>Submit move</button></form>` +
      `<button type="button" data-action="abandon"${disabled}>Abandon exercise</button>`;
  } else if (status === "complete") {
    body = "<p>Exercise complete.</p>";
  } else if (status === "abandoned") {
    body = "<p>Exercise abandoned.</p>";
  } else if (status === "empty") {
    body = "<p>No eligible exercises right now.</p>";
  } else if (status === "error") {
    body = `<p role="alert">${escape(view.message)}</p>`;
  }
  if (view?.feedback) {
    body += `<p role="status">${escape(view.feedback.message)}</p>`;
    if (view.feedback.autoplay.length) {
      body += `<p>Autoplay: ${view.feedback.autoplay.map((move) => escape(move.uci)).join(", ")}</p>`;
    }
  }
  if (view?.assessment) body += `<p>Assessment: ${escape(view.assessment)}</p>`;
  if (canRetry) {
    body +=
      "<p>The previous request needs recovery. Retry sends the same request.</p>" +
      `<button type="button" data-action="retry"${busy ? " disabled" : ""}>Retry</button>`;
  }
  return (
    `<section aria-label="Study" aria-busy="${Boolean(busy)}" data-status="${status}">` +
    `<h2>Study</h2>${body}` +
    `<button type="button" data-action="next"${disabled}>Next exercise</button></section>`
  );
}
