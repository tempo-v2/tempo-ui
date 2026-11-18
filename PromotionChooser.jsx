import React from "react";
import { Button, Dialog } from "@tempo-v2/core-components";
import { promotionRoles } from "./promotion_roles.js";
export function PromotionChooser({ choice, onChoose, onCancel }) {
  return (
    <Dialog open={!!choice} title="Choose promotion" onClose={onCancel}>
      <div className="actions">
        {["q", "r", "b", "n"]
          .filter((x) => choice?.moves.includes(x))
          .map((x) => (
            <Button key={x} onClick={() => onChoose(choice, x)}>
              {promotionRoles[x]}
            </Button>
          ))}
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </Dialog>
  );
}
