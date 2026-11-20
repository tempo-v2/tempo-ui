// Run from the assembled workspace against a built Tempo and packaged UI.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Chess } from "chess.js";

const { chromium } = await import(process.env.TEMPO_PLAYWRIGHT || "playwright");
const binary = resolve(process.env.TEMPO_BINARY || "target/debug/tempo");
const ui = resolve("tempo-ui/dist");
const previous = process.env.TEMPO_PREVIOUS_RELEASE;
const temp = await mkdtemp(join(tmpdir(), "tempo-lichess-"));
const start = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const pgn = '[Event "Fixture puzzle"]\n[SetUp "1"]\n[FEN "' + start + '"]\n\n1... c5 2. Nf3 d6 3. d4 *';
const submission = "00000000-0000-4000-8000-000000000001";
let browser, server;

async function serve(db, exe = binary, assets = ui, port = "0") {
  server = spawn(exe, ["serve", db, assets, port], { stdio: ["ignore", "pipe", "inherit"] });
  const lines = createInterface({ input: server.stdout });
  return Promise.race([
    once(lines, "line").then(([line]) => line.replace("Tempo study at ", "")),
    once(server, "exit").then(([code]) => { throw new Error("Tempo exited with " + code); }),
  ]);
}

async function stop() {
  if (!server || server.exitCode !== null) return;
  const exited = once(server, "exit");
  server.kill();
  await exited;
  server = null;
}

