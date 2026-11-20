// Run from the assembled workspace after building Tempo and its UI.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";

const { devices, webkit } = await import(process.env.TEMPO_PLAYWRIGHT || "playwright");
const authority = "tempo-study.example.ts.net:8443";
const phoneOrigin = `https://${authority}`;
const login = "owner@example.test";
const serveHeaders = {
  Host: authority,
  "X-Forwarded-Host": authority,
  "X-Forwarded-Proto": "https",
  "Tailscale-User-Login": login,
};
const jsonHeaders = { "Content-Type": "application/json" };
const binary = resolve(process.env.TEMPO_BINARY || "target/release/tempo");
const ui = resolve("tempo-ui/dist");
const scratch = await mkdtemp(join(tmpdir(), "tempo-phone-study-"));
const database = join(scratch, "study.sqlite");
const tactics = [
  { source_id: "kingside", solver_fen: "7k/8/5KQ1/8/8/8/8/8 w - - 0 1", solution: ["g6g7"] },
  { source_id: "queenside", solver_fen: "k7/8/1QK5/8/8/8/8/8 w - - 0 1", solution: ["b6b7"] },
];
let tempo, proxy, browser, sql;

async function tapMove(page, move) {
  const board = page.locator(".study-board cg-board");
  await board.scrollIntoViewIfNeeded();
  const box = await board.boundingBox();
  assert(box);
  for (const square of [move.slice(0, 2), move.slice(2, 4)]) {
    const file = square.charCodeAt(0) - "a".charCodeAt(0);
    const rank = 8 - Number(square[1]);
    await page.touchscreen.tap(
      box.x + (file + 0.5) * box.width / 8,
      box.y + (rank + 0.5) * box.height / 8,
    );
  }
}

