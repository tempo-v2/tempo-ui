import assert from "node:assert/strict";
import test from "node:test";
import { deliverDurableRepertoireCommand, previewMarkedLines, readPendingRepertoireCommand } from "../repertoire_commands.js";

test("signed paths preview without writes; uncertain delivery retains the exact save until a terminal reply", async t => {
  const storage = new Map();
  Object.defineProperty(globalThis, "sessionStorage", {configurable:true, value:{
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key),
  }});
  t.after(() => delete globalThis.sessionStorage);

  const path = {dataset_id:"dataset", repertoire_id:"book", name:"Opening", learner_color:"white",
    base_revision:7, anchor_fen:"anchor", lines:[["e2e4"]]};
  const save = {command:"save", token:"signed", dataset_id:"dataset", repertoire_id:"book",
    name:"Opening", learner_color:"white", pgn:"1. e4 *"};
  const preview = {schema_version:4, status:"preview", token:"signed", repertoire_id:"book", save_command:save,
    added:1, removed:0, changed:0, affected_learning:0, routes:1, positions:1, replacements:[], retired_routes:[]};
  const busy = {schema_version:4, status:"error", code:"busy", message:"Try again", retryable:true};
  const saved = {schema_version:4, status:"repertoires", dataset_id:"dataset", repertoires:[]};
  const requests = [];
  const replies = [preview, new Error("response lost"), busy, saved];
  t.mock.method(globalThis, "fetch", async (_, options) => {
    requests.push(JSON.parse(options.body));
    const response = replies.shift();
    if (response instanceof Error) throw response;
    return Response.json(response);
  });
  const signed = await previewMarkedLines(path);
  assert.deepEqual(requests, [{...path, command:"marked_preview"}]);
  assert.equal(await readPendingRepertoireCommand(), null);
  const changes = [];
  const onPending = command => changes.push(command);
  await assert.rejects(deliverDurableRepertoireCommand(signed.save_command, {stored:false,onPending}), /response lost/);
  const restored = await readPendingRepertoireCommand();
  assert.deepEqual(restored, save);
  await assert.rejects(deliverDurableRepertoireCommand({...save, token:"other"}, {stored:false,onPending}), /pending/);
  assert.equal((await deliverDurableRepertoireCommand(restored, {stored:true,onPending})).reply.retryable, true);
  assert.deepEqual(await readPendingRepertoireCommand(), save);
  assert.equal((await deliverDurableRepertoireCommand(restored, {stored:true,onPending})).reply.status, "repertoires");
  assert.deepEqual(requests.slice(1), [save, save, save]);
  assert.deepEqual(changes,[save,null]);
  assert.equal(await readPendingRepertoireCommand(), null);
});
