// From the assembled workspace, with TEMPO_BINARY and TEMPO_PLAYWRIGHT.
import assert from "node:assert/strict";
import { Chess } from "chess.js";
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
  const choose = async uci => {
    const field = page.getByLabel("Chess move");
    if (!await field.isVisible()) await page.getByText("Enter a move", {exact:true}).click();
    await field.fill(uci); await field.press("Enter");
  };
  await page.goto(origin + "/#games");
  await button("Import PGN").click();
  await page.getByLabel("Learner name").fill("Andy");
  await page.getByLabel("Or paste PGN").fill('[White "Andy"]\n[Black "River"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bc4 Nd4 4. c3 Nxf3+ 1-0');
  await button("Import games").click();
  await heading("Import results").waitFor();
  const secondBook = {...book, name:"Other white repertoire", pgn:"1. d4 d5 2. c4 *"};
  const secondDraft = await post("repertoires", {command:"preview", ...secondBook});
  await post("repertoires", {command:"save", ...secondBook, token:secondDraft.token});
  await page.reload();
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
  async function verifyDrop(from,to,piece,removed) {
    const rect = await page.locator(".review-board cg-board").boundingBox();
    const point = (f,r) => [rect.x+(f+.5)*rect.width/8, rect.y+(8-r+.5)*rect.height/8];
    await page.mouse.move(...point(...from)); await page.mouse.down();
    await page.mouse.move(...point(...to), {steps:12});
    await page.evaluate(({piece,removed}) => {
      const board = document.querySelector(".review-board cg-board");
      const held = board.querySelector("piece.dragging");
      if (!held) throw Error("Missing dragged piece");
      window.dropFrames = [];
      board.addEventListener("mouseup", () => {
        const sample = () => {
          const rect = board.getBoundingClientRect();
          const coords = [...board.querySelectorAll(piece)].map(el => {
            const box = el.getBoundingClientRect();
            return [(box.x-rect.x)/box.width,(box.y-rect.y)/box.height];
          });
          window.dropFrames.push({coords, captured:removed ? [...board.querySelectorAll(removed)].length : 0});
          if(window.dropFrames.length < 16) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }, {once:true});
    }, {piece,removed});
    await page.mouse.up();
    await page.waitForFunction(() => window.dropFrames.length === 16);
    const frames = await page.evaluate(() => window.dropFrames);
    assert(frames.every(frame => frame.coords.some(([x,y]) => Math.abs(x-to[0])<.05 && Math.abs(y-(8-to[1]))<.05)), JSON.stringify(frames));
    if (removed) {
      const firstRemoved = frames.findIndex(frame => frame.captured === 1);
      assert(firstRemoved >= 0 && firstRemoved <= 2);
      assert(frames.slice(firstRemoved).every(frame => frame.captured === 1));
    }
  }

  const overlay = page.getByLabel("Prepared and played arrows");
  await page.waitForFunction(()=>document.querySelectorAll(".review-board svg line").length >= 2);
  await overlay.uncheck();
  await page.waitForFunction(()=>document.querySelectorAll(".review-board svg line").length === 0);
  await overlay.check();
  const sourceCalls = [];
  await page.route("**/api/analysis/evidence", async route => {
    const req=route.request().postDataJSON();
    if(req.source==="repertoire") return route.continue();
    sourceCalls.push(req);
    let data;
    if(req.source==="stockfish") data={engine:"Test engine",comparison_complete:true,candidates:[
      {uci:"f1c4",centipawns:32},{uci:"f1b5",centipawns:18},{uci:"c2c4",centipawns:2}].slice(0,req.candidate_count)};
    if(req.source==="stockfish" && req.fen.split(" ")[1]==="b") data={engine:"Test engine",comparison_complete:true,
      candidates:[{uci:"a7a6",centipawns:70},{uci:"g8f6",centipawns:-15}]};
    if(req.source==="rated") data={white:5,draws:3,black:2,moves:[{uci:"f1b5",white:3,draws:1,black:2}]};
    if(req.source==="maia") data={profile:"Rapid 1500",terminal:false,
      probabilities:Object.fromEntries(new Chess(req.fen).moves({verbose:true}).map(({lan})=>[lan,lan==="f1c4"?.7:lan==="f1b5"?.3:0]))};
    await route.fulfill({json:{request_id:req.request_id,fen:req.fen,source:req.source,status:"complete",data}});
  });
  await button("Compare candidate moves").click();
  const table = page.getByRole("region",{name:"Move comparison"});
  await table.getByRole("row").filter({hasText:"Bc4"}).getByRole("button",{name:"Circle Bc4"}).click();
  await page.waitForFunction(()=>!!document.querySelector(".review-board svg circle"));
  await table.getByText("Comparison sources and columns").click();
  await table.getByText("+0.32",{exact:true}).waitFor();
  const ranks = page.locator(".review-board svg");
  await table.getByLabel("Stockfish on board").check();
  await ranks.getByText("1/3",{exact:true}).waitFor();
  await ranks.getByText("2",{exact:true}).waitFor();
  assert.equal(sourceCalls.some(r=>r.source==="rated" || r.source==="maia"),false);
  await table.getByRole("checkbox",{name:"Lichess Rapid"}).check();
  await table.getByRole("checkbox",{name:"Maia"}).check();
  await table.getByText("60.0% · 6",{exact:true}).waitFor();
  await table.getByText("70.0%",{exact:true}).waitFor();
  await table.getByRole("button",{name:"Maia",exact:true}).click();
  assert.match(await table.locator("tbody tr").first().innerText(),/Bc4/);
  await table.getByLabel("Stockfish lines").selectOption("1");
  await page.waitForFunction(()=>!document.body.textContent.includes("+0.18"));
  await table.getByText("+0.32",{exact:true}).waitFor();
  assert(sourceCalls.some(r=>r.candidate_count===1));
  await ranks.getByText("1",{exact:true}).waitFor();
  assert.equal(await ranks.getByText("1/3",{exact:true}).count(),0);
  await table.getByLabel("Move Nearby column left").click();
  await table.getByRole("checkbox",{name:"Stockfish",exact:true}).uncheck();
  await ranks.getByText("1",{exact:true}).waitFor({state:"detached"});
  assert.equal(await table.getByRole("columnheader",{name:"Stockfish"}).count(),0);
  await button("Hide candidate moves").click();
  await verifyDrop([5,1],[1,5],"piece.bishop.white");
  await button("Compare candidate moves").click();
  await table.getByText("-0.70",{exact:true}).waitFor();
  assert.match(await table.locator("tbody tr").first().innerText(),/a6/);
  await table.getByLabel("Stockfish on board").check();
  await ranks.getByText("1",{exact:true}).waitFor();
  await button("Hide candidate moves").click();
  await ranks.getByText("1",{exact:true}).waitFor({state:"detached"});
  await page.unroute("**/api/analysis/evidence");
  await choose("a7a6");
  await verifyDrop([1,5],[2,6],"piece.bishop.white","piece.black.knight");
  await expectPiece(page,"c",6,"white bishop");
  await button("Starting position").click();
  for(const move of ["a2a4","h7h5","a4a5","h5h4","a5a6","h4h3","a6b7","h3g2"]) await choose(move);
  const bounds = await page.locator(".review-board cg-board").boundingBox();
  async function clickSquare(file,rank) {
    await page.mouse.click(bounds.x+(file+.5)*bounds.width/8,bounds.y+(8-rank+.5)*bounds.height/8);
  }
  await clickSquare(1,7); await clickSquare(0,8);
  await button("Cancel").click();
  await expectPiece(page,"b",7,"white pawn");
  await clickSquare(1,7); await clickSquare(0,8);
  await button("Knight").click();
  await expectPiece(page,"a",8,"white knight");
  assert.match(await page.locator(".branch-line").innerText(),/bxa8=N/);
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
  const destination = page.getByLabel("Destination repertoire");
  const boardBeforeSwitch = await page.getByRole("group",{name:"Game review board"}).getAttribute("data-fen");
  const rangeBeforeSwitch = await page.getByLabel("Start from").inputValue();
  await destination.selectOption({label:"Other white repertoire · white"});
  await page.getByText(/Prepared here · d4/).waitFor();
  await expectPiece(page, "g", 1, "white king");
  assert.equal(await page.getByRole("group",{name:"Game review board"}).getAttribute("data-fen"), boardBeforeSwitch);
  assert.match(await page.locator(".branch-line").innerText(), /d3 Nf6 5.O-O/);
  assert.equal(await page.getByLabel("Start from").inputValue(), rangeBeforeSwitch);
  assert.equal(await button("Save selected line").count(), 0);
  await button("Preview through 5. O-O").click();
  await heading("Conflicts with saved preparation").waitFor();
  await destination.selectOption({label:"White repertoire · white"});
  await page.getByText(/Opponent played an unprepared move/).waitFor();
  await expectPiece(page, "g", 1, "white king");
  await button("Preview through 5. O-O").click();
  await heading("Add to White repertoire").waitFor();
  await button("Save selected line").click();
  await page.getByText("Saved through 5. O-O to White repertoire.").waitFor();
  await page.getByText(/Earlier comparison · 3… Nd4 · Opponent played an unprepared move/).waitFor();
  await page.reload();
  await page.getByText(/Earlier comparison · 3… Nd4/).waitFor();
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
