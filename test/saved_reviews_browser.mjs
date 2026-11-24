import { setIntroductionLimits } from "./study_settings_fixture.js";
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
let database = join(directory, "study.sqlite");
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
      label: "Two-move tactic",
      provenance: ["tempo1:capture:fixture", "tempo1:source_kind:game", "https://lichess.org/fixture"],
      solver_fen, solution,
    }],
  }));
  execFileSync(binary, ["init", database]);

  execFileSync(binary, ["import-tactics", database, transfer]);
  let url = await start();
  await setIntroductionLimits(url, 0, 1);
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const desktop = await browser.newContext();
  const page = await desktop.newPage();
  page.setDefaultTimeout(10_000);
  sql = new DatabaseSync(database, { readOnly: true });
  const studyTables = ["store_state", "attempts", "learning", "assessments", "receipts"];
  const studyData = () => studyTables.map(table => sql.prepare(`SELECT * FROM ${table}`).all());
  const button = name => page.getByRole("button", { name, exact: true });
  async function openSavedReviews() {
    await button("Study shortcuts").click();
    await button("Saved for review").click();
  }
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
  assert.equal(await button("Card details").count(), 0);
  const flip = button("Flip board");
  const orientation = page.locator(".study-board .orientation-white");
  await orientation.waitFor();
  await flip.hover();
  const flipHint = page.getByRole("tooltip");
  await flipHint.waitFor();
  assert.equal(await flipHint.innerText(), "Flip board F");
  assert.equal(await flip.getAttribute("aria-keyshortcuts"), "F");
  await page.keyboard.press("f");
  await page.locator(".study-board .orientation-black").waitFor();
  await page.keyboard.press("f");
  await orientation.waitFor();
  assert.deepEqual(studyCommands, ["next"]);
  assert.equal(firstMark, undefined);
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
    const reply = tab.waitForResponse(response => response.url().endsWith("/api/study/review-mark"));
    await tab.getByRole("button", { name: "Review later", exact: true }).click();
    const response = await reply;
    assert.equal(response.status(), 200, "the packaged route should accept the mark");
    const marked = await response.json();
    assert.equal(marked.status, "saved", JSON.stringify(marked));
    await tab.getByText("Saved for review.", { exact: true }).waitFor({ timeout: 10_000 });
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
  const toast = page.locator(".ui-toast").getByText("Saved for review.", { exact: true });
  const layout = () => page.locator("main").evaluate(main => ({
    height: main.scrollHeight,
    navigation: document.querySelector('nav[aria-label="Tempo sections"]').getBoundingClientRect().top,
  }));
  const beforeMark = await layout();
  await markButton.click();
  await toast.waitFor();
  assert.deepEqual(await layout(), beforeMark);
  const bounds = await toast.boundingBox();
  const viewport = page.viewportSize();
  assert.ok(bounds && viewport);
  assert.equal(viewport.width - bounds.x - bounds.width, 16);
  assert.equal(viewport.height - bounds.y - bounds.height, 16);
  await toast.waitFor({ state: "detached" });
  assert.deepEqual(await layout(), beforeMark);
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
  await openSavedReviews();
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
  async function play(uci, surface = board) {
    await surface.scrollIntoViewIfNeeded();
    const box = await surface.boundingBox();
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
  assert.equal(second.origin.cardDetails, undefined);
  const savedDetails = await reviews({ command: "card_details", id: list.rows[0].id });
  assert.equal(savedDetails.details.kind, "tactic");
  assert.deepEqual(savedDetails.details.sources, ["Personal capture"]);
  assert.deepEqual(savedDetails.details.explanation.capture_method, ["Captured from a game"]);
  const studyBeforeReview = studyData();
  await openSavedReviews();
  await button("Open analysis").first().click();
  await page.getByRole("heading", { name: "Analysis board" }).waitFor();
  await page.getByText(/Issued Study move · Nf3/).waitFor();
  await button("Return").click();
  await button("Remove saved mark").last().click();
  await page.getByText("Removed from saved reviews.", { exact: true }).waitFor();
  await button("Back to Study").click();
  await button("Practice tactics").waitFor();
  assert.deepEqual(studyData(), studyBeforeReview);
  assert.equal((await save(firstMark)).id, firstId);
  assert.deepEqual((await reviews({ command: "list" })).rows.map(row => row.id), [list.rows[0].id]);
  const studyTab = await desktop.newPage();
  await studyTab.goto(url);
  const practiceButton = studyTab.getByRole("button", { name: "Practice tactics", exact: true });
  await practiceButton.waitFor();
  await page.bringToFront();
  await openSavedReviews();
  await button("Open analysis").click();
  await page.getByText(/Issued Study move · Nf3/).waitFor();

  let releasePractice;
  let practiceQueued;
  let practiceReceived;
  const holdPractice = new Promise(resolve => { releasePractice = resolve; });
  const pendingPractice = new Promise(resolve => { practiceQueued = resolve; });
  const acceptedPractice = new Promise(resolve => { practiceReceived = resolve; });
  await studyTab.route("**/api/study", async route => {
    if (route.request().postDataJSON().command !== "practice_tactics") return route.continue();
    practiceQueued();
    await holdPractice;
    const upstream = await route.fetch();
    practiceReceived(await upstream.json());
    await route.abort();
  });
  await practiceButton.click();
  await pendingPractice;
  await page.bringToFront();
  const invalidated = page.getByText(/Study changed in another tab/);
  await invalidated.waitFor();
  assert.equal((await reviews({ command: "open", id: list.rows[0].id })).status, "review_context");
  assert.equal(await page.getByText(/Issued Study move/).count(), 0);
  releasePractice();
  const practice = await acceptedPractice;
  assert.equal(practice.activity, "practice");
  assert.equal(practice.target_id, issued.target_id);
  await invalidated.waitFor();
  assert.equal(await page.getByLabel("Analysis board", { exact: true }).count(), 0);
  await button("Return").click();
  await button("Open analysis").click();
  await page.getByText("Finish in Study to open analysis.", { exact: true }).waitFor();
  await post("/api/study", {
    command: "abandon", dataset_id: practice.dataset_id, attempt_id: practice.attempt_id,
    expected_revision: practice.revision, submission_id: "leave-other-tab",
  });
  await button("Check again").click();
  await page.getByText(/Issued Study move · Nf3/).waitFor();
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.getByText(/Issued Study move · Nf3/).waitFor({ state: "detached" });
  // A separate device changes Study without publishing a browser storage event.
  const otherDevice = await post("/api/study", { command: "practice_tactics" });
  assert.equal(otherDevice.target_id, issued.target_id);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.getByText("Finish in Study to open analysis.", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Analysis board", { exact: true }).count(), 0);
  await post("/api/study", {
    command: "abandon", dataset_id: otherDevice.dataset_id, attempt_id: otherDevice.attempt_id,
    expected_revision: otherDevice.revision, submission_id: "leave-other-device",
  });
  await button("Check again").click();
  await page.getByText(/Issued Study move · Nf3/).waitFor();
  const checks = "**/api/study/saved-reviews";
  const checkDelay = Promise.withResolvers();
  const holdPeriodicChecks = async route => {
    if (route.request().postDataJSON().command === "check") await checkDelay.promise;
    await route.continue().catch(() => {});
  };
  await page.route(checks, holdPeriodicChecks);
  const beforeDetails = await post("/api/study", { command: "practice_tactics" });
  assert.equal(beforeDetails.target_id, issued.target_id);
  const detailReply = page.waitForResponse(reply =>
    reply.url().endsWith("/api/study/saved-reviews") && reply.request().postDataJSON().command === "card_details");
  await button("Card details").click();
  assert.equal((await (await detailReply).json()).status, "study_required");
  await page.getByText("Finish in Study to open analysis.", { exact: true }).waitFor();
  assert.equal(await page.getByText("Captured from a game", { exact: true }).count(), 0);
  checkDelay.resolve();
  await page.unroute(checks, holdPeriodicChecks);
  await post("/api/study", {
    command: "abandon", dataset_id: beforeDetails.dataset_id, attempt_id: beforeDetails.attempt_id,
    expected_revision: beforeDetails.revision, submission_id: "leave-before-details",
  });

  await button("Check again").click();
  await page.getByText(/Issued Study move · Nf3/).waitFor();
  const whileVisible = await post("/api/study", { command: "practice_tactics" });
  assert.equal(whileVisible.target_id, issued.target_id);
  await page.getByText("Finish in Study to open analysis.", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Analysis board", { exact: true }).count(), 0);
  await post("/api/study", {
    command: "abandon", dataset_id: whileVisible.dataset_id, attempt_id: whileVisible.attempt_id,
    expected_revision: whileVisible.revision, submission_id: "leave-while-visible",
  });
  await button("Return").click();
  await studyTab.close();
  assert.deepEqual(errors, []);

  sql.close();
  sql = null;
  await stop();
  url = await start();
  assert.equal((await reviews({ command: "open", id: list.rows[0].id })).origin.prescribedUci, "g1f3");
  await page.goto(url);
  await button("Practice tactics").waitFor();
  await openSavedReviews();
  await button("Remove from Study").click();
  await page.getByRole("dialog", { name: "Remove this tactic from Study?" })
    .getByRole("button", { name: "Remove from Study", exact: true }).click();
  await page.getByText("Removed from Study", { exact: true }).waitFor();
  const refreshed = page.waitForResponse(reply =>
    reply.url().endsWith("/api/study") && reply.request().postDataJSON().command === "next");
  await button("Back to Study").click();
  assert.equal((await (await refreshed).json()).can_practice_tactics, false);
  await page.getByText("Done for today.", { exact: true }).waitFor();
  assert.equal(await button("Practice tactics").count(), 0);

  for (const leave of ["skip", "concede"]) {
    await stop();
    database = join(directory, leave + ".sqlite");
    execFileSync(binary, ["init", database]);

    execFileSync(binary, ["import-tactics", database, transfer]);
    url = await start();
    await setIntroductionLimits(url, 0, 1);
    const study = input => post("/api/study", input);
    let startView = await study({ command: "next" });
    const commandFor = (view, command, submission_id) => ({
      command, submission_id, dataset_id: view.dataset_id,
      attempt_id: view.attempt_id, expected_revision: view.revision,
    });
    let firstMark;
    if (leave === "concede") {
      const advanced = await study({ ...commandFor(startView, "answer", "first-run"), answer: { uci: "e2e4" } });
      firstMark = await save({
        dataset_id: advanced.dataset_id, attempt_id: advanced.attempt_id,
        content_version: advanced.content_version, position: { kind: "decision", index: 1 },
        submission_id: "mark-before-resume",
      });
      assert.equal((await study(commandFor(advanced, "skip", "skip-before-resume"))).status, "abandoned");
      startView = await study({ command: "resume_skipped" });
      assert.notEqual(startView.attempt_id, advanced.attempt_id);
    }
    const miss = await study({ ...commandFor(startView, "answer", "miss"), answer: { uci: "d2d4" } });
    assert.equal(miss.assessment, "again");
    const corrected = await study({ ...commandFor(miss, "answer", "correct"), answer: { uci: "e2e4" } });
    assert.equal(corrected.prompt.decision_index, 1);
    const targetAddress = { dataset_id: corrected.dataset_id, attempt_id: corrected.attempt_id,
      content_version: corrected.content_version };
    const marked = await save({ ...targetAddress, position: { kind: "decision", index: 1 }, submission_id: "mark-later" });
    if (firstMark) assert.equal(marked.id, firstMark.id);
    const closed = await study(commandFor(corrected, leave, "end-attempt"));
    assert.equal(closed.status, "abandoned");
    const saved = await post("/api/study/saved-reviews", {
      command: "open", dataset_id: corrected.dataset_id, id: marked.id,
    });
    if (leave === "skip") {
      assert.deepEqual(saved, { status: "study_required", id: marked.id });
    } else {
      assert.equal(saved.origin.prescribedUci, "g1f3");
      assert.equal(saved.origin.fen, corrected.display_fen);
      assert.notEqual(saved.origin.attemptId, corrected.attempt_id);
      const receiptFixture = new DatabaseSync(database);
      try {
        receiptFixture.prepare("UPDATE receipts SET command=? WHERE id=?")
          .run("alternate opaque replay fingerprint", "end-attempt");
      } finally {
        receiptFixture.close();
      }
      const reopened = await post("/api/study/saved-reviews", {
        command: "open", dataset_id: corrected.dataset_id, id: marked.id,
      });
      assert.deepEqual(reopened, saved);
    }
  }
  await stop();
  database = join(directory, "remove-from-study.sqlite");
  execFileSync(binary, ["init", database]);

  execFileSync(binary, ["import-tactics", database, transfer]);
  url = await start();
  await setIntroductionLimits(url, 0, 1);
  sql = new DatabaseSync(database, { readOnly: true });
  const removeNext = page.waitForResponse(reply => reply.url().endsWith("/api/study"));
  await page.goto(url);
  const removeCard = await (await removeNext).json();
  const removedDataset = { dataset_id: removeCard.dataset_id };
  await markButton.click();
  await toast.waitFor();
  await openSavedReviews();
  await button("Remove from Study").click();
  const dialog = page.getByRole("dialog", { name: "Remove this tactic from Study?" });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(sql.prepare("SELECT count(*) AS count FROM study_exclusions").get().count, 0);

  const { promise: acceptedRemoval, resolve: acceptRemoval } = Promise.withResolvers();
  const sent = [];
  await page.route("**/api/study/saved-reviews", async route => {
    if (route.request().postDataJSON().command !== "exclude_tactic") return route.continue();
    sent.push(route.request().postData());
    if (sent.length > 1) return route.continue();
    acceptRemoval(await (await route.fetch()).json());
    await route.abort();
  });
  await button("Remove from Study").click();
  await dialog.getByRole("button", { name: "Remove from Study", exact: true }).click();
  await button("Retry removing from Study").waitFor();
  assert.equal((await acceptedRemoval).status, "excluded");
  await button("Retry removing from Study").click();
  await page.getByText("Removed from Study", { exact: true }).waitFor();
  await button("Open analysis").click();
  await page.getByText(/Issued Study move · e4/).waitFor();
  await button("Card details").click();
  await page.getByText("Captured from a game", { exact: true }).waitFor();
  await button("Return").click();
  assert.deepEqual(sent, [sent[0], sent[0]]);
  assert.equal(sql.prepare("SELECT count(*) AS count FROM study_exclusions").get().count, 1);
  assert.equal(sql.prepare("SELECT count(*) AS count FROM assessments").get().count, 0);
  assert.equal(sql.prepare("SELECT count(*) AS count FROM saved_reviews").get().count, 1);
  const stale = await post("/api/study", {
    command: "answer", ...removedDataset, attempt_id: removeCard.attempt_id,
    expected_revision: removeCard.revision, submission_id: "old-after-removal",
    answer: { uci: "e2e4" },
  });
  assert.equal(stale.code, "stale_activity");
  await button("Back to Study").click();
  await page.getByText("Done for today.", { exact: true }).waitFor();
  assert.equal(await button("Practice tactics").count(), 0);
  await page.unroute("**/api/study/saved-reviews");
  sql.close();
  sql = null;
  await stop();
  execFileSync(binary, ["import-tactics", database, transfer]);
  url = await start();
  assert.equal((await post("/api/study", { command: "next" })).can_practice_tactics, false);
  assert.equal((await post("/api/study/saved-reviews", {
    ...removedDataset, command: "list",
  })).rows[0].removed_from_study, true);
  const tactic = await post("/api/tactics-collection", {
    ...removedDataset, command: "detail", target: removeCard.target_id,
  });
  assert.equal(tactic.label, "Two-move tactic");
  assert.equal(tactic.removed_from_study, true);
  const due = await post("/api/tactics-collection", { command: "list", filter: "due" });
  assert.deepEqual(due.rows, []);
  const capture = {
    ...removedDataset,
    pgn: `[Event "Repeat excluded capture"]\n[SetUp "1"]\n[FEN "${solver_fen}"]\n[TempoSetupPlies "0"]\n\n1. e4 e5 2. Nf3 Nc6 *`,
  };
  const capturePreview = await post("/api/tactics", { command: "preview", ...capture });
  const savedAgain = await post("/api/tactics", {
    command: "save", ...capture, token: capturePreview.token, selected: [0],
  });
  assert.equal(savedAgain.status, "tactics_saved", JSON.stringify(savedAgain));
  assert.equal(savedAgain.ready_for_review, 0);
  assert.equal((await post("/api/study", { command: "next" })).can_practice_tactics, false);
  await stop();

  database = join(directory, "analysis-save-review.sqlite");
  execFileSync(binary, ["init", database]);

  url = await start();
  await setIntroductionLimits(url, 1, 0);
  const repertoire = input => post("/api/repertoires", input);
  const catalog = await repertoire({ command: "list" });
  const book = { dataset_id: catalog.dataset_id, name: "Save while interrupted",
    learner_color: "white", pgn: "1. e4 *" };
  const preview = await repertoire({ command: "preview", ...book });
  assert(preview.token);
  await repertoire({ command: "save", ...book, token: preview.token });
  const openingTab = await desktop.newPage();
  await openingTab.goto(url);
  await openingTab.getByText("Play e4 on the board.").waitFor();
  await page.goto(url);
  await markButton.click();
  await page.getByText("Saved for review.", { exact: true }).waitFor();
  await openSavedReviews();
  await button("Open analysis").waitFor();
  assert.equal(await button("Remove from Study").count(), 0);
  const openingMark = (await post("/api/study/saved-reviews", {
    dataset_id: book.dataset_id, command: "list",
  })).rows[0];
  assert.equal((await post("/api/study/saved-reviews", { dataset_id: book.dataset_id,
    command: "exclude_tactic", id: openingMark.id, submission_id: "cannot-exclude-opening",
  })).status, "error");
  await button("Open analysis").click();
  await page.getByText(/Issued Study move · e4/).waitFor();
  await play("d2d4", page.locator(".analysis-layout cg-board"));
  await button("Mark line").click();
  await button("Preview changes").click();
  await button("Save repertoire").waitFor();

  const saveBodies = [];
  await page.route("**/api/repertoires", async route => {
    if (route.request().postDataJSON().command !== "save") return route.continue();
    saveBodies.push(route.request().postData());
    if (saveBodies.length > 1) return route.continue();
    const upstream = await route.fetch();
    assert.equal((await upstream.json()).status, "repertoires");
    await route.abort();
  });
  await button("Save repertoire").click();
  await button("Retry save").waitFor();
  await openingTab.reload();
  await page.bringToFront();
  await page.getByText(/Study changed in another tab/).waitFor();
  assert.equal(await page.getByLabel("Analysis board", { exact: true }).count(), 0);
  await button("Retry save").click();
  await page.getByText("Repertoire saved.", { exact: true }).waitFor();
  assert.deepEqual(saveBodies, [saveBodies[0], saveBodies[0]]);
  assert.equal(await page.getByLabel("Analysis board", { exact: true }).count(), 0);
  await button("Return").click();
  await page.getByRole("heading", { name: "Saved for review", exact: true }).waitFor();
  await openingTab.close();
  await button("Back to Study").click();
  await button("Tactics").click();
  await button("Study settings").click();
  await page.getByLabel("New tactics per day").fill("3");
  await button("Save settings").click();
  const settingsToast = page.locator(".ui-toast").getByText("Study settings saved.", { exact: true });
  await settingsToast.waitFor();
  await button("Study").click();
  await page.getByRole("navigation", { name: "Tempo sections" }).waitFor();
  assert(await settingsToast.isVisible());
  console.log("Desktop Chrome verified exact multi-move marks, skipped/active blind protection, automatic advance, removal, and restart.");
} finally {
  sql?.close();
  await browser?.close();
  await stop();
  await rm(directory, { recursive: true, force: true });
}
