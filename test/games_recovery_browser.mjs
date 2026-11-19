// Upgrade test against the previously installed backend and UI on one disposable origin.
// TEMPO_PREVIOUS_RELEASE points to a checkpoint containing tempo and ui/.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as httpServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";

const { chromium } = await import(process.env.TEMPO_PLAYWRIGHT || "playwright");
assert.ok(process.env.TEMPO_PREVIOUS_RELEASE, "Set TEMPO_PREVIOUS_RELEASE to the previous checkpoint.");
const previous = resolve(process.env.TEMPO_PREVIOUS_RELEASE);
const candidate = resolve(process.env.TEMPO_BINARY || "target/debug/tempo");
const candidateUi = resolve("tempo-ui/dist");
const temporary = mkdtempSync(join(tmpdir(), "tempo-games-upgrade-"));
const database = join(temporary, "practice.sqlite");
const pendingKey = "tempo.games.pending.v1";
const externalKey = pendingKey + "-external";
const providerCalls = [];
const connected = new Set();
let releaseB;
const heldB = new Promise(resolve => { releaseB = resolve; });
let provider, proxy, host, browser;

async function listen(server) {
  const ready = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await ready;
}

async function fixtureEnvironment() {
  const key = join(temporary, "provider.key");
  const cert = join(temporary, "provider.crt");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", key, "-out", cert, "-subj", "/CN=lichess.org",
    "-addext", "subjectAltName=DNS:lichess.org", "-addext", "basicConstraints=critical,CA:TRUE",
  ], { stdio: "ignore" });
  provider = httpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, async (request, response) => {
    if (!request.url.startsWith("/api/games/user/learner?")) {
      response.writeHead(404).end();
      return;
    }
    if (providerCalls.push(request.url) === 2) await heldB;
    response.writeHead(200, { "Content-Type": "application/x-ndjson" }).end();
  });
  proxy = httpServer();
  proxy.on("connect", (request, client, head) => {
    if (request.url !== "lichess.org:443") {
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    connected.add(client);
    const local = connect(provider.address().port, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection established\r\n\r\n");
      local.write(head);
      client.pipe(local).pipe(client);
    });
    client.on("error", () => local.destroy());
    client.once("close", () => {
      connected.delete(client);
      local.destroy();
    });
    local.on("error", () => client.destroy());
    local.once("close", () => client.destroy());
  });
  await listen(provider);
  await listen(proxy);
  const address = `http://127.0.0.1:${proxy.address().port}`;
  return {
    ...process.env,
    HTTPS_PROXY: address, https_proxy: address, NO_PROXY: "", no_proxy: "",
    CURL_CA_BUNDLE: cert, SSL_CERT_FILE: cert, CURL_SSL_BACKEND: "openssl",
  };
}

async function start(binary, ui, env, port = "0") {
  host = spawn(binary, ["serve", database, ui, port], { env, stdio: ["ignore", "pipe", "inherit"] });
  const output = createInterface({ input: host.stdout });
  const [line] = await Promise.race([
    once(output, "line"),
    once(host, "exit").then(() => { throw new Error("Tempo exited before serving the test UI."); }),
  ]);
  const url = /^Tempo study at (http:\/\/127\.0\.0\.1:\d+)$/.exec(line)?.[1];
  assert.ok(url, line);
  return url;
}

async function stop() {
  if (!host || host.exitCode !== null || host.signalCode !== null) return;
  const exited = once(host, "exit");
  host.kill();
  await exited;
}

function receipts() {
  const db = new DatabaseSync(database, { readOnly: true });
  try { return db.prepare("SELECT * FROM game_receipts ORDER BY id").all(); }
  finally { db.close(); }
}

async function job(base, id, status) {
  for (let iteration = 0; iteration < 150; iteration++) {
    const response = await fetch(base + "/api/games/job");
    assert.equal(response.status, 200);
    const current = await response.json();
    if (current.command_id === id && current.status === status) return current;
    if (current.status === "failed") assert.fail(JSON.stringify(current));
    await sleep(30);
  }
  assert.fail(`Refresh did not reach ${status} for ${id}`);
}

function refresh(base, payload) {
  return fetch(base + "/api/games/refresh", {
    method: "POST", headers: { "Content-Type": "application/json", origin: base },
    body: JSON.stringify(payload),
  });
}

const button = (page, name) => page.getByRole("button", { name, exact: true });
async function showGames(page) {
  await button(page, "Games").click();
  await page.getByRole("heading", { name: "Games", exact: true }).waitFor();
}

async function fillRefresh(page) {
  await page.getByLabel("Account name").fill("learner");
  await page.getByLabel("First day (UTC)").first().fill("2026-11-09");
  await page.getByLabel("Last day (UTC)").first().fill("2026-11-09");
}

async function blob(page, id) {
  return page.evaluate(blobId => new Promise((resolve, reject) => {
    const open = indexedDB.open("tempo-content-recovery", 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const transaction = db.transaction("commands", "readonly");
      const request = transaction.objectStore("commands").get(blobId);
      transaction.oncomplete = () => { db.close(); resolve(request.result ?? null); };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
    };
  }), id);
}

