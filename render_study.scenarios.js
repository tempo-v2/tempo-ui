// Usage scenarios for src/render_study.js, exercised through the public package barrel.
import assert from "node:assert/strict";
import test from "node:test";
import { renderStudy } from "./index.js";
import { ready, complete } from "./view_fixtures.js";

test("rendering escapes external strings and exposes intent controls without solution data", () => {
  const attack = '<img src=x onerror="alert(1)">&\'';
  const html = renderStudy(
    ready({
      prompt: { ...ready().prompt, instruction: attack, fen: attack },
      display_fen: attack,
      feedback: {
        correct: true,
        message: attack,
        autoplay: [{ uci: attack }],
      },
      assessment: "again",
    }),
  );
  assert.equal(html.includes("<img"), false);
  assert.ok(
    html.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;"),
  );
  assert.ok(html.includes('data-action="answer"'));
  assert.ok(html.includes('data-action="abandon"'));
  assert.ok(html.includes("Decision 1 of 2"));
  assert.ok(html.includes("Assessment: again"));
  assert.equal(renderStudy(complete()).includes('data-action="answer"'), false);
  assert.ok(renderStudy(null).includes("Select Next"));
  assert.ok(
    renderStudy({
      schema_version: 4,
      status: "empty",
      dataset_id: "d",
      done: true,
      outstanding: 0,
      repertoire_remaining: 10,
      tactics_remaining: 20,
    }).includes("No eligible"),
  );
});

test("busy and retry presentation disable new intents", () => {
  assert.ok(renderStudy(ready(), { busy: true }).includes('aria-busy="true"'));
  const html = renderStudy(ready(), { canRetry: true });
  assert.ok(html.includes('data-action="next" disabled'));
  assert.ok(html.includes('data-action="retry">Retry'));
});
