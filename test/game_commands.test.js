import assert from "node:assert/strict";
import test from "node:test";
import { importGamePgn, readGameHistory, readGameJob, refreshGames, utcDateRange } from "../game_commands.js";

const game = {
  source: "lichess",
  game_id: "sample",
  url: "https://lichess.org/sample",
  repertoire_id: "book",
  learner: "learner",
  matches: 2,
  deviations: 1,
  first_deviation_ply: 5,
  coverage_gaps: 3,
  opponent_deviations: 1,
  effect: "requested_review",
  prescribed_move: "d2d4",
};

test("date controls include both selected UTC dates across rollover and bound requests", () => {
  const range = utcDateRange("2026-10-31", "2026-11-01");
  assert.equal(range.from_ms, Date.parse("2026-10-31T00:00:00Z"));
  assert.equal(range.to_ms, Date.parse("2026-11-02T00:00:00Z"));
  assert.throws(() => utcDateRange("2026-11-02", "2026-11-01"));
  assert.throws(() => utcDateRange("2026-02-30", "2026-03-01"));
  assert.throws(() => utcDateRange("2026-01-01", "2026-02-01"), /31 UTC days/);
});

test("history and job replies project answer-safe result fields and preserve refresh failures", async t => {
  const report = {
    fetched: 2, new_games: 1, duplicates: 0, matches: 2, deviations: 1,
    errors: ["One game could not be read."], results: [game],
  };
  t.mock.method(globalThis, "fetch", async path => {
    if (path === "/api/games/job") return Response.json({ status: "failed", error: "Rate limited", report });
    if (path === "/api/games") return Response.json({
      results: [{ ...game, url: "javascript:alert(1)" }],
      last_successful_refresh_ms: 1739754000000,
    });
    return Response.json({ status: "error", message: "Choose a repertoire." }, { status: 400 });
  });
  const history = await readGameHistory();
  assert.equal(history.lastSuccessfulRefresh, 1739754000000);
  assert.equal(history.results[0].url, null);
  assert.equal(history.results[0].effect, "requested_review");
  assert.equal(Object.hasOwn(history.results[0], "prescribed_move"), false);
  const job = await readGameJob();
  assert.equal(job.status, "failed");
  assert.equal(job.error, "Rate limited");
  assert.deepEqual(job.report.errors, report.errors);
  assert.equal(job.report.results[0].url, game.url);
  assert.equal(Object.hasOwn(job.report.results[0], "prescribed_move"), false);
  await assert.rejects(importGamePgn({ pgn: "" }), /Choose a repertoire/);
});

test("refresh starts only after an accepted response and sends explicit account and repertoire", async t => {
  const payload = {
    source: "chess_com", account: "learner", repertoire_id: "book",
    ...utcDateRange("2026-11-12", "2026-11-18"),
  };
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 202 }));
  await refreshGames(payload);
  const [[path, options]] = fetch.mock.calls.map(call => call.arguments);
  assert.equal(path, "/api/games/refresh");
  assert.equal(options.method, "POST");
  assert.deepEqual(JSON.parse(options.body), payload);
  fetch.mock.mockImplementation(async () => Response.json({ status: "idle" }));
  await assert.rejects(refreshGames(payload), /did not confirm/);
});
