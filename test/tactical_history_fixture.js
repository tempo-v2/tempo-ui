import { Chess } from "chess.js";

export const tacticalFen = "7k/n7/8/8/8/8/8/R5K1 w - - 0 1";
const provenance = { engine: "Stockfish", engine_version: "17.1", configuration_fingerprint: "test-budget" };

function evaluation(good, fen = tacticalFen) {
  return { status: "complete", evaluation: { provenance, depth: 12, nodes: 12000,
    roots: new Chess(fen).moves({ verbose: true }).map(move => {
      const uci = move.from + move.to + (move.promotion ?? "");
      return { uci, bound: "exact", score: { kind: "centipawns", value: uci === good ? 1000 : 0 } };
    }),
  } };
}

export function blackTacticalObservation(id) {
  const row = tacticalObservation(id);
  const fen = "r5k1/8/8/8/8/8/N7/7K b - - 0 12";
  const answer = { uci: "a8a2" };
  row.details.fen = fen;
  row.details.position = fen.split(" ").slice(0, 4).join(" ");
  row.details.side_to_move = "black";
  const assessment = row.details.assessment;
  assessment.played = { uci: "g8g7" };
  assessment.candidates[0].capture = { answer, target: { square: "a2", role: "knight", color: "white" } };
  assessment.analysis = evaluation(answer.uci, fen);
  assessment.standalone_analysis = evaluation(answer.uci, fen);
  assessment.accepted_moves = [answer];
  assessment.puzzle = { fen: fen.replace(/12$/, "1"), answer };
  return row;
}

export function changedSolutionObservation(id) {
  const row = tacticalObservation(id);
  const fen = "7k/n7/8/8/5r2/8/8/R1B3K1 w - - 0 1";
  row.details.fen = fen;
  row.details.position = fen.split(" ").slice(0, 4).join(" ");
  const assessment = row.details.assessment;
  assessment.played = { uci: "g1h2" };
  assessment.candidates.push({ capture: { answer: { uci: "c1f4" }, target: { square: "f4", role: "rook", color: "black" } },
    quality: "best_or_equivalent", score: { kind: "centipawns", value: 1020 } });
  assessment.analysis = evaluation("c1f4", fen);
  for (const root of assessment.analysis.evaluation.roots) {
    if (root.uci === "c1f4") root.score.value = 1020;
    if (root.uci === "a1a7") root.score.value = 1000;
  }
  assessment.standalone_analysis = structuredClone(assessment.analysis);
  assessment.accepted_moves = [{ uci: "a1a7" }, { uci: "c1f4" }];
  assessment.puzzle = { fen, answer: { uci: "c1f4" } };
  // The already fulfilled target still contains the formerly selected Rxa7.
  row.puzzle = { target: "older-rook-capture-card", version: 1 };
  row.fulfilled = true;
  return row;
}

export function tacticalObservation(id, outcome = "missed_good_capture") {
  const uncertain = outcome === "uncertain";
  const inferior = ["took_inferior_capture", "declined_inferior_capture"].includes(outcome);
  const good = inferior ? "g1g2" : "a1a7";
  const analysis = uncertain ? { status: "incomplete", evaluation: null } : evaluation(good);
  if (outcome === "good_alternative") analysis.evaluation.roots.find(root => root.uci === "g1g2").score.value = 990;
  const puzzle = outcome === "missed_good_capture";
  return { id, source: "chess_com", game_id: `game-${id}`, learner: "andy", ply: 0, outcome,
    details: { schema_version: 1, fen: tacticalFen, position: tacticalFen.split(" ").slice(0, 4).join(" "), side_to_move: "white",
      assessment: { kind: "hanging_material", candidates: [{
        capture: { answer: { uci: "a1a7" }, target: { square: "a7", role: "knight", color: "black" } },
        quality: uncertain ? "uncertain" : inferior ? "inferior" : "best_or_equivalent",
        score: uncertain ? null : { kind: "centipawns", value: inferior ? 0 : 1000 },
      }], played: { uci: outcome.startsWith("took_") ? "a1a7" : "g1g2" }, outcome, analysis,
      standalone_analysis: puzzle ? evaluation(good) : null,
      accepted_moves: uncertain ? [] : [{ uci: good }, ...(outcome === "good_alternative" ? [{ uci: "g1g2" }] : [])],
      puzzle: puzzle ? { fen: tacticalFen, answer: { uci: "a1a7" } } : null, equivalence_cp: 30 },
    }, puzzle: puzzle ? { target: "tactic-game", version: 1 } : null,
    request_id: puzzle ? id : null, fulfilled: false, analysis_version: "analysis-one",
  };
}

export function tacticalReport({ dataset = "tactics-fixture", status = "ready", observations = [tacticalObservation(3), tacticalObservation(2, "good_alternative"), tacticalObservation(1, "declined_inferior_capture")], nextBefore = null } = {}) {
  const outcomes = {};
  for (const row of observations) outcomes[row.outcome] = (outcomes[row.outcome] ?? 0) + 1;
  return { schema_version: 1, dataset_id: dataset, status,
    detector: { id: "hanging-material", revision: "1", configuration_fingerprint: "detector-config", label: "Hanging material" },
    analysis_version: "analysis-one", last_error: null, active_game: null,
    statistics: { completed_games: 4, failed_games: 0, timed_out_games: 0, unsupported_games: 0,
      pending_games: 0, decisions_scanned: 40, observations: observations.length, outcomes,
      pending_requests: observations.filter(row => row.request_id !== null && !row.fulfilled).length },
    observations, next_before: nextBefore,
  };
}
