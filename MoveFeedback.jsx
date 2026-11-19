import React from "react";
import { StatusNotice } from "@tempo-v2/core-components";
import { moveSan } from "./board_move.js";

export function MoveFeedback({ view }) {
  const move = view?.feedback?.correction_uci;
  if (!move) return null;
  const san = moveSan(view.display_fen, move);
  return (
    <StatusNotice kind="error">
      {view.feedback.message}{san ? ` Play ${san}.` : ""}
      {view.activity === "practice" && " Schedule unchanged."}
    </StatusNotice>
  );
}
