// Exercise the packaged Game Review table with a real, versioned repertoire and controlled source replies.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Chess } from "chess.js";

const {chromium} = await import(process.env.TEMPO_PLAYWRIGHT || "playwright");
const dir = await mkdtemp(join(tmpdir(),"tempo-review-measurements-"));
const binary = resolve(process.env.TEMPO_BINARY || "target/debug/tempo");
let host, browser;
try {
  const db = join(dir,"review.sqlite");
  execFileSync(binary,["init",db]);
  host = spawn(binary,["serve",db,resolve("tempo-ui/dist"),"0"], {cwd:dir,stdio:["ignore","pipe","inherit"]});
  const [line] = await once(createInterface({input:host.stdout}),"line");
  const origin = line.replace("Tempo study at ","");
  async function post(path,payload) {
    const response = await fetch(origin+"/api/"+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});
    const value = await response.json();
    assert(response.ok && value.status !== "error",JSON.stringify(value));
    return value;
  }
  const {dataset_id} = await post("repertoires",{command:"list"});
  const input = {dataset_id,name:"Open games",learner_color:"white",pgn:"1.e4 e5 2.Nf3 *"};
  async function save(data) {
    const {token} = await post("repertoires",{...data, command:"preview"});
    return post("repertoires",{...data,command:"save",token});
  }
  const {repertoires:[book]} = await save(input);
  await post("games/import",{dataset_id, command_id:"retained-game", learner:"Andy",
    pgn:'[White "Andy"]\n[Black "River"]\n\n1. d4 d5 2. c4 e6 1-0'});
  const {results:[game]} = await (await fetch(origin+"/api/games")).json();
  browser = await chromium.launch({channel:"chrome",headless:true});
  const page = await browser.newPage();
  page.setDefaultTimeout(8000);
  let releaseFish;
  const waiting = new Promise(resolve => {releaseFish=resolve;});
  let ratedAvailable = false;
  await page.route("**/api/analysis/evidence", async route => {
    const request = route.request().postDataJSON();
    const {source,request_id,fen} = request;
    if (source === "repertoire") return route.continue();
    let data;
    if (source === "stockfish") {
      await waiting;
      data={engine:"Fixture",comparison_complete:true,candidates:[{uci:"e2e4",centipawns:0}]};
    } else if (source === "maia") {
      const moves = new Chess(fen).moves({verbose:true}).map(move=>move.lan).filter(move=>move!=="e2e4");
      data={profile:"Test Maia",terminal:false,probabilities:Object.fromEntries([
        ["e2e4",0], ...moves.map(move=>[move,1/moves.length]),
      ])};
    } else if (source === "rated") {
      if (!ratedAvailable) return route.fulfill({json:{source,request_id,fen,status:"error",message:"Provider offline"}});
      data={white:70,draws:20,black:10,moves:[{uci:"e2e4",white:0,draws:0,black:0}]};
    }
    return route.fulfill({json:{source,request_id,fen,status:"complete",data}});
  });
  const params = new URLSearchParams({dataset_id,source:game.source,game_id:game.game_id,learner:game.learner,book:book.id});
  await page.goto(origin+"/#games?"+params);
  const button = name => page.getByRole("button",{name,exact:true});
  await button("Compare candidate moves").click();
  const table = page.getByRole("region",{name:"Move comparison"});
  const row = name => table.getByRole("row").filter({has:button(name)});
  await row("e4").getByRole("cell",{name:"Saved",exact:true}).waitFor();
  await row("d4").getByRole("cell",{name:"Checking…",exact:true}).first().waitFor();
  await table.getByText("Comparison sources and columns").click();
  await table.getByRole("checkbox",{name:"Nearby",exact:true}).uncheck();
  await table.getByRole("checkbox",{name:"Maia",exact:true}).check();
  await row("e4").getByRole("cell",{name:"0.0%",exact:true}).waitFor();
  assert((await table.locator("tbody tr").count()) <= 5);
  releaseFish();
  await row("e4").getByRole("cell",{name:"0.00",exact:true}).waitFor();
  await row("d4").getByRole("cell",{name:"—",exact:true}).first().waitFor();
  await table.getByRole("checkbox",{name:"Lichess Rapid",exact:true}).check();
  await row("e4").getByRole("cell",{name:"Unavailable",exact:true}).waitFor();
  ratedAvailable = true;
  await table.getByRole("button",{name:"Retry sources"}).click();
  await row("e4").getByRole("cell",{name:"0.0% · 0",exact:true}).waitFor();
  // Change the exact same destination behind the open review, forcing a new evidence read.
  await save({...input,repertoire_id:book.id,pgn:"1. c4 e5 *"});
  await button("Hide candidate moves").click();
  await button("Compare candidate moves").click();
  const warning = page.getByRole("alert").filter({hasText:"The repertoire changed."});
  await warning.waitFor();
  assert.equal(await table.getByRole("cell",{name:"Saved",exact:true}).count(),0);
  await table.getByText("Comparison sources and columns").click();
  await table.getByRole("checkbox",{name:"Nearby",exact:true}).uncheck();
  await button("Hide candidate moves").click();
  await button("Next move").click();
  await warning.getByRole("button",{name:"Reload comparison"}).waitFor();
  await button("Previous move").click();
  await button("Previously prepared · e4").waitFor();
  await page.route("**/api/games/review",route=>route.abort(),{times:1});
  await warning.getByRole("button",{name:"Reload comparison"}).click();
  await button("Retry review").waitFor();
  await warning.getByRole("button",{name:"Reload comparison"}).click();
  await button("Prepared · c4").waitFor();
  assert.equal(await warning.count(),0);
  await button("Compare candidate moves").click();
  await row("c4").getByRole("cell",{name:"Saved",exact:true}).waitFor();
  assert.equal(await row("e4").getByRole("cell",{name:"Saved",exact:true}).count(),0);
  console.log("Passed bounded comparison rows, retained zero measurements, pending/missing/unavailable source states and stale document reload.");
} finally {
  await browser?.close();
  if (host && host.exitCode===null) {const done=once(host,"exit");host.kill();await done;}
  await rm(dir,{recursive:true,force:true});
}
