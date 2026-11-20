// Exercise the desktop list and the real SQLite/Study server on disposable data.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";

const { chromium } = await import(process.env.TEMPO_PLAYWRIGHT || "playwright");
const directory = await mkdtemp(join(tmpdir(), "tempo-saved-reviews-"));
const database = join(directory, "study.sqlite");
const binary = resolve(process.env.TEMPO_BINARY || "target/release/tempo");
const ui = resolve("tempo-ui/dist");
const solver_fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const solution = ["e2e4", "e7e5", "g1f3", "b8c6"];
let server, browser, sql;

async function start() {
  server = spawn(binary, ["serve", database, ui, "0"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const output = createInterface({ input: server.stdout });
  return Promise.race([
    once(output, "line").then(([line]) => line.replace("Tempo study at ", "")),
    once(server, "exit").then(([code]) => { throw Error(`Tempo exited (${code})`); }),
  ]);
}

async function stop() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const exited = once(server, "exit");
  server.kill();
  await exited;
}

try {
  const transfer = join(directory, "tactics.json");
  await writeFile(transfer, JSON.stringify({
    schema_version: 1,
    puzzles: [{
      namespace: "desktop-mark-test", source_id: "two-moves",
      label: "Two-move tactic", provenance: ["mark fixture"], solver_fen, solution,
    }],
  }));
  execFileSync(binary, ["init", database]);
  execFileSync(binary, ["configure", database, "0", "1"]);
  execFileSync(binary, ["import-tactics", database, transfer]);
  let url = await start();
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(10_000);
  sql = new DatabaseSync(database, { readOnly: true });
  const studyTables = ["store_state", "attempts", "learning", "assessments", "receipts"];
  const studyData = () => studyTables.map(table => sql.prepare(`SELECT * FROM ${table}`).all());
  const button = name => page.getByRole("button", { name, exact: true });
  const studyCommands = [];
  const errors = [];
  let firstMark;
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    if (request.url().endsWith("/api/study")) studyCommands.push(request.postDataJSON().command);
    if (request.url().endsWith("/api/study/review-mark")) firstMark ??= request.postDataJSON();
  });
  const post = async (path, command) => {
    const response = await fetch(url + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command),
    });
    assert(response.ok);
    return response.json();
  };
  const nextResponse = page.waitForResponse(reply => reply.url().endsWith("/api/study"));
  await page.goto(url);
  const issued = await (await nextResponse).json();
  const address = { dataset_id: issued.dataset_id };
  const reviews = command => post("/api/study/saved-reviews", { ...address, ...command });
  const save = command => post("/api/study/review-mark", command);
  const markButton = button("Review later");
  await markButton.waitFor();
  const before = studyData();
  for (const exerciseName of ["First label", "Renamed label", null]) {
    const tab = await browser.newPage();
    let submitted;
    await tab.route("**/api/study", async route => {
      const response = await route.fetch();
      const json = await response.json();
      if (exerciseName === null) delete json.exercise_name;
      else json.exercise_name = exerciseName;
      await route.fulfill({ response, json });
    });
    tab.on("request", request => {
      if (request.url().endsWith("/api/study/review-mark")) submitted = request.postDataJSON();
    });
    await tab.goto(url);
    await tab.getByRole("button", { name: "Review later", exact: true }).click();
    await tab.getByText("Saved for review.", { exact: true }).waitFor();
    const { submission_id, ...position } = submitted;
    assert(submission_id);
    assert.deepEqual(position, {
      ...address, attempt_id: issued.attempt_id, content_version: issued.content_version,
      position: { kind: "decision", index: 0 },
    });
    await tab.close();
  }
  const oldTab = await browser.newPage();
  await oldTab.addInitScript(() => sessionStorage.setItem("tempo-pending-review-mark", JSON.stringify({
    dataset_id: "previous-dataset", attempt_id: "old-attempt", content_version: 1,
    position: { kind: "decision", index: 0 }, submission_id: "old-mark",
  })));
  await oldTab.goto(url);
  await oldTab.getByRole("button", { name: "Retry saving for review" }).click();
  await oldTab.getByText("The Study dataset changed.", { exact: true }).waitFor();
  await oldTab.getByRole("button", { name: "Review later", exact: true }).waitFor();
  await oldTab.close();
  await markButton.click();
  await page.getByText("Saved for review.", { exact: true }).waitFor();
  assert.deepEqual(studyData(), before);
  assert.equal((await save({
    ...firstMark, submission_id: "unreached", position: { kind: "decision", index: 1 },
  })).code, "invalid_decision");
  assert.equal((await save({
    ...firstMark, submission_id: "wrong-version", content_version: issued.content_version + 1,
  })).code, "stale_content");
  const firstList = await reviews({ command: "list" });
  assert.equal(firstList.rows.length, 1);
  const firstId = firstList.rows[0].id;
  assert.deepEqual(await reviews({ command: "open", id: firstId }), { status: "study_required", id: firstId });
  assert.deepEqual((await save(firstMark)).status, "saved");

  await button("Skip").click();
  await button("Resume skipped").waitFor();
  const commandCount = studyCommands.length;
  await button("Saved for review").click();
  await button("Open analysis").click();
  await page.getByText("Finish in Study to open analysis.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("heading", { name: "Analysis board" }).count(), 0);
  await button("Back to Study").click();
  await button("Resume skipped").waitFor();
  assert.equal(studyCommands.length, commandCount);
  assert.equal(sql.prepare("SELECT count(*) AS total FROM assessments").get().total, 0);
  await button("Resume skipped").click();
  await markButton.waitFor();
  // A new live attempt on the same card still protects the earlier mark.
  assert.deepEqual(await reviews({ command: "open", id: firstId }), { status: "study_required", id: firstId });
  const board = page.locator(".study-board cg-board");
  async function play(uci) {
    const box = await board.boundingBox();
    assert(box);
    for (const square of [uci.slice(0, 2), uci.slice(2, 4)]) {
      const file = square.charCodeAt(0) - "a".charCodeAt(0);
      const rank = 8 - Number(square[1]);
      await page.mouse.click(box.x + (file + 0.5) * box.width / 8, box.y + (rank + 0.5) * box.height / 8);
    }
  }
  await play("e2e4");
  await page.getByText("Move 2 of 2", { exact: true }).waitFor();
  await button("Save previous response").click();
  await page.getByText("Saved for review.", { exact: true }).waitFor();
  assert.equal((await reviews({ command: "list" })).rows.length, 1);
  await play("g1f3");
  await button("Practice tactics").waitFor();
  await button("Save previous response").click();
  await page.getByText("Saved for review.", { exact: true }).waitFor();
  const list = await reviews({ command: "list" });
  assert.deepEqual(list.rows.map(row => row.decision_index), [1, 0]);
  const first = await reviews({ command: "open", id: firstId });
  assert.equal(first.origin.fen, issued.prompt.fen);
  assert.equal(first.origin.prescribedUci, "e2e4");
  const second = await reviews({ command: "open", id: list.rows[0].id });
  assert.equal(second.origin.prescribedUci, "g1f3");
  const studyBeforeReview = studyData();
  await button("Saved for review").click();
  await button("Open analysis").first().click();
  await page.getByRole("heading", { name: "Analysis board" }).waitFor();
  await page.getByText(/Issued Study move · Nf3/).waitFor();
  await button("Return").click();
  await button("Remove").last().click();
  await page.getByText("Removed from saved reviews.", { exact: true }).waitFor();
  await button("Back to Study").click();
  await button("Practice tactics").waitFor();
  assert.deepEqual(studyData(), studyBeforeReview);
  assert.equal((await save(firstMark)).id, firstId);
  assert.deepEqual((await reviews({ command: "list" })).rows.map(row => row.id), [list.rows[0].id]);
  assert.deepEqual(errors, []);

  sql.close();
  sql = null;
  await stop();
  url = await start();
  assert.equal((await reviews({ command: "open", id: list.rows[0].id })).origin.prescribedUci, "g1f3");
  console.log("Desktop Chrome verified exact multi-move marks, skipped/active blind protection, automatic advance, removal, and restart.");
} finally {
  sql?.close();
  await browser?.close();
  await stop();
  await rm(directory, { recursive: true, force: true });
}
