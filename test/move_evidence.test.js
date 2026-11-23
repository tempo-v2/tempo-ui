import assert from "node:assert/strict";
import test from "node:test";
import { moveArrow } from "../move_evidence.js";

test("recorded move arrows preserve their source, destination and color", () => {
  assert.deepEqual(moveArrow("e7e8q", "green"), { orig: "e7", dest: "e8", brush: "green" });
});
