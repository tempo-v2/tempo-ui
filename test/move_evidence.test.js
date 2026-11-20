import assert from "node:assert/strict";
import test from "node:test";
import {candidateMoves, leadingMeasuredMoves, measurementText, probabilityCells} from "../move_evidence.js";
import {matchesReviewEvidence} from "../position_evidence.js";

test("a full probability distribution only contributes its positive leading moves", () => {
  const probabilities = {a2a3:0,a2a4:.1,b2b3:.2,b2b4:.3,c2c3:.4};
  const cells = probabilityCells({probabilities});
  const rows = candidateMoves(new Set(Object.keys(probabilities)), [["a2a3"],leadingMeasuredMoves(cells)]);
  assert.deepEqual(rows,["a2a3","c2c3","b2b4","b2b3"]);
  assert.equal(measurementText(cells.a2a3,{data:true}),"0.0%");
  assert.equal(measurementText(undefined,{data:true}),"—");
  assert.equal(measurementText(undefined,{}),"Checking…");
  assert.equal(measurementText(undefined,{error:"Failed"}),"Unavailable");
});

test("review evidence must echo the addressed scope and contain legal authored moves", () => {
  const options = {dataset_id:"test",repertoire_id:"chosen",review_version:{revision:4,document_id:"source"}};
  const legal = new Set(["e2e4","d2d4"]);
  const result = {dataset_id:"test", repertoire_id:"chosen", document_id:"source", content_revision:4, prepared_uci:["e2e4"]};
  assert(matchesReviewEvidence(result,options,legal));
  for (const changes of [{dataset_id:"other"}, {repertoire_id:"other"}, {document_id:"previous"},
    {content_revision:3}, {prepared_uci:["e2e5"]}, {prepared_uci:null}]) {
    assert.equal(matchesReviewEvidence({...result,...changes},options,legal),false);
  }
});