try {
  const env = await fixtureEnvironment();
  const oldBinary = join(previous, "tempo");
  execFileSync(oldBinary, ["init", database]);
  const base = await start(oldBinary, join(previous, "ui"), env);
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext();
  const inline = await context.newPage();
  const external = await context.newPage();
  for (const page of [inline, external]) {
    page.setDefaultTimeout(8000);
    await page.goto(base);
    await showGames(page);
    await fillRefresh(page);
  }

  let oldAccepted;
  let blockJobRead = false;
  const jobRoute = "**/api/games/job";
  const commandRoute = "**/api/games/refresh";
  await inline.route(jobRoute, route => blockJobRead ? route.abort() : route.continue());
  await inline.route(commandRoute, async route => {
    blockJobRead = true;
    oldAccepted = route.request().postData();
    assert.equal((await route.fetch()).status(), 202);
    await route.abort();
  });
  await button(inline, "Refresh games").click();
  await button(inline, "Retry same request").waitFor();
  const acceptedCommand = JSON.parse(oldAccepted);
  const savedInline = await inline.evaluate(key => JSON.parse(sessionStorage.getItem(key)), pendingKey);
  assert.equal(JSON.stringify(savedInline.payload), oldAccepted);
  await job(base, acceptedCommand.command_id, "complete");
  const acceptedRows = receipts();
  assert.equal(acceptedRows.length, 1);
  assert.equal(providerCalls.length, 1);

  // Exercise the actual old UI's asynchronous large-command fallback in Chrome.
  // Force the inline write to exhaust its quota while permitting the smaller pointer.
  await external.evaluate(key => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new DOMException("Fixture quota exhausted", "QuotaExceededError");
      return setItem.call(this, name, value);
    };
  }, pendingKey);
  let oldUnaccepted;
  await external.route(commandRoute, route => {
    oldUnaccepted = route.request().postData();
    return route.abort();
  });
  await button(external, "Refresh games").click();
  await button(external, "Retry same request").waitFor();
  const unacceptedCommand = JSON.parse(oldUnaccepted);
  const pointer = await external.evaluate(key => JSON.parse(sessionStorage.getItem(key)), externalKey);
  assert.ok(pointer.id);
  assert.equal(JSON.stringify((await blob(external, pointer.id)).payload), oldUnaccepted);
  assert.deepEqual(receipts(), acceptedRows);

  await stop();
  assert.equal(await start(candidate, candidateUi, env, new URL(base).port), base);
  const { dataset_id } = acceptedCommand;
  const laterId = "refresh-b";
  const later = await refresh(base, { ...acceptedCommand, command_id: laterId });
  assert.equal(later.status, 202);
  assert.deepEqual(await later.json(), { dataset_id, command_id: laterId, status: "running" });
  const running = await job(base, laterId, "running");

  await inline.unroute(jobRoute);
  await inline.unroute(commandRoute);
  await inline.reload();
  await showGames(inline);
  const retryA = inline.waitForRequest(request => request.url().endsWith("/api/games/refresh"));
  await button(inline, "Retry same request").click();
  assert.equal((await retryA).postData(), oldAccepted);
  await inline.getByRole("heading", { name: "Recovered refresh results" }).waitFor();
  await inline.waitForFunction(key => sessionStorage.getItem(key) === null, pendingKey);
  await inline.getByText("Refreshing games. You can return to Study while this runs.").waitFor();
  assert.deepEqual(await job(base, laterId, "running"), running);
  assert.deepEqual(receipts(), acceptedRows);
  releaseB();
  await job(base, laterId, "complete");
  assert.equal(providerCalls.length, 2);

  await external.unroute(commandRoute);
  await external.reload();
  await showGames(external);
  const retryC = external.waitForRequest(request => request.url().endsWith("/api/games/refresh"));
  await button(external, "Retry same request").click();
  assert.equal((await retryC).postData(), oldUnaccepted);
  await job(base, unacceptedCommand.command_id, "complete");
  await external.waitForFunction(key => sessionStorage.getItem(key) === null, externalKey);
  await external.waitForFunction(() => !document.body.textContent.includes("Refreshing games."));
  assert.equal(await blob(external, pointer.id), null);
  assert.deepEqual(receipts().map(row => row.id).sort(), [laterId, acceptedCommand.command_id, unacceptedCommand.command_id].sort());
  assert.equal(providerCalls.length, 3);
  console.log("Previous installed Games UI captured accepted-lost inline and unaccepted IndexedDB Refresh commands. Candidate replayed both exact requests, kept B current, and recorded each command once.");
} finally {
  releaseB();
  await browser?.close();
  await stop();
  for (const socket of connected) socket.destroy();
  proxy?.close();
  provider?.close();
  rmSync(temporary, { recursive: true, force: true });
}
