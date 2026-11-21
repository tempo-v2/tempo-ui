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
async function verifyUpgrade(acceptedUsesExternal) {
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
    const entry = button(page, "Games");
    const title = page.getByRole("heading", { name: "Games", exact: true });
    await entry.or(title).waitFor();
    if (await entry.isVisible()) await entry.click();
    await page.getByRole("heading", { name: "Games", exact: true }).waitFor();
    const tab = page.getByRole("tab", { name: "Import" });
    if (await tab.isVisible()) {
      await tab.click();
    } else {
      const oldImport = page.getByText("Import or refresh games", { exact: true });
      if (await oldImport.isVisible() && !await page.getByLabel("Account name").isVisible()) await oldImport.click();
    }
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

  async function forceIndexedDb(page) {
    // Force only the previous UI's inline write to exhaust its quota. The
    // production fallback still writes its real IndexedDB blob and pointer.
    await page.evaluate(key => {
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (name, value) {
        if (name === key) throw new DOMException("Fixture quota exhausted", "QuotaExceededError");
        return setItem.call(this, name, value);
      };
    }, pendingKey);
  }

  async function readSaved(page, usesExternal) {
    const key = usesExternal ? externalKey : pendingKey;
    const saved = await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)), key);
    assert.ok(saved, `Missing recovery envelope at ${key}`);
    if (!usesExternal) return { key, command: saved };
    assert.ok(saved.id);
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), pendingKey), null);
    return { key, id: saved.id, command: await blob(page, saved.id) };
  }

  async function confirmRemoved(page, saved) {
    await page.waitForFunction(key => sessionStorage.getItem(key) === null, saved.key);
    if (!saved.id) return;
    for (let retry = 0; retry < 30; retry++) {
      if (await blob(page, saved.id) === null) return;
      await sleep(20);
    }
    assert.fail("Candidate did not remove the detached IndexedDB blob.");
  }

  try {
    const env = await fixtureEnvironment();
    const oldBinary = join(previous, "tempo");
    execFileSync(oldBinary, ["init", database]);
    const base = await start(oldBinary, join(previous, "ui"), env);
    browser = await chromium.launch({ channel: "chrome", headless: true });
    const context = await browser.newContext();
    const accepted = await context.newPage();
    const unaccepted = await context.newPage();
    for (const page of [accepted, unaccepted]) {
      page.setDefaultTimeout(8000);
      await page.goto(base);
      await showGames(page);
      await fillRefresh(page);
    }
    await forceIndexedDb(acceptedUsesExternal ? accepted : unaccepted);

    let oldAccepted;
    let blockJobRead = false;
    const jobRoute = "**/api/games/job";
    const commandRoute = "**/api/games/refresh";
    await accepted.route(jobRoute, route => blockJobRead ? route.abort() : route.continue());
    await accepted.route(commandRoute, async route => {
      blockJobRead = true;
      oldAccepted = route.request().postData();
      assert.equal((await route.fetch()).status(), 202);
      await route.abort();
    });
    await button(accepted, "Refresh games").click();
    await button(accepted, "Retry same request").waitFor();
    const acceptedCommand = JSON.parse(oldAccepted);
    const savedAccepted = await readSaved(accepted, acceptedUsesExternal);
    assert.equal(JSON.stringify(savedAccepted.command.payload), oldAccepted);
    await job(base, acceptedCommand.command_id, "complete");
    const acceptedRows = receipts();
    assert.equal(acceptedRows.length, 1);
    assert.equal(providerCalls.length, 1);

    let oldUnaccepted;
    await unaccepted.route(commandRoute, route => {
      oldUnaccepted = route.request().postData();
      return route.abort();
    });
    await button(unaccepted, "Refresh games").click();
    await button(unaccepted, "Retry same request").waitFor();
    const unacceptedCommand = JSON.parse(oldUnaccepted);
    const savedUnaccepted = await readSaved(unaccepted, !acceptedUsesExternal);
    assert.equal(JSON.stringify(savedUnaccepted.command.payload), oldUnaccepted);
    assert.deepEqual(receipts(), acceptedRows);

    await stop();
    assert.equal(await start(candidate, candidateUi, env, new URL(base).port), base);
    const { dataset_id } = acceptedCommand;
    const laterId = "refresh-b";
    const later = await refresh(base, { ...acceptedCommand, command_id: laterId });
    assert.equal(later.status, 202);
    assert.deepEqual(await later.json(), { dataset_id, command_id: laterId, status: "running" });
    const running = await job(base, laterId, "running");

    await accepted.unroute(jobRoute);
    await accepted.unroute(commandRoute);
    await accepted.reload();
    await showGames(accepted);
    await accepted.getByRole("tab", { name: "Library" }).click();
    await button(accepted, "Review Games request").click();
    const retryA = accepted.waitForRequest(request => request.url().endsWith("/api/games/refresh"));
    await button(accepted, "Retry same request").click();
    assert.equal((await retryA).postData(), oldAccepted);
    await accepted.getByRole("heading", { name: "Recovered refresh results" }).waitFor();
    await confirmRemoved(accepted, savedAccepted);
    await accepted.getByText("Refreshing games. You can return to Study while this runs.").waitFor();
    assert.deepEqual(await job(base, laterId, "running"), running);
    assert.deepEqual(receipts(), acceptedRows);
    await accepted.getByRole("tab", { name: "Library" }).click();
    releaseB();
    await job(base, laterId, "complete");
    await accepted.getByRole("tab", { name: "Import" }).click();
    await accepted.getByText("Latest refresh", { exact: true }).first().waitFor();
    assert.equal(providerCalls.length, 2);

    await unaccepted.unroute(commandRoute);
    await unaccepted.reload();
    await showGames(unaccepted);
    const retryC = unaccepted.waitForRequest(request => request.url().endsWith("/api/games/refresh"));
    await button(unaccepted, "Retry same request").click();
    assert.equal((await retryC).postData(), oldUnaccepted);
    await job(base, unacceptedCommand.command_id, "complete");
    await confirmRemoved(unaccepted, savedUnaccepted);
    await unaccepted.waitForFunction(() => !document.body.textContent.includes("Refreshing games."));
    assert.deepEqual(receipts().map(row => row.id).sort(), [laterId, acceptedCommand.command_id, unacceptedCommand.command_id].sort());
    assert.equal(providerCalls.length, 3);
    const acceptedStorage = acceptedUsesExternal ? "IndexedDB" : "inline";
    const unacceptedStorage = acceptedUsesExternal ? "inline" : "IndexedDB";
    console.log(`Previous client stored accepted-lost Refresh in ${acceptedStorage} and unaccepted Refresh in ${unacceptedStorage}. Candidate bytes matched, B stayed current, and each command committed once.`);
  } finally {
    releaseB();
    await browser?.close();
    await stop();
    for (const socket of connected) socket.destroy();
    proxy?.close();
    provider?.close();
    rmSync(temporary, { recursive: true, force: true });
  }
}

const started = performance.now();
await verifyUpgrade(false);
await verifyUpgrade(true);
console.log(`Verified all four previous Games recovery cases in ${((performance.now() - started) / 1000).toFixed(2)}s.`);