try {
  const transfer = join(scratch, "tactics.json");
  await writeFile(transfer, JSON.stringify({
    schema_version: 1,
    puzzles: tactics.map(tactic => ({
      ...tactic, namespace: "phone-test", label: tactic.source_id, provenance: ["phone fixture"],
    })),
  }));
  execFileSync(binary, ["init", database]);
  execFileSync(binary, ["configure", database, "0", "2"]);
  execFileSync(binary, ["import-tactics", database, transfer]);
  tempo = spawn(binary, ["serve", database, ui, "0"], {
    env: { ...process.env, TEMPO_PHONE_ORIGIN: phoneOrigin, TEMPO_PHONE_TAILSCALE_LOGIN: login },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const output = createInterface({ input: tempo.stdout });
  const local = await Promise.race([
    once(output, "line").then(([line]) => line.replace("Tempo study at ", "")),
    once(tempo, "exit").then(([code]) => { throw Error(`Tempo exited (${code})`); }),
  ]);
  const phoneFetch = (path, options) => new Promise((resolve, reject) => {
    const upstream = request(local + path, {
      method: options?.method,
      headers: { ...serveHeaders, ...options?.headers, ...(options?.body && { "Content-Length": Buffer.byteLength(options.body) }) },
    }, async response => {
      try {
        const chunks = [];
        for await (const chunk of response) chunks.push(chunk);
        resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers }));
      } catch (error) { reject(error); }
    });
    upstream.on("error", reject);
    upstream.end(options?.body);
  });
  const desktop = await fetch(local + "/assets/app.js").then(reply => reply.text());
  const asset = await phoneFetch("/assets/app.js");
  assert.equal(asset.status, 200);
  const phone = await asset.text();
  assert(phone === await readFile(join(ui, "phone/assets/app.js"), "utf8"));
  assert(desktop !== phone);
  assert(!phone.includes("/api/games/refresh"));
  assert(!phone.includes("/api/repertoires"));
  assert.equal((await phoneFetch("/assets/phone.webmanifest")).headers.get("content-type"), "application/manifest+json");
  for (const headers of [
    { Host: new URL(local).host }, { "X-Forwarded-Host": new URL(local).host },
    { "X-Forwarded-Proto": "http" }, { "Tailscale-User-Login": "someone@example.test" },
    { "Tailscale-Funnel-Request": "?1" }, { Origin: local },
  ]) assert.equal((await phoneFetch("/", { headers })).status, 403);
  assert.equal((await phoneFetch("/api/study", { method: "POST", headers: jsonHeaders, body: "{}" })).status, 403);
  const phonePost = (path, command) => phoneFetch(path, {
    method: "POST", headers: { ...jsonHeaders, Origin: phoneOrigin }, body: JSON.stringify(command),
  });
  for (const path of ["/api/games/import", "/api/repertoires", "/api/tactics", "/api/study/analysis-context", "/api/study/saved-reviews"]) {
    assert.equal((await phonePost(path, {})).status, 404, path);
  }
  assert.equal((await phoneFetch("/api/games")).status, 404);
  assert.equal((await phoneFetch("/phone/index.html")).status, 404);

  const commands = [];
  const issued = [];
  const markCommands = [];
  let loseMark = false;
  let loseAnswer = false;
  let failNext = false;
  // Model Serve's loopback proxy for the browser, which cannot set Host.
  proxy = createServer(async (incoming, outgoing) => {
    try {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const command = incoming.url === "/api/study" && JSON.parse(body);
      const marking = incoming.url === "/api/study/review-mark";
      if (marking) markCommands.push(body.toString());
      if (command) commands.push({ ...command, bytes: body.toString() });
      if (failNext && command?.command === "next") {
        failNext = false;
        outgoing.writeHead(503).end();
        return;
      }
      const headers = { ...incoming.headers, ...serveHeaders };
      if (headers.origin === `http://${incoming.headers.host}`) headers.origin = phoneOrigin;
      const upstream = request(local + incoming.url, { method: incoming.method, headers }, async response => {
        try {
          const chunks = [];
          for await (const chunk of response) chunks.push(chunk);
          const reply = Buffer.concat(chunks);
          if (command?.command === "next" && response.statusCode === 200) issued.push(JSON.parse(reply));
          if (marking && loseMark) {
            assert.equal(JSON.parse(reply).status, "saved");
            loseMark = false;
            outgoing.writeHead(503).end();
          } else if (loseAnswer && command?.command === "answer") {
            assert.equal(JSON.parse(reply).assessment, "good");
            loseAnswer = false;
            outgoing.writeHead(503).end();
          } else {
            outgoing.writeHead(response.statusCode, response.headers).end(reply);
          }
        } catch (error) { outgoing.writeHead(500).end(error.message); }
      });
      upstream.on("error", () => outgoing.writeHead(502).end());
      upstream.end(body);
    } catch (error) { outgoing.writeHead(500).end(error.message); }
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  browser = await webkit.launch();
  const page = await browser.newPage({ ...devices["iPhone 15"], viewport: { width: 375, height: 600 } });
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  sql = new DatabaseSync(database, { readOnly: true });
  const rows = table => sql.prepare(`SELECT count(*) AS total FROM ${table}`).get().total;
  const button = name => page.getByRole("button", { name, exact: true });
  const board = page.locator(".study-board cg-board");
  const layout = () => page.evaluate(() => {
    const board = document.querySelector(".study-board cg-board").getBoundingClientRect();
    const panel = document.querySelector(".study-panel").getBoundingClientRect();
    return { boardTop: board.top, boardBottom: board.bottom, panelTop: panel.top, scroll: window.scrollY };
  });
  const checkContinuation = async (name, prior) => {
    const control = page.locator(".study-continuation").getByRole("button", { name, exact: true });
    await control.waitFor();
    assert.equal(await button(name).count(), 1);
    const bounds = await control.boundingBox();
    const boardBounds = await board.boundingBox();
    assert(bounds && boardBounds);
    assert(bounds.y >= boardBounds.y + boardBounds.height);
    assert(bounds.y - boardBounds.y - boardBounds.height <= 32);
    assert(bounds.y + bounds.height <= await page.evaluate(() => window.visualViewport.height));
    assert.deepEqual(await layout(), prior);
    return control;
  };
  await page.goto(`http://127.0.0.1:${proxy.address().port}`);
  await button("Show move").waitFor();
  assert.equal(await page.title(), "Tempo Study");
  assert.equal(await page.getByRole("navigation", { name: "Tempo sections" }).count(), 0);
  assert.equal(await button("Analyze").count(), 0);
  await page.waitForFunction(() => document.documentElement.scrollWidth <= window.innerWidth);
  const solution = view => tactics.find(tactic => tactic.solver_fen.split(" ")[0] === view.display_fen.split(" ")[0]).solution[0];
  const baseline = rows("assessments");
  const receipts = rows("receipts");

  loseMark = true;
  await button("Review later").tap();
  await button("Retry saving for review").waitFor();
  const reviewToast = page.locator(".ui-toast").getByText("Saved for review.", { exact: true });
  assert.equal(await reviewToast.count(), 0);
  assert.equal(rows("saved_reviews"), 1);
  assert.equal(rows("receipts"), receipts);
  await page.reload();
  await button("Retry saving for review").tap();
  await reviewToast.waitFor();
  const bounds = await reviewToast.boundingBox();
  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  assert(bounds && bounds.x >= 0 && bounds.y >= 0);
  assert(bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height);
  await reviewToast.waitFor({ state: "detached" });
  assert.equal(markCommands[0], markCommands[1]);
  assert.equal(rows("saved_review_receipts"), 1);
  await button("Show move").waitFor();
  commands.splice(1);
  issued.splice(1);
  await page.evaluate(() => window.scrollTo(0, 0));

  loseAnswer = true;
  const initialLayout = await layout();
  await tapMove(page, solution(issued[0]));
  const retry = await checkContinuation("Retry", initialLayout);
  assert(await page.getByText(/Check Tailscale and make sure your MacBook is awake/).isVisible());
  assert.equal(rows("assessments"), baseline + 1);
  assert.equal(rows("receipts"), receipts + 1);
  failNext = true;
  await retry.tap();
  const retryNext = await checkContinuation("Retry next exercise", initialLayout);
  assert.equal(commands[1].bytes, commands[2].bytes);
  assert.equal(rows("receipts"), receipts + 1);

  await retryNext.tap();
  await button("Show move").waitFor();
  assert.deepEqual(commands.map(command => command.command), ["next", "answer", "answer", "next", "next"]);
  const desktopPost = async (path, command) => {
    const response = await fetch(local + path, {
      method: "POST", headers: jsonHeaders, body: JSON.stringify(command),
    });
    const reply = await response.json();
    assert(response.ok && reply.status !== "error", JSON.stringify(reply));
    return reply;
  };
  const desktopAttempt = await desktopPost("/api/study", {
    command: "resume", attempt_id: issued[1].attempt_id,
  });
  assert.equal(desktopAttempt.attempt_id, issued[1].attempt_id);
  assert.equal(desktopAttempt.dataset_id, issued[0].dataset_id);
  await button("Save previous response").tap();
  await page.getByText("Saved for review.", { exact: true }).waitFor();
  const bookmarkDataset = { dataset_id: desktopAttempt.dataset_id };
  const firstList = await desktopPost("/api/study/saved-reviews", { command: "list", ...bookmarkDataset });
  assert.equal(firstList.rows.length, 1);
  const savedPhonePosition = await desktopPost("/api/study/saved-reviews", {
    command: "open", id: firstList.rows[0].id, ...bookmarkDataset,
  });
  assert.equal(savedPhonePosition.origin.fen, issued[0].prompt.fen);
  assert.equal(savedPhonePosition.origin.prescribedUci, solution(issued[0]));
  await page.evaluate(() => window.scrollTo(0, 0));
  const secondLayout = await layout();
  const answer = solution(issued[1]);
  await tapMove(page, answer.slice(0, 3) + "5");
  await button("Show move").waitFor({ state: "visible" });
  await page.locator(".study-panel .status-notice.error").waitFor();
  await tapMove(page, answer);
  const continueStudy = await checkContinuation("Continue", secondLayout);
  await continueStudy.tap();
  await button("Practice tactics").waitFor();
  assert.equal(rows("assessments"), baseline + 2);
  assert.equal(rows("receipts"), receipts + 3);
  const dataset_id = desktopAttempt.dataset_id;
  const opening = { dataset_id, name: "Phone repair", learner_color: "white", pgn: "1. e4 e5 2. Nf3 *" };
  const { token } = await desktopPost("/api/repertoires", { command: "preview", ...opening });
  await desktopPost("/api/repertoires", { command: "save", ...opening, token });
  await desktopPost("/api/games/import", {
    dataset_id, command_id: "phone-repair", learner: "Learner",
    pgn: '[White "Learner"]\n[Black "Opponent"]\n[Date "2024.10.06"]\n\n1. e4 e5 2. Bc4 1-0',
  });
  await button("Check again").click();
  await page.getByText(/You played Bc4 in your game/).waitFor();
  await button("Replay game").click();
  await button("Return to exercise").click();
  await page.getByText("Play Nf3 on the board.").waitFor();
  assert.equal(await button("Analyze").count(), 0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await button("Review later").tap();
  await page.getByText("Saved for review.", { exact: true }).waitFor();
  const repairList = await desktopPost("/api/study/saved-reviews", { command: "list", ...bookmarkDataset });
  assert.equal(repairList.rows[0].exercise_name, "Phone repair");
  const repairPosition = await desktopPost("/api/study/saved-reviews", {
    command: "open", id: repairList.rows[0].id, ...bookmarkDataset,
  });
  assert.equal(repairPosition.origin.prescribedUci, "g1f3");
  assert.equal(repairPosition.origin.playedUci, "f1c4");
  await page.evaluate(() => window.scrollTo(0, 0));
  const repairLayout = await layout();
  const acknowledge = await checkContinuation("Got it — continue", repairLayout);
  assert(await acknowledge.isDisabled());
  await tapMove(page, "g1f3");
  await page.getByText(/Move reproduced/).waitFor();
  await checkContinuation("Got it — continue", repairLayout);
  assert(await acknowledge.isEnabled());
  const beforeAcknowledgement = rows("receipts");
  const beforeContinuation = commands.length;
  await acknowledge.tap();
  await button("Practice tactics").waitFor();
  assert.deepEqual(commands.slice(beforeContinuation).map(command => command.command), ["acknowledge", "next"]);
  assert.equal(rows("assessments"), baseline + 2);
  assert.equal(rows("receipts"), beforeAcknowledgement + 1);
  assert.deepEqual(errors, []);
  console.log("Phone WebKit verified touch Study, stable continuation and retry overlays, inline repair, and restricted shared-dataset ingress.");
} finally {
  sql?.close();
  await browser?.close();
  if (proxy) await new Promise(resolve => proxy.close(resolve));
  if (tempo && tempo.exitCode === null && tempo.signalCode === null) {
    const exited = once(tempo, "exit");
    tempo.kill();
    await exited;
  }
  await rm(scratch, { recursive: true, force: true });
}
