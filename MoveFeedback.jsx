import React from "react";
import { StatusNotice } from "@tempo-v2/core-components";

export function MoveFeedback({ view, tacticClue }) {
  const move = view?.feedback?.correction_uci;
  if (!move) return null;
  const san = view.feedback.correction_san;
  return (
    <StatusNotice kind="error">
      {view.feedback.message}{san ? ` Play ${san}.` : ""}
      {view.activity === "practice" && " Schedule unchanged."}
      {tacticClue && <div id="study-tactic-clue">{tacticClue.text}</div>}
    </StatusNotice>
  );
}
