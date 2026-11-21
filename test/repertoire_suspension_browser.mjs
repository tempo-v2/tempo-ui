// Run against the packaged candidate on a fresh, disposable database.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [binary, assets] = process.argv.slice(2).map(path => resolve(path));
assert.ok(binary && assets, "Pass the Tempo executable and built UI directory.");
const { chromium } = await import(process.env.TEMPO_PLAYWRIGHT || "playwright");
const directory = await mkdtemp(join(tmpdir(), "tempo-suspension-"));
const database = join(directory, "study.sqlite");
const endpoint = "**/api/repertoires";
let server;
let browser;

async function start(port = "0") {
  server = spawn(binary, ["serve", database, assets, port]);
  return new Promise((accept, reject) => {
    let output = "";
    let errors = "";
    const deadline = setTimeout(() => reject(new Error(`Tempo did not start. ${errors}`)), 10_000);
    server.stderr.on("data", chunk => { errors += chunk; });
    server.stdout.on("data", chunk => {
      output += chunk;
      const listening = /^Tempo study at (http:\/\/127\.0\.0\.1:\d+)$/m.exec(output);
      if (listening) {
        clearTimeout(deadline);
        accept(listening[1]);
      }
    });
    server.once("error", reject);
    server.once("exit", code => {
      clearTimeout(deadline);
      reject(new Error(`Tempo exited (${code}). ${errors}`));
    });
  });
}

async function stop() {
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = once(server, "exit");
    server.kill();
    await exited;
  }
}

try {
  execFileSync(binary, ["init-practice", database]);
  const origin = await start();
  const post = async (path, command) => {
    const response = await fetch(origin + "/api/" + path, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const list = await post("repertoires", { command: "list" });
  const input = { dataset_id: list.dataset_id, learner_color: "white", name: "London", pgn: "1. d4 d5 2. Bf4 *" };
  const preview = await post("repertoires", { ...input, command: "preview" });
  const saved = await post("repertoires", { ...input, command: "save", token: preview.token });
  assert.equal(saved.repertoires[0].activity, "active");
  const issued = await post("study", { command: "next" });
  assert.equal(issued.activity, "teach");

  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage();
  const button = name => page.getByRole("button", { name, exact: true });
  await page.goto(origin);
  await button("Repertoires").click();
  await button("Suspend London").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  assert.equal((await post("study", { command: "next" })).attempt_id, issued.attempt_id);

  const sent = [];
  await page.route(endpoint, async route => {
    const request = route.request();
    if (request.postDataJSON().command !== "set_activity") return route.continue();
    sent.push(request.postData());
    if (sent.length > 1) return route.continue();
    const accepted = await route.fetch();
    assert.equal((await accepted.json()).activity, "suspended");
    await route.abort("failed");
  });
  await button("Suspend London").click();
  await dialog.getByRole("button", { name: "Suspend repertoire" }).click();
  await button("Retry activity change").waitFor();
  assert.equal((await post("study", { command: "next" })).done, true);

  await stop();
  assert.equal(await start(new URL(origin).port), origin);
  await page.reload();
  await button("Resume London").waitFor();
  await page.locator(".ui-toast").getByText("London is suspended.", { exact: true }).waitFor();
  assert.deepEqual(sent, [sent[0], sent[0]]);
  assert.equal((await post("study", { command: "next" })).done, true);
  await page.unroute(endpoint);
  await button("Resume London").click();
  await button("Suspend London").waitFor();
  await page.locator(".ui-toast").getByText("London is active.", { exact: true }).waitFor();
  const resumed = await post("study", { command: "next" });
  assert.equal(resumed.activity, "teach");
  assert.equal(resumed.target_id, issued.target_id);
  assert.notEqual(resumed.attempt_id, issued.attempt_id);
  const companion = { ...input, name: "Companion", pgn: "1. d4 Nf6 2. c4 *" };
  const companionPreview = await post("repertoires", { ...companion, command: "preview" });
  assert.equal((await post("repertoires", { ...companion, command: "save", token: companionPreview.token })).status, "repertoires");
  const importGame = (command_id, learner, moves, day) => post("games/import", {
    command_id, learner, dataset_id: list.dataset_id,
    pgn: `[White "${learner}"]\n[Black "Opponent"]\n[Date "2024.10.${day}"]\n\n${moves} 1-0`,
  });
  const choice = await importGame("two-book-choice", "ChoiceLearner", "1. Nf3 Nf6", "01");
  assert.equal(choice.results[0].choices[0].candidates.length, 2);
  await page.reload();
  await button("Repertoires").click();
  await page.getByLabel("Destination").selectOption({ label: "Replace London" });
  await page.getByLabel("Or paste PGN").fill("1. d4 {London System.} d5 2. Bf4 *");
  await button("Preview PGN").click();
  await button("Replace repertoire").waitFor();
  await button("Suspend Companion").click();
  await dialog.getByRole("button", { name: "Suspend repertoire" }).click();
  await button("Resume Companion").waitFor();
  await button("Replace repertoire").click();
  await page.getByText("Repertoire saved.", { exact: true }).waitFor();
  await importGame("game-gap", "GapLearner", "1. d4 Nf6 2. Bf4", "02");
  await button("Study").click();
  await page.getByRole("link", { name: "Games", exact: true }).click();
  await page.getByText("Compare the game again to refresh these corrective choices.").waitFor({state: "attached"});
  assert.equal(await page.getByText("Corrective target for half-move 1").count(), 0);

  await page.getByRole("tab", { name: "Coverage" }).click();
  await button("Fix response").click();
  await page.route("**/api/analysis/evidence", route =>
    route.request().postDataJSON().source === "repertoire" ? route.continue() : route.abort());
  const evidence = page.waitForRequest(request => request.url().endsWith("/api/analysis/evidence")
    && request.postDataJSON().source === "repertoire");
  await button("Analyze lines").click();
  assert.equal((await evidence).postDataJSON().repertoire_scope, "game");
  console.log("Chrome passed suspension recovery, resume, stale game choices and the Games analysis scope.");
} finally {
  await browser?.close();
  await stop();
  await rm(directory, { recursive: true, force: true });
}
