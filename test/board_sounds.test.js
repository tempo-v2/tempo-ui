import assert from "node:assert/strict";
import test from "node:test";
import { createBoardSounds, learnerCue, replyCue } from "../board_sounds.js";

const start = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

test("board cues use move facts and give check priority over capture and promotion", () => {
  for (const [fen, uci, expected] of [
    [start, "e2e4", "move-self"],
    ["4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2", "e5d6", "capture"],
    ["4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 2", "e4d5", "capture"],
    ["r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", "e1g1", "castle"],
    ["4k3/P7/8/8/8/8/8/4K3 w - - 0 1", "a7a8n", "promote"],
    ["4k3/P7/8/8/8/8/8/4K3 w - - 0 1", "a7a8q", "check"],
    ["4k3/4p3/8/8/8/8/4R3/4K3 w - - 0 1", "e2e7", "check"],
  ]) {
    assert.equal(learnerCue(fen, uci), expected, uci);
  }
  assert.equal(replyCue(start, "e2e4", []), null);
  assert.equal(replyCue(start, "e2e4", [{ uci: "e7e5" }]), "move-opponent");
  const exchange = "4k3/8/2p5/3p4/4P3/8/8/4K3 w - - 0 2";
  assert.equal(replyCue(exchange, "e4d5", [{ uci: "c6d5" }]), "capture");
});

test("blocked or late playback stays optional and muting cancels pending audio", async t => {
  const previousAudio = globalThis.Audio;
  const audio = new Map();
  const calls = [];
  globalThis.Audio = class extends EventTarget {
    readyState = 0;
    set src(url) {
      this.url = url;
      audio.set(url, this);
      this.dispatchEvent(new Event("loadeddata"));
    }
    pause() { calls.push(`pause ${this.url}`); }
    play() {
      calls.push(`play ${this.url}`);
      return Promise.reject(new Error("browser blocked playback"));
    }
  };
  const sounds = createBoardSounds(0.5, true);
  t.after(() => {
    sounds.cancel();
    if (previousAudio === undefined) delete globalThis.Audio;
    else globalThis.Audio = previousAudio;
  });
  await sounds.prepare();
  assert.equal(audio.size, 7);
  const url = "/assets/illegal.mp3";
  sounds.play("illegal");
  assert.deepEqual(calls, []);
  audio.get(url).readyState = 2;
  sounds.play("illegal");
  await Promise.resolve();
  assert.deepEqual(calls, [`play ${url}`]);
  audio.get(url).play = () => new Promise(() => {});
  sounds.play("illegal");
  sounds.setEnabled(false);
  assert.ok(calls.includes(`pause ${url}`));
  calls.length = 0;
  sounds.play("illegal");
  assert.deepEqual(calls, []);
});
