import test from "node:test";
import assert from "node:assert/strict";
import { validateTacticReply } from "../tactic_commands.js";

test("mixed capture preview keeps invalid rows and validates selectable route offsets", () => {
  const preview = {
    schema_version: 4, status: "tactics_preview", token: "exact-input",
    rows: [
      { record: 0, status: "valid", solver_fen: "FEN", solution: ["e2e4"] },
      { record: 1, status: "invalid", message: "Illegal SAN" },
      { record: 2, status: "selection_required",
        routes: [{ route: 0, moves: [{ san: "e4", fen_before: "FEN" }] }] },
    ],
  };
  const validated = validateTacticReply(preview, "preview");
  assert.deepEqual(validated.rows.map((row) => row.status), ["valid", "invalid", "selection_required"]);
  assert.equal(validated.rows[1].message, "Illegal SAN");
  assert.equal(validated.rows[2].routes[0].moves[0].san, "e4");
  assert.ok(Object.isFrozen(validated.rows[2]));
  assert.throws(() => validateTacticReply({ ...preview, rows: [preview.rows[0], preview.rows[0]] }, "preview"), /Duplicate/);
});
