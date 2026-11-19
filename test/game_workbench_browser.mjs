// From the assembled workspace, with TEMPO_BINARY and TEMPO_PLAYWRIGHT.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const { chromium } = await import(process.env.TEMPO_PLAYWRIGHT || "playwright");
const root = await mkdtemp(join(tmpdir(), "tempo-game-workbench-"));
const database = join(root, "test.sqlite");
const binary = resolve(process.env.TEMPO_BINARY || "target/debug/tempo");
let server, browser;

async function expectPiece(page, file, rank, piece) {
  await page.waitForFunction(({ file, rank, piece }) => {
    const board = document.querySelector(".review-board cg-board");
    if (!board) return false;
    const rect = board.getBoundingClientRect();
    const expected = [file.charCodeAt(0) - 97, 8 - rank];
    return [...board.querySelectorAll("piece")].some(node => {
      const box = node.getBoundingClientRect();
      return piece.split(" ").every(kind => node.classList.contains(kind)) &&
        Math.abs((box.x - rect.x) / box.width - expected[0]) < .01 &&
        Math.abs((box.y - rect.y) / box.height - expected[1]) < .01;
    });
  }, {file, rank, piece}, {timeout:4000});
}

try {
  execFileSync(binary, ["init", database]);
  server = spawn(binary, ["serve", database, resolve("tempo-ui/dist"), "0"], {cwd:root, stdio:["ignore","pipe","inherit"]});
  const [line] = await Promise.race([
    once(createInterface({input:server.stdout}), "line"),
    once(server, "exit").then(([code]) => { throw Error("Tempo exited during startup: " + code); }),
  ]);
  const origin = line.replace("Tempo study at ", "");
  async function post(route, input) {
    const result = await fetch(origin + "/api/" + route, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(input)});
    const reply = await result.json();
    assert(result.ok && reply.status !== "error", JSON.stringify(reply));
    return reply;
  }
  const {dataset_id} = await post("repertoires", {command:"list"});
  const book = {dataset_id, name:"White repertoire", learner_color:"white", pgn:"1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. d3 *"};
  const draft = await post("repertoires", {command:"preview", ...book});
  await post("repertoires", {command:"save", ...book, token:draft.token});
  for (const [name, moves] of [
    ["Robin","1. e4 e5 2. Nf3 Nf6 3. Bc4 Nc6 4. d3 Bc5"],
    ["Avery","1. e4 e5 2. Nf3 Nc6 3. Bb5 a6"],
  ]) {
    await post("games/import", {dataset_id,command_id:name,learner:"Andy",
      pgn:'[White "Andy"]\n[Black "' + name + '"]\n\n' + moves + " 1-0"});
  }
  browser = await chromium.launch({channel:"chrome", headless:true});
  const page = await browser.newPage({viewport:{width:1280,height:900}});
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const button = name => page.getByRole("button", {name,exact:true});
  const heading = name => page.getByRole("heading", {name,exact:true});
  const choose = uci => page.getByLabel("Explore a move").selectOption(uci);
  await page.goto(origin + "/#games");
  await button("Import PGN").click();
  await page.getByLabel("Learner name").fill("Andy");
  await page.getByLabel("Or paste PGN").fill('[White "Andy"]\n[Black "River"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bc4 Nd4 4. c3 Nxf3+ 1-0');
  await button("Import games").click();
  await heading("Import results").waitFor();
  await button("Andy vs Robin").click();
  await page.getByRole("button", {name:/See move-order transposition/}).click();
  await page.getByText("Same position by another move order").waitFor();
  assert.match(await page.locator(".transposition").innerText(), /2\.Nf3 Nc6 3\.Bc4 Nf6/);
  await button("4. d3").click();
  await button("Preview through 4. d3").click();
  await heading("Add to White repertoire").waitFor();
  assert.match(await page.locator(".preview-edges").innerText(), /2… Nf6/);
  assert.match(await page.locator(".preview-edges").innerText(), /4\. d3\nAlready prepared/);
  await button("Save selected line").click();
  await page.getByText("Saved through 4. d3 to White repertoire.").waitFor();
  await button("← Games").click();
  await button("Andy vs Avery").click();
  await page.getByText(/Prepared here · Bc4/).waitFor();
  await button("← Games").click();
  await button("Andy vs River").first().click();
  await page.getByText(/Opponent played an unprepared move/).waitFor();
  await expectPiece(page, "d", 4, "black knight");
  await expectPiece(page, "c", 4, "white bishop");
  await button("← Previous").click();
  await expectPiece(page, "c", 6, "black knight");
  await page.getByRole("button",{name:/Played next 3… Nd4/}).click();
  await choose("d2d3"); await choose("g8f6"); await choose("e1g1");
  await button("Preview through 5. O-O").click();
  await heading("Add to White repertoire").waitFor();
  assert.equal(await page.locator(".preview-edges li").count(), 4);
  assert.match(await page.locator(".review-preview").innerText(), /2 new positions/);
  await button("Save selected line").click();
  await page.getByText("Saved through 5. O-O to White repertoire.").waitFor();
  await button("Preview through 5. O-O").click();
  await heading("Already saved").waitFor();
  await button("Return to played line").click(); await choose("c2c3");
  await page.getByRole("button",{name:/Preview through/}).click();
  await heading("Conflicts with saved preparation").waitFor();
  assert.match(await page.locator(".review-conflict").innerText(), /d3 → c3/);
  assert.equal(await button("Save selected line").count(), 0);
  await button("Mark reviewed").click();
  await button("← Games").click();
  const row = page.locator(".game-results>li").filter({has:button("Andy vs River")}).last();
  assert.match(await row.innerText(), /Last compared with White repertoire · Review 4\. d3 · you played 4\. c3/);
  assert.match(await row.innerText(), /Saved through 5. O-O to White repertoire/);
  await row.getByRole("button",{name:"Resume last position"}).click();
  await page.reload();
  await button("Reopen review").waitFor();
  assert.match(await page.locator(".board-caption").innerText(), /4\. c3/);
  await page.setViewportSize({width:375,height:812});
  await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth, null, {timeout:3000});
  assert.deepEqual(errors, []);
  console.log("Passed PGN import, rendered board squares, transposition range, endpoint save, conflict, review marker and mobile resume.");
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    const exited = once(server, "exit"); server.kill(); await exited;
  }
  await rm(root, {recursive:true, force:true});
}
