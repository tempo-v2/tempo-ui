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
    if (path === "/api/games/job") return Response.json({ dataset_id: "dataset", command_id: "refresh", status: "failed", error: "Rate limited", report });
    if (path === "/api/games") return Response.json({
      results: [
        { ...game, comparison_id: "previous", url: "javascript:alert(1)" },
        { ...game, comparison_id: "current" },
      ],
      last_successful_refresh_ms: 1739754000000,
    });
    return Response.json({ status: "error", code: "invalid_game", retryable: false, message: "Choose a repertoire." }, { status: 400 });
  });
  const history = await readGameHistory();
  assert.equal(history.lastSuccessfulRefresh, 1739754000000);
  assert.equal(history.results[0].url, null);
  assert.equal(history.results[0].game_id, history.results[1].game_id);
  assert.deepEqual(history.results.map(result => result.comparison_id), ["previous", "current"]);
  assert.equal(history.results[0].effect, "requested_review");
  assert.equal(history.results[0].repertoires, null);
  assert.equal(Object.hasOwn(history.results[0], "prescribed_move"), false);
  const job = await readGameJob();
  assert.equal(job.status, "failed");
  assert.equal(job.datasetId, "dataset");
  assert.equal(job.commandId, "refresh");
  assert.equal(job.error, "Rate limited");
  assert.deepEqual(job.report.errors, report.errors);
  assert.equal(job.report.results[0].url, game.url);
  assert.equal(job.report.results[0].comparison_id, null);
  assert.equal(Object.hasOwn(job.report.results[0], "prescribed_move"), false);
  await assert.rejects(importGamePgn({ pgn: "" }), {
    message: "Choose a repertoire.", code: "invalid_game", retryable: false, status: 400,
  });
});

test("refresh starts only after an accepted response and sends explicit account and repertoire", async t => {
  const payload = {
    dataset_id: "dataset", command_id: "refresh",
    source: "chess_com", account: "learner", repertoire_id: "book",
    ...utcDateRange("2026-11-12", "2026-11-18"),
  };
  const acknowledgement = { dataset_id: "dataset", command_id: "refresh", status: "running" };
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json(acknowledgement, { status: 202 }));
  assert.deepEqual(await refreshGames(payload), { status: "running", datasetId: "dataset", commandId: "refresh" });
  const [[path, options]] = fetch.mock.calls.map(call => call.arguments);
  assert.equal(path, "/api/games/refresh");
  assert.equal(options.method, "POST");
  assert.deepEqual(JSON.parse(options.body), payload);
  fetch.mock.mockImplementation(async () => Response.json(acknowledgement));
  await assert.rejects(refreshGames(payload), { status: 200 });
  fetch.mock.mockImplementation(async () => new Response(null, { status: 202 }));
  await assert.rejects(refreshGames(payload));
});

test("a failed archive with a diagnostic preserves zero games fetched", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json({
    dataset_id: "dataset", command_id: "refresh", status: "complete", report: {
      fetched: 0, new_games: 0, duplicates: 0, matches: 0, deviations: 0,
      errors: ["Chess.com 2009/10: Provider request timed out."], results: [],
    },
  }));
  const { report } = await readGameJob();
  assert.equal(report.fetched, 0);
  assert.equal(report.errors.length, 1);
});


test("only an explicit null departure admits known compatible repertoire evidence", async t => {
  const known = { repertoire_id: "book", source_available: true, first_departure: null, reentry_ply: null };
  const result = { ...game, repertoires: [known] };
  const wrap = item => Response.json({ results: [item], last_successful_refresh_ms: null });
  const fetch = t.mock.method(globalThis, "fetch", async () => wrap(result));
  const projected = await readGameHistory();
  assert.deepEqual(projected.results[0].repertoires, [known]);
  for (const first_departure of [undefined, false, { kind: "invented", ply: 1 },
    { kind: "opponent_gap", ply: 0 }]) {
    fetch.mock.mockImplementation(async () => wrap({
      ...result, repertoires: [{ ...known, first_departure }],
    }));
    await assert.rejects(readGameHistory(), /Invalid repertoire/);
  }
  fetch.mock.mockImplementation(async () => wrap({
    ...result,
    repertoires: [{ ...known, first_departure: { kind: "opponent_gap", ply: 2 }, reentry_ply: 4 }],
  }));
  assert.deepEqual((await readGameHistory()).results[0].repertoires[0].first_departure,
    { kind: "opponent_gap", ply: 2 });
});
