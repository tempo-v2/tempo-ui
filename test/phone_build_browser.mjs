// Set TEMPO_BINARY, TEMPO_PREVIOUS_BINARY, TEMPO_PREVIOUS_UI, TEMPO_PLAYWRIGHT and TEMPO_MAIA.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { Chess } from "chess.js";

const { devices, webkit } = await import(process.env.TEMPO_PLAYWRIGHT || "playwright");
const binary = resolve(process.env.TEMPO_BINARY || "target/release/tempo");
const ui = resolve("tempo-ui/dist");
assert(process.env.TEMPO_PREVIOUS_BINARY && process.env.TEMPO_PREVIOUS_UI, "Set the previous installed binary and assets.");
const previousBinary = resolve(process.env.TEMPO_PREVIOUS_BINARY);
const previousUi = resolve(process.env.TEMPO_PREVIOUS_UI);
assert(process.env.TEMPO_MAIA, "Set TEMPO_MAIA to the configured Stockfish/Maia directory.");
const authority = "tempo-build.example.ts.net:8443";
const phoneOrigin = `https://${authority}`;
const login = "owner@example.test";
const model = "maia2-0.11.0:65aae8465eed5e65df66a24ea7370715579f9e5435098d06fe18bdb1e267e997:rapid:1500:1500:cpu";

async function tapResponse(page, move) {
  const board = page.getByLabel("Repertoire response board", { exact: true }).locator("cg-board");
  await board.scrollIntoViewIfNeeded();
  const box = await board.boundingBox();
  assert(box);
  for (const square of [move.slice(0, 2), move.slice(2)]) {
    const file = square.charCodeAt(0) - "a".charCodeAt(0);
    const rank = 8 - Number(square[1]);
    await page.touchscreen.tap(box.x + box.width * (file + 0.5) / 8, box.y + box.height * (rank + 0.5) / 8);
  }
}

