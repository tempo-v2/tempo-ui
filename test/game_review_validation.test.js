import assert from "node:assert/strict";
import test from "node:test";
import { Chess } from "chess.js";
import { validateGameReview } from "../validate_game_review.js";

const board = new Chess();
const first = board.fen();
board.move("e4");
const second = board.fen();
const address = {dataset_id:"dataset", source:"pgn", game_id:"game", learner:"white", repertoire_id:"book"};
const base = {
  ...address, status:"review", white:"White", black:"Black", result:"1-0", learner_color:"white",
  document_id:"authored", revision:7,
  comparison:{repertoire_id:"book", source_available:true, first_departure:null, reentry_ply:null},
  positions:[
    {fen:first, played_uci:"e2e4", book_state:"position", prepared_uci:["e2e4"], introduced:false, other_route:null},
    {fen:second, played_uci:null, book_state:"endpoint", prepared_uci:[], introduced:null, other_route:null},
  ],
  line:[],
};

test("a review accepts addressed board facts and rejects malformed or mismatched facts", () => {
  assert.equal(validateGameReview(base,address),base);
  for (const corrupt of [
    value => value.dataset_id = "other",
    value => value.comparison.repertoire_id = "other",
    value => value.document_id = null,
    value => value.revision = -1,
    value => value.positions[0].introduced = "false",
    value => value.positions[0].prepared_uci = ["e3e4"],
    value => value.positions[0].played_uci = null,
    value => value.positions[1].played_uci = "a7a6",
    value => value.positions[1].other_route = ["d2d4"],
    value => value.positions[1].fen = first,
    value => value.comparison.first_departure = {kind:"learner_move",ply:2},
    value => value.comparison.reentry_ply = 3,
  ]) {
    const invalid = structuredClone(base);
    corrupt(invalid);
    assert.throws(() => validateGameReview(invalid,address), /could not be verified/);
  }
});

test("an explored edge must start at the addressed game board and echo each requested legal move", () => {
  const addressWithLine = {...address, line:{from_ply:1, moves:["e7e5"]}};
  const result = {...base, line:[{fen:second, uci:"e7e5", book_state:"endpoint", prepared_uci:[]}]};
  assert.equal(validateGameReview(result,addressWithLine),result);
  for (const line of [[], [{...result.line[0],uci:"c7c5"}], [{...result.line[0],fen:first}]]) {
    assert.throws(() => validateGameReview({...result,line},addressWithLine), /could not be verified/);
  }
});
