// Exercise the packaged comparison table with deliberately late provider replies.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Chess } from "chess.js";

const { chromium } = await import(process.env.TEMPO_PLAYWRIGHT || "playwright");
const directory = await mkdtemp(join(tmpdir(), "tempo-evidence-browser-"));
const binary = resolve(process.env.TEMPO_BINARY || "target/debug/tempo");
let server, browser;
try {
  const db = join(directory, "study.sqlite");
  execFileSync(binary, ["init", db]);
  server = spawn(binary, ["serve", db, resolve("tempo-ui/dist"), "0"], { stdio: ["ignore", "pipe", "inherit"] });
  const [ready] = await once(createInterface({ input: server.stdout }), "line");
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const button = name => page.getByRole("button", { name, exact: true });
  let heldId, oldRequest, releaseLate, pollStarted, delivered;
  const hold = new Promise(resolve => { releaseLate = resolve; });
  const polling = new Promise(resolve => { pollStarted = resolve; });
  const deliveredLate = new Promise(resolve => { delivered = resolve; });
  const pins = [];
  let maiaMode = "offline";
  function stats(total, count) {
    return { white: total, draws: 0, black: 0, moves: [{ uci: "d7d5", white: count, draws: 0, black: 0 }] };
  }
  function reply(request, data) {
    return { status: "complete", request_id: request.request_id, source: request.source, fen: request.fen, data };
  }
  await page.route("**/api/analysis/evidence", async route => {
    const request = route.request().postDataJSON();
    const { fen, source } = request;
    const white = fen.split(" ")[1] === "w";
    if (source === "rated" && fen.startsWith("rnbqkbnr/pppppppp/8/8/4P3/")) {
      heldId = request.request_id;
      oldRequest = request;
      return route.fulfill({ json: { status: "running", request_id: heldId, source, fen } });
    }
    let data;
    if (source === "rated" && request.ratings === "above1500") {
      const aggregate = stats(10, 10);
      aggregate.moves.push({ uci: "g8f6", white: 10, draws: 0, black: 0 });
      return route.fulfill({ json: reply(request, aggregate) });
    }
    if (source === "stockfish") {
      const top = white ? ["e2e4", "d2d4", "g1f3"] : ["d7d5", "g8f6", "e7e6"];
      pins.push(request.pins);
      const candidates = [...new Set([...top, ...request.pins])].map((uci, index) => ({
        uci, centipawns: !white && uci === "g8f6" ? null : [62, 47, 31, 17][index],
        mate: !white && uci === "g8f6" ? 3 : null,
      }));
      data = { engine: "Test engine", comparison_complete: true, candidates };
    } else if (source === "maia") {
      if (maiaMode === "offline")
        return route.fulfill({ json: { ...reply(request, null), status: "error", message: "Fixture model offline" } });
      const probabilities = Object.fromEntries(new Chess(fen).moves({ verbose: true })
        .map(move => [move.from + move.to + (move.promotion ?? ""),
          Number(move.from + move.to === "e2e4" || maiaMode === "invalid" && move.from + move.to === "d2d4")]));
      data = { profile: "Fixture Maia", terminal: false, probabilities };
    } else if (source === "repertoire") {
      const example = {
        fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
        responses: [{ uci: "d7d5", san: "d5", reusable: true, repertoire_id: "sample" }],
      };
      data = {
        exact: [], similar_responses: { current: [], other: white ? [] : [{ uci: "d7d5", position_count: 1 }] },
        nearby: { current: [], other: white ? [] : [example] }, repertoire_names: { sample: "Sample" }, content_revision: 0,
      };
    } else {
      data = white ? { white: 0, draws: 0, black: 0, moves: [] } : stats(100, 24);
    }
    return route.fulfill({ json: reply(request, data) });
  });
  await page.route("**/api/analysis/result", async route => {
    assert.equal(route.request().postDataJSON().request_id, heldId);
    pollStarted();
    await hold;
    try { await route.fulfill({ json: reply(oldRequest, stats(100, 99)) }); }
    finally { delivered(); }
  });
  await page.goto(ready.replace("Tempo study at ", ""));
  await button("Repertoires").click();
  await button("Build new repertoire").click();
  await page.getByRole("checkbox",{name:"All legal moves"}).check();
  await page.getByText(/Fixture model offline/).waitFor();
  await button("Pin a3").click();
  const row = move => page.locator("tr").filter({ has: button(move) });
  const maiaStatus = page.getByRole("status").filter({ hasText: "Maia Rapid 1500" });
  maiaMode = "invalid";
  await maiaStatus.getByRole("button", { name: "Retry" }).click();
  await maiaStatus.getByText(/could not read this source/).waitFor();
  assert.equal(await row("e4").getByText("100.0%", { exact: true }).count(), 0);
  maiaMode = "valid";
  await maiaStatus.getByRole("button", { name: "Retry" }).click();
  await row("e4").getByText("100.0%", { exact: true }).waitFor();
  await page.getByRole("checkbox",{name:"All legal moves"}).uncheck();
  assert((await page.locator(".analysis-table tbody tr").count()) < 20);
  await row("a3").getByText("0.0%", {exact:true}).waitFor();
  await page.getByRole("checkbox",{name:"All legal moves"}).check();
  assert.equal(await page.locator(".analysis-table tbody tr").count(),20);
  maiaMode = "offline";
  await row("a3").getByText(/0\.17/).waitFor();
  assert.ok(pins.some(request => request.includes("a2a3")));
  await button("e4").click();
  await Promise.race([polling, new Promise((_, reject) => { const id = setTimeout(() => reject(new Error("Old position was never polled")), 8000); id.unref(); })]);
  await button("Back one move").click();
  await button("d4").click();
  await row("d5").getByText(/24\.0%/).first().waitFor();
  releaseLate();
  await deliveredLate;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.getByText(/99\.0%/).count(), 0);
  assert.match(await row("d5").innerText(), /-0\.62/);
  assert.match(await row("Nf6").innerText(), /Mate -3/);
  await page.getByRole("columnheader", { name: /Lichess Rapid.*100 games/ }).waitFor();
  await row("d5").getByText("1 nearby (other)").click();
  await row("d5").locator("details details summary").click();
  await row("d5").locator(".gap-neighbor-board cg-board").waitFor();
  await row("d5").getByText("1 nearby (other)").click();
  for (const label of ["Lichess Rapid", "Masters"]) await page.getByRole("checkbox", {name: label, exact:true}).check();
  await page.mouse.move(1, 1);
  await page.waitForFunction(() => document.querySelectorAll(".analysis-layout > section:first-child svg line").length === 1);
  assert.equal(await row("d5").getByLabel("Arrow shown").count(), 2);
  await button("Nf6").focus();
  await page.waitForFunction(() => document.querySelectorAll(".analysis-layout > section:first-child svg line").length === 2);
  await page.getByLabel("Rapid rating").selectOption("above1500");
  await page.getByText(/Lichess Rapid · Tempo could not read this source/).waitFor();
  assert.equal(await row("d5").getByText(/24\.0%/).count(), 1); // Masters is still available.
  await page.getByLabel("Rapid rating").selectOption("around1500");
  await page.getByRole("columnheader", { name: /Lichess Rapid.*100 games/ }).waitFor();
  await button("Back one move").click();
  assert.equal(await button("Pin a3").getAttribute("aria-pressed"), "true");
  assert.deepEqual(errors, []);
  console.log("Packaged table evaluated a pinned fourth candidate, kept a fixed score perspective, and ignored a late lookup while a separate source was unavailable.");
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    const exited = once(server, "exit");
    server.kill();
    await exited;
  }
  await rm(directory, { recursive: true, force: true });
}
