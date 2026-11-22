import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const { chromium } = await import(process.env.TEMPO_PLAYWRIGHT || "playwright");
const binary = resolve(process.env.TEMPO_BINARY || "target/debug/tempo");
const dist = process.env.TEMPO_UI_DIST || fileURLToPath(new URL("../dist/", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "tempo-study-settings-"));
const database = join(directory, "study.sqlite");
let server, browser, sql;
try {
  execFileSync(binary, ["init", database]);
  const retired = spawnSync(binary, ["configure", database, "0", "0"], { encoding: "utf8" });
  assert.equal(retired.status, 1);
  assert.match(retired.stderr, /Study settings/);

  server = spawn(binary, ["serve", database, dist, "0"], { stdio: ["ignore", "pipe", "inherit"] });
  const output = createInterface({ input: server.stdout });
  const url = await Promise.race([
    (async () => {
      for await (const line of output) {
        const match = /^Tempo study at (http:\/\/127\.0\.0\.1:\d+)$/.exec(line);
        if (match) return match[1];
      }
      throw Error("No startup address");
    })(),
    once(server, "exit").then(([code]) => { throw Error(`Tempo exited (${code})`); }),
  ]);
  sql = new DatabaseSync(database, { readOnly: true });
  const epochs = () => sql.prepare(
    "SELECT hex(membership_epoch) AS membership, hex(summary_epoch) AS summary FROM study_projection_state"
  ).get();
  const profile = () => JSON.parse(sql.prepare("SELECT local_profile FROM store_state").get().local_profile);
  const initial = profile();
  const before = epochs();
  const post = async (path, command) => {
    const response = await fetch(url + path, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command),
    });
    const reply = await response.json();
    assert.equal(response.status, 200, JSON.stringify(reply));
    return reply;
  };

  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage();
  const button = name => page.getByRole("button", { name, exact: true });
  await page.goto(url);
  await button("Tactics").click();
  await button("Study settings").click();
  const openings = page.getByLabel("New opening positions per day");
  const tactics = page.getByLabel("New tactics per day");
  await openings.waitFor();
  assert.equal(Number(await openings.inputValue()), initial.introductions.repertoire);
  assert.equal(Number(await tactics.inputValue()), initial.introductions.tactics);
  const save = async () => {
    const response = page.waitForResponse(reply => reply.url().endsWith("/api/tactic-settings")
      && reply.request().postDataJSON().command === "save");
    await button("Save settings").click();
    const saved = await response;
    assert.equal(saved.status(), 200);
    return saved.json();
  };

  await openings.fill("0");
  const changed = await save();
  assert.equal(changed.new_openings_per_day, 0);
  assert.equal(changed.new_tactics_per_day, initial.introductions.tactics);
  const after = epochs();
  assert.equal(BigInt("0x" + after.membership), BigInt("0x" + before.membership) + 1n);
  assert.equal(BigInt("0x" + after.summary), BigInt("0x" + before.summary) + 1n);
  assert.deepEqual(await save(), changed);
  assert.deepEqual(epochs(), after);
  assert.deepEqual(profile(), {
    ...initial,
    introductions: { ...initial.introductions, repertoire: 0 },
    tactic_themes: changed.selection,
  });

  const repertoire = command => post("/api/repertoires", command);
  const book = { dataset_id: changed.dataset_id, name: "Settings fixture", learner_color: "white", pgn: "1. e4 *" };
  const preview = await repertoire({ command: "preview", ...book });
  assert.ok(preview.token);
  await repertoire({ command: "save", ...book, token: preview.token });
  const next = () => post("/api/study", { command: "next" });
  assert.equal((await next()).status, "empty");
  await openings.fill("1");
  await save();
  const lesson = await next();
  assert.equal(lesson.status, "ready");
  assert.equal(lesson.activity, "teach");
} finally {
  sql?.close();
  await browser?.close();
  if (server && server.exitCode == null && server.signalCode == null) {
    const exit = once(server, "exit");
    server.kill();
    await exit;
  }
  await rm(directory, { recursive: true, force: true });
}