async function post(url, path, payload) {
  const response = await fetch(url + path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  assert.equal(response.status, 200);
  return response.json();
}

function durable(db) {
  const [row] = JSON.parse(execFileSync("sqlite3", ["-json", db,
    "SELECT (SELECT count(*) FROM assessments) AS assessments, " +
    "(SELECT count(*) FROM receipts) AS receipts, " +
    "(SELECT id FROM receipts ORDER BY id LIMIT 1) AS receipt_id, " +
    "(SELECT json_extract(record,'$.input.grade') FROM assessments LIMIT 1) AS grade, " +
    "(SELECT json_extract(state,'$.due') FROM learning LIMIT 1) AS due, " +
    "(SELECT json_extract(state,'$.miss_revision') FROM learning LIMIT 1) AS miss_revision"], { encoding: "utf8" }));
  return row;
}

function verifyAnalysis(destination, color = "black") {
  const url = new URL(destination);
  assert.equal(url.origin, "https://lichess.org");
  assert.equal(url.searchParams.get("color"), color);
  const board = new Chess();
  board.loadPgn(decodeURIComponent(url.pathname.slice("/analysis/pgn/".length)));
  assert.equal(board.history({ verbose: true })[0].before, start);
  assert.deepEqual(board.history(), ["c5", "Nf3", "d6", "d4"]);
}

async function session() {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript((id) => {
    let sequence = 0;
    crypto.randomUUID = () => sequence++ === 0 ? id : "00000000-0000-4000-8000-" +
      String(sequence).padStart(12, "0");
  }, submission);
  let resolveExternal;
  const destination = new Promise(resolve => { resolveExternal = resolve; });
  await context.route("https://lichess.org/**", async route => {
    assert.equal(route.request().headers().referer, undefined);
    await route.fulfill({ contentType: "text/html", body: "<p>Lichess test destination</p>" });
    resolveExternal(route.request().url());
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const button = name => page.getByRole("button", { name, exact: true });
  const link = () => page.getByRole("link", { name: "Analyze line in Lichess", exact: true });
  return { context, page, button, link, destination, errors };
}

try {
  const seed = join(temp, "baseline.sqlite");
  const seedExe = previous ? join(previous, "tempo") : binary;
  execFileSync(seedExe, ["init", seed]);
  const seedUrl = await serve(seed, seedExe, previous ? join(previous, "ui") : ui);
  const { dataset_id } = await post(seedUrl, "/api/study", { command: "study_status" });
  const draft = { dataset_id, pgn, selections: [] };
  const preview = await post(seedUrl, "/api/tactics", { command: "preview", ...draft });
  assert.equal(preview.status, "tactics_preview", JSON.stringify(preview));
  const saved = await post(seedUrl, "/api/tactics", { command: "save", ...draft, token: preview.token, selected: [0] });
  assert.equal(saved.status, "tactics_saved", JSON.stringify(saved));
  const issued = await post(seedUrl, "/api/study", { command: "next" });
  assert.equal(issued.activity, "test");
  await stop();

  browser = await chromium.launch({ channel: "chrome", headless: true });
  const results = [];
  for (const metadata of ["original", "renamed", "omitted"]) {
    const db = join(temp, metadata + ".sqlite");
    await copyFile(seed, db);
    const url = await serve(db);
    const { context, page, button, link, destination, errors } = await session();
    const commands = [];
    await page.route("**/api/study", async route => {
      const raw = route.request().postData();
      const { command } = JSON.parse(raw);
      if (command !== "study_status") commands.push(raw);
      if (metadata === "original") return route.continue();
      const response = await route.fetch();
      const view = await response.json();
      if (view.attempt_id) {
        if (metadata === "omitted") delete view.exercise_name;
        else view.exercise_name = "Renamed puzzle";
      }
      await route.fulfill({ response, json: view });
    });
    await page.goto(url);
    await button("Analyze in Lichess").waitFor();
    assert.equal(await button("Analyze in Lichess").textContent(), "↗ Lichess");
    await button("Analyze in Lichess").focus();
    assert.equal(await button("Analyze in Lichess").evaluate(el => getComputedStyle(el).whiteSpace), "nowrap");
    await page.keyboard.press("Enter");
    await button("Cancel").click();
    assert.equal(context.pages().length, 1);
    assert.deepEqual(commands.map(raw => JSON.parse(raw).command), ["next"]);
    assert.equal(durable(db).assessments, 0);

    await button("Flip board").click();
    await button("Analyze in Lichess").click();
    await button("Record Again and analyze").click();
    await link().waitFor();
    const sent = await Promise.race([destination, page.waitForTimeout(5000).then(() => {
      throw new Error("Study did not open Lichess");
    })]);
    verifyAnalysis(sent, "white");
    assert.equal(new URL(await link().getAttribute("href")).searchParams.get("color"), "black");
    assert.deepEqual(errors, []);
    assert.equal(context.pages().length, 2);
    const tab = context.pages().find(item => item !== page);
    await tab.getByText("Lichess test destination").waitFor();
    assert.equal(await tab.evaluate(() => window.opener), null);
    assert.equal(durable(db).assessments, 1);
    assert.equal(durable(db).receipts, 1);
    assert.equal(durable(db).receipt_id, JSON.parse(commands.at(-1)).submission_id);
    results.push({ sent, commands, durable: durable(db) });
    await context.close();
    await stop();
  }
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results[0], results[2]);
  console.log("Study cancel and Lichess launch, four puzzle plies, isolated tab and display-name invariance passed.");

  for (const origin of previous ? ["candidate", "previous-accepted", "previous-unaccepted"] : ["candidate"]) {
    const db = join(temp, origin + ".sqlite");
    await copyFile(seed, db);
    const archived = origin.startsWith("previous");
    const url = await serve(db, archived ? join(previous, "tempo") : binary, archived ? join(previous, "ui") : ui);
    const { context, page, button, link, errors } = await session();
    const concessions = [];
    let acceptedBytes;
    await page.route("**/api/study", async route => {
      const raw = route.request().postData();
      if (JSON.parse(raw).command !== "concede") return route.continue();
      concessions.push(raw);
      if (concessions.length > 1) {
        const replay = await route.fetch();
        if (acceptedBytes) assert.equal(await replay.text(), acceptedBytes);
        return route.fulfill({ response: replay });
      }
      if (origin !== "previous-unaccepted") acceptedBytes = await (await route.fetch()).text();
      return route.abort();
    });
    await page.goto(url);
    await button(archived ? "Analyze" : "Analyze in Lichess").click();
    await button("Record Again and analyze").click();
    await button("Retry").waitFor();
    assert.equal(durable(db).assessments, origin === "previous-unaccepted" ? 0 : 1);
    if (archived) {
      await stop();
      await serve(db, binary, ui, new URL(url).port);
    }
    let lineReads = 0;
    page.on("request", request => { if (request.url().endsWith("/api/study/analysis-line")) lineReads++; });
    await page.reload();
    await page.getByRole("group", { name: "Analysis board" }).waitFor();
    assert.equal(context.pages().length, 1);
    assert.equal(lineReads, 0);
    await button("Analyze in Lichess").click();
    await link().waitFor();
    verifyAnalysis(await link().getAttribute("href"));
    assert.equal(context.pages().length, 2);
    assert.equal(lineReads, 1);
    assert.equal(concessions.length, 2);
    assert.equal(concessions[0], concessions[1]);
    assert.equal(durable(db).assessments, 1);
    assert.equal(durable(db).receipts, 1);
    assert.deepEqual(errors, []);
    await context.close();
    await stop();
  }
  console.log("Lost-response recovery replayed the original concession once and offered a manual link.");

  {
    const db = join(temp, "navigated-tab.sqlite");
    await copyFile(seed, db);
    const url = await serve(db);
    const { context, page, button, link, destination, errors } = await session();
    const hold = Promise.withResolvers();
    await page.route("**/api/study/analysis-line", async route => {
      await hold.promise;
      await route.continue();
    });
    const otherPage = "https://example.test/manual-tab";
    await context.route(otherPage, route => route.fulfill({ body: "User navigation" }));
    await page.goto(url);
    await button("Analyze in Lichess").click();
    const reserved = context.waitForEvent("page");
    await button("Record Again and analyze").click();
    const tab = await reserved;
    try {
      await tab.goto(otherPage);
    } finally {
      hold.resolve();
    }
    await link().click();
    verifyAnalysis(await destination);
    assert.equal(tab.url(), otherPage);
    assert.deepEqual(errors, []);
    assert.equal(durable(db).assessments, 1);
    await context.close();
    await stop();
  }
  console.log("A repurposed tab stayed open and Tempo offered the manual link.");

  {
    const db = join(temp, "position-failure.sqlite");
    await copyFile(seed, db);
    const url = await serve(db);
    const { context, page, button, link, destination } = await session();
    await page.route("**/api/study/analysis-context", route => route.abort(), { times: 1 });
    await page.goto(url);
    await button("Analyze in Lichess").click();
    const reserved = context.waitForEvent("page");
    await button("Record Again and analyze").click();
    const tab = await reserved;
    if (!tab.isClosed()) await tab.waitForEvent("close");
    await button("Retry opening position").click();
    await page.getByRole("group", { name: "Analysis board" }).waitFor();
    assert.equal(context.pages().length, 1);
    assert.equal(durable(db).assessments, 1);
    await button("Analyze in Lichess").click();
    verifyAnalysis(await destination);
    await link().waitFor();
    await context.close();
    await stop();
  }
  console.log("A failed analysis position read closed the reserved tab and allowed manual recovery.");

  {
    const db = join(temp, "line-failure.sqlite");
    await copyFile(seed, db);
    const url = await serve(db);
    const { context, page, button, link, destination, errors } = await session();
    let attempts = 0;
    await page.route("**/api/study/analysis-line", async route => {
      attempts++;
      if (attempts === 1) return route.fulfill({ json: { scope: "full_line", line: {} } });
      if (attempts === 2) return route.abort();
      return route.continue();
    });
    await page.goto(url);
    await button("Flip board").click();
    await button("Analyze in Lichess").click();
    await button("Record Again and analyze").click();
    const board = page.getByRole("group", { name: "Analysis board" });
    await board.waitFor();
    await page.getByText("Try ↗ Lichess again.", { exact: false }).waitFor();
    assert.equal(await board.getAttribute("data-orientation"), "black");
    assert.equal(durable(db).assessments, 1);
    await button("Analyze in Lichess").click();
    await page.getByText("Try ↗ Lichess again.", { exact: false }).waitFor();
    assert.equal(attempts, 2);
    assert.equal(await board.isVisible(), true);
    await button("Analyze in Lichess").click();
    verifyAnalysis(await destination);
    await link().waitFor();
    assert.equal(new URL(await link().getAttribute("href")).searchParams.get("color"), "black");
    assert.equal(durable(db).assessments, 1);
    assert.deepEqual(errors, []);
    await context.close();
    await stop();
  }
  console.log("Export failures left the analysis board open and retry used its orientation.");

  {
    const db = join(temp, "document-failure.sqlite");
    execFileSync(binary, ["init", db]);
    const url = await serve(db);
    const { dataset_id } = await post(url, "/api/study", { command: "study_status" });
    const draft = { dataset_id, name: "Review fixture", learner_color: "white", pgn: "1. e4 e5 *" };
    const preview = await post(url, "/api/repertoires", { command: "preview", ...draft });
    assert.equal(preview.status, "preview", JSON.stringify(preview));
    const saved = await post(url, "/api/repertoires", { command: "save", ...draft, token: preview.token });
    assert.equal(saved.status, "repertoires", JSON.stringify(saved));
    const { context, page, button, errors } = await session();
    await page.goto(url);
    // Break the optional document path after startup on this disposable fixture.
    const sql = statement => execFileSync("sqlite3", [db, statement]);
    sql("ALTER TABLE repertoire_documents RENAME TO unavailable_documents");
    let exports = 0;
    page.on("request", request => { if (request.url().endsWith("/api/study/analysis-line")) exports++; });
    await button("Analyze").click();
    await page.getByRole("group", { name: "Analysis board" }).waitFor();
    assert.equal(exports, 0);
    async function expectReadFailure(code) {
      const received = Promise.withResolvers();
      await page.route("**/api/study/analysis-line", async route => {
        try {
          const reply = await route.fetch();
          received.resolve({ status: reply.status(), body: await reply.json() });
          await route.fulfill({ response: reply });
        } catch (error) {
          received.reject(error);
          await route.abort();
        }
      }, { times: 1 });
      await button("Analyze in Lichess").click();
      const { status, body } = await received.promise;
      assert.equal(status, 400);
      assert.equal(body.code, code);
      await page.getByText("Could not load the analysis line.", { exact: false }).waitFor();
      assert.equal(await page.getByRole("group", { name: "Analysis board" }).isVisible(), true);
      assert.equal(await page.getByText("Issued move only").count(), 0);
    }
    await expectReadFailure("store_unavailable");
    sql("ALTER TABLE unavailable_documents RENAME TO repertoire_documents");
    sql("UPDATE content_sources SET pgn = '1. impossible *'");
    await expectReadFailure("analysis_line_invalid");
    assert.equal(durable(db).assessments, 0);
    assert.deepEqual(errors, []);
    await context.close();
    await stop();
  }
  console.log("Document lookup and parser failures stayed separate from a legitimate issued-move fallback.");

  const db = join(temp, "completed.sqlite");
  await copyFile(seed, db);
  const url = await serve(db);
  const { context, page, button, link, errors } = await session();
  const commands = [];
  let failNext = false;
  await page.route("**/api/study", async route => {
    const { command } = route.request().postDataJSON();
    if (command !== "study_status") commands.push(command);
    if (command === "next" && failNext) {
      failNext = false;
      return route.abort();
    }
    return route.continue();
  });
  await page.goto(url);
  const board = page.getByRole("group", { name: "Study chessboard" });
  await board.waitFor();
  const surface = await board.locator("cg-board").boundingBox();
  assert(surface && surface.width > 100);
  async function clickSquare(square) {
    const file = "hgfedcba".indexOf(square[0]);
    const rank = Number(square[1]) - 1;
    await page.mouse.click(surface.x + (file + 0.5) * surface.width / 8,
      surface.y + (rank + 0.5) * surface.height / 8);
  }
  await clickSquare("c7");
  await clickSquare("c5");
  await page.getByText("Move 2 of 2", { exact: true }).waitFor();
  failNext = true;
  await clickSquare("d7");
  await clickSquare("d6");
  await button("Retry next exercise").waitFor();
  await page.getByText("Review recorded as Good.", { exact: true }).waitFor();
  assert.equal(durable(db).assessments, 1);
  await button("Retry next exercise").click();
  await button("Retry next exercise").waitFor({ state: "hidden" });
  assert.deepEqual(commands, ["next", "answer", "answer", "next", "next"]);
  assert.equal(durable(db).assessments, 1);
  await button("Tactics").click();
  await button("Fixture puzzle").click();
  await button("Show solution").waitFor();
  assert.equal(await link().count(), 0);
  await button("Show solution").click();
  await link().waitFor();
  const exported = await link().getAttribute("href");
  verifyAnalysis(exported);
  await button("2. Nf3").click();
  assert.equal(await link().getAttribute("href"), exported);
  assert.deepEqual(errors, []);
  await context.close();
  console.log("Interrupted Next preserved the saved result and Retry only sent Next.");
  console.log("Tactics Collection exported the revealed solution independently of the replay cursor.");
} finally {
  await browser?.close();
  await stop();
  await rm(temp, { recursive: true, force: true });
}