async function verifyPhoneBuild(browser, width, lostScan, lostSave) {
  const scratch = await mkdtemp(join(tmpdir(), "tempo-phone-build-"));
  const database = join(scratch, "study.sqlite");
  let server, proxy, page;
  try {
    execFileSync(previousBinary, ["init", database]);
    await symlink(resolve(process.env.TEMPO_MAIA), join(scratch, "maia"), "dir");
    async function start(executable, assets) {
      server = spawn(executable, ["serve", database, assets, "0"], {
        env: { ...process.env, TEMPO_PHONE_ORIGIN: phoneOrigin, TEMPO_PHONE_TAILSCALE_LOGIN: login },
        stdio: ["ignore", "pipe", "inherit"],
      });
      const output = createInterface({ input: server.stdout });
      return Promise.race([
        once(output, "line").then(([line]) => line.replace("Tempo study at ", "")),
        once(server, "exit").then(([code]) => { throw Error(`Tempo exited (${code})`); }),
      ]);
    }
    let desktop = await start(previousBinary, previousUi);
    async function post(path, command) {
      const reply = await fetch(desktop + "/api/" + path, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command),
      });
      const result = await reply.json();
      assert(reply.ok && result.status !== "error", JSON.stringify(result));
      return result;
    }
    const { dataset_id } = await post("repertoires", { command: "list" });
    const input = { dataset_id, name: "White opening", learner_color: "white", pgn: "1.e4 e5 2.Nf3 Nc6 3.Bb5 *" };
    const { token } = await post("repertoires", { ...input, command: "preview" });
    const { repertoires: [{ id: repertoire_id }] } = await post("repertoires", { ...input, command: "save", token });
    const address = { dataset_id, repertoire_id };
    const seed = new DatabaseSync(database);
    try {
      for (const [moves, chances] of [
        [["e4"], { e7e5: 0.60, d7d5: 0.25, c7c5: 0.15 }],
        [["e4", "e5", "Nf3"], { b8c6: 1 }],
        [["e4", "d5", "exd5"], { d8d5: 1 }],
        [["e4", "c5", "Nf3"], { d7d6: 1 }],
      ]) {
        const position = new Chess();
        moves.forEach(move => position.move(move));
        const distribution = Object.fromEntries(position.moves({ verbose: true })
          .map(({ from, to }) => [from + to, chances[from + to] ?? 0]));
        seed.prepare("INSERT INTO game_move_models VALUES (?, ?, ?)").run(
          model, position.fen().split(" ").slice(0, 4).join(" "), JSON.stringify(distribution),
        );
      }
    } finally { seed.close(); }

    function facts() {
      const db = new DatabaseSync(database, { readOnly: true });
      try {
        return ["attempts", "assessments", "learning", "content_receipts"]
          .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
      } finally { db.close(); }
    }
    const original = await post("study", { command: "next" });
    const before = facts();
    const phoneRequests = [];
    // Model Tailscale Serve for WebKit while exercising the real phone ingress.
    proxy = createServer((incoming, outgoing) => {
      phoneRequests.push(incoming.url);
      const headers = {
        ...incoming.headers, Host: authority, "X-Forwarded-Host": authority,
        "X-Forwarded-Proto": "https", "Tailscale-User-Login": login,
      };
      if (headers.origin === `http://${incoming.headers.host}`) headers.origin = phoneOrigin;
      const upstream = request(desktop + incoming.url, { method: incoming.method, headers }, reply => {
        outgoing.writeHead(reply.statusCode, reply.headers);
        reply.pipe(outgoing);
      });
      upstream.on("error", () => outgoing.writeHead(502).end());
      incoming.pipe(upstream);
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const origin = `http://127.0.0.1:${proxy.address().port}`;
    async function phonePost(path, command) {
      const reply = await fetch(origin + "/api/" + path, {
        method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(command),
      });
      return reply.json();
    }
    page = await browser.newPage({ ...devices["iPhone 15"], viewport: { width, height: 600 } });
    page.setDefaultTimeout(12_000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(origin);
    const button = name => page.getByRole("button", { name, exact: true });
    const dialog = page.getByRole("dialog");
    assert.equal(phoneRequests.includes("/api/repertoires"), false);
    const loadedCatalog = page.waitForResponse(response => response.url().endsWith("/api/repertoires"));
    await button("Build").click();
    const catalogue = await loadedCatalog;
    assert.equal(catalogue.status(), 200, await catalogue.text());
    assert.equal((await catalogue.json()).dataset_id, dataset_id);
    await page.getByRole("heading", { name: "Build repertoire" }).waitFor();
    assert.equal((await button("Build").boundingBox()).height >= 44, true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.getByRole("combobox", { name: "Repertoire", exact: true }).selectOption(repertoire_id);
    await button("Edit starting line").click();
    await button("e4").click();
    await button("Use this position").click();
    await page.getByText(/Start coverage after · 1\.e4/).waitFor();
    await page.getByLabel("Through your move").fill("3");
    await page.getByLabel("Target probability (%)").fill("95");
    const starts = [];
    await page.route("**/api/games/coverage", async route => {
      starts.push(route.request().postData());
      if (starts.length !== 1) return route.continue();
      if (lostScan === "after") assert.equal((await route.fetch()).status(), 202);
      return route.abort();
    });
    const lostScanResponse = page.waitForEvent("requestfailed", req => req.url().endsWith("/api/games/coverage"));
    await button("Scan repertoire").click();
    await lostScanResponse;
    await page.reload();
    if (lostScan === "before") {
      await button("Retry same scan").click();
    }
    await page.getByText(/60% estimated coverage through your move 3/).waitFor();
    assert.deepEqual(JSON.parse(starts[0]).starting_line.moves, ["e2e4"]);
    assert.equal(starts.length, lostScan === "after" ? 1 : 2);
    if (lostScan === "before") assert.equal(starts[0], starts[1]);
    const ranking = page.locator(".phone-build-gaps > li");
    assert.match(await ranking.first().innerText(), /d5\s+25%/);
    assert.match(await ranking.nth(1).innerText(), /c5\s+15%/);
    assert.deepEqual(facts(), before);
    assert.equal(phoneRequests.filter(path => path === "/api/study").length, 1);
    const { gaps: [firstGap] } = await post("games/gaps", { offset: 0, forecast_repertoire: repertoire_id });
    const { position, actual_move, document_revision, gap_kind } = firstGap;
    const gap = { ...address, position, actual_move, document_revision, gap_kind };
    assert.equal((await phonePost("games/gap-draft", { ...gap, gap_kind: "observed" })).code, "phone_build_only");
    assert.equal((await phonePost("games/gap-draft", { ...gap, actual_move: "g8f6" })).code, "stale_coverage");
    await ranking.first().getByRole("button", { name: "Fix response" }).click();
    await dialog.getByRole("heading", { name: "Respond to 1…d5" }).waitFor();
    const board = await dialog.getByLabel("Repertoire response board", { exact: true }).boundingBox();
    assert(board && board.x >= 0 && board.x + board.width <= width);
    await tapResponse(page, "e4d5");
    await dialog.getByText("Selected exd5", { exact: true }).waitFor();
    await button("Save line").waitFor({ timeout: 30_000 });
    const line = dialog.getByRole("region", { name: "Likely line" });
    await line.getByRole("button", { name: "2…Qxd5" }).click();
    assert.equal(await line.getByRole("button", { name: "2…Qxd5" }).getAttribute("aria-pressed"), "true");
    assert.deepEqual(facts(), before);

    const saves = [];
    let blockNext = true;
    let acceptedReply;
    await page.route("**/api/repertoires", async route => {
      if (route.request().postDataJSON().command !== "save") return route.continue();
      saves.push(route.request().postData());
      if (saves.length !== 1) return route.continue();
      if (lostSave === "after") {
        const accepted = await route.fetch();
        assert.equal(accepted.status(), 200);
        acceptedReply = await accepted.text();
      }
      return route.abort();
    });
    await page.route("**/api/games/gaps", route => {
      if (saves.length === 2 && blockNext) {
        blockNext = false;
        return route.abort();
      }
      return route.continue();
    });
    await button("Save line").click();
    await button("Retry save").waitFor();
    const beforeUpgrade = phoneRequests.length;
    const stopped = once(server, "exit");
    server.kill();
    await stopped;
    desktop = await start(binary, ui);
    const recovered = page.waitForResponse(response => response.url().endsWith("/api/repertoires") &&
      response.request().postDataJSON().command === "save");
    await page.reload();
    const recoveredResponse = await recovered;
    assert.equal(recoveredResponse.status(), 200);
    if (acceptedReply) assert.equal(await recoveredResponse.text(), acceptedReply);
    await button("Retry loading next gap").waitFor();
    await dialog.getByText("Saved line through your move 3.", { exact: true }).waitFor();
    await button("Retry loading next gap").click();
    await dialog.getByRole("heading", { name: "Respond to 1…c5" }).waitFor();
    assert.equal(saves.length, 2);
    assert.equal(saves[0], saves[1]);
    const signedSave = JSON.parse(saves[0]);
    assert.match(signedSave.token, /^phone-forecast-v2:/);
    assert.equal(await button("Save line").count(), 0);
    assert(!phoneRequests.slice(beforeUpgrade).some(path => path.startsWith("/api/games/gap-line")));
    assert.equal((await phonePost("repertoires", { ...signedSave, pgn: "1. d4 *" })).code, "stale_preview");
    assert.equal((await phonePost("repertoires", { ...signedSave, dataset_id: "another-dataset" })).code, "stale_preview");
    assert.equal((await phonePost("repertoires", { ...signedSave, repertoire_id: "another-repertoire" })).code, "stale_preview");
    const after = facts();
    assert.deepEqual(after.slice(0, 2), before.slice(0, 2));
    assert.deepEqual(after[2].filter(row => before[2].some(old => old.target_id === row.target_id)), before[2]);
    assert.equal(after[3].length, before[3].length + 1);
    assert.match((await post("repertoires", { ...address, command: "read_document" })).document.pgn,
      /e4 d5 exd5 Qxd5 [^ ]+ \*/);

    await button("Close").click();
    await page.getByText("Earlier estimate", { exact: true }).waitFor();
    await page.getByLabel("Through your move").fill("3");
    await button("Scan repertoire").click();
    await page.getByText(/85% estimated coverage through your move 3/).waitFor();
    let expected = after;
    if (width === 320) {
      await ranking.first().getByRole("button", { name: "Fix response" }).click();
      await dialog.getByRole("heading", { name: "Respond to 1…c5" }).waitFor();
      await tapResponse(page, "g1f3");
      await dialog.getByText("Selected Nf3", { exact: true }).waitFor();
      await button("Save response").click();
      await dialog.waitFor({ state: "hidden" });
      expected = facts();
      assert.equal(expected[3].length, after[3].length + 1);
      assert.deepEqual(expected.slice(0, 2), before.slice(0, 2));
      assert.deepEqual(expected[2].filter(row => before[2].some(old => old.target_id === row.target_id)), before[2]);
      assert.match((await post("repertoires", { ...address, command: "read_document" })).document.pgn,
        /e4 c5 Nf3 \*/);
    }
    const resumedStudy = page.waitForResponse(response => response.url().endsWith("/api/study"));
    await button("Study").click();
    const resumed = await (await resumedStudy).json();
    assert.equal(resumed.attempt_id, original.attempt_id);
    assert.equal(resumed.revision, original.revision);
    assert.deepEqual(facts(), expected);
    assert.equal(phoneRequests.filter(path => path === "/api/study").length, 2);
    assert.deepEqual(errors, []);
    console.log(`Phone Build ${width}px recovered the original installed line Save lost ${lostSave} delivery without starting a line preview.`);
  } finally {
    await page?.close();
    if (proxy) await new Promise(resolve => proxy.close(resolve));
    if (server?.exitCode === null && server?.signalCode === null) {
      server.kill();
      await once(server, "exit");
    }
    await rm(scratch, { recursive: true, force: true });
  }
}

const browser = await webkit.launch();
try {
  await verifyPhoneBuild(browser, 320, "before", "after");
  await verifyPhoneBuild(browser, 375, "after", "before");
} finally {
  await browser.close();
}
