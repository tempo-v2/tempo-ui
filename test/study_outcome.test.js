import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const result = await build({
  entryPoints: [fileURLToPath(new URL("../StudyOutcome.jsx", import.meta.url))],
  bundle: true,
  packages: "external",
  format: "cjs",
  write: false,
});
const output = { exports: {} };
new Function("require", "module", result.outputFiles[0].text)(createRequire(import.meta.url), output);
const { StudyOutcome, celebratesTactic } = output.exports;

test("terminal correction renders Again even when the latest move is correct", () => {
  const view = { status: "complete", activity: "test", assessment: "again", feedback: { correct: true } };
  assert.equal(celebratesTactic(view), false);
  assert.match(renderToStaticMarkup(React.createElement(StudyOutcome, { view })), /Completed after correction.*Again/);
  assert.equal(celebratesTactic({ ...view, assessment: "good" }), true);
  assert.equal(celebratesTactic({ ...view, assessment: "good", status: "ready" }), false);
  assert.match(renderToStaticMarkup(React.createElement(StudyOutcome, { view: { ...view, activity: "practice" } })),
    /Practice completed after correction. Schedule unchanged/);
});
