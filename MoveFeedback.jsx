import React from "react";
import { StatusNotice } from "@tempo-v2/core-components";
import { promotionRoles } from "./promotion_roles.js";

export function MoveFeedback({ view }) {
  const move = view?.feedback?.correction_uci;
  if (!move) return null;
  const role = promotionRoles[move[4]];
  return (
    <StatusNotice kind="error">
      {view.feedback.message} Move {move.slice(0, 2)} to {move.slice(2, 4)}
      {role ? ` and promote to ${role.toLowerCase()}` : ""}.
      {view.activity === "practice" && " Schedule unchanged."}
    </StatusNotice>
  );
}
