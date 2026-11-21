// From the assembled workspace, with TEMPO_BINARY and TEMPO_PLAYWRIGHT.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const { chromium } = await import(process.env.TEMPO_PLAYWRIGHT || "playwright");
const root = await mkdtemp(join(tmpdir(), "tempo-review-draft-"));
const database = join(root, "test.sqlite");
const binary = resolve(process.env.TEMPO_BINARY || "target/debug/tempo");
let server, browser;

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
  await post("games/import", {dataset_id,command_id:"river-import",learner:"Andy",
    pgn:'[White "Andy"]\n[Black "River"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bc4 Nd4 4. c3 Nxf3+ 1-0'});
  browser = await chromium.launch({channel:"chrome",headless:true});
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  const previews = [];
  const saves = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    if (!request.url().endsWith("/api/repertoires")) return;
    const cmd = request.postDataJSON();
    if (cmd?.command === "marked_preview") previews.push(cmd);
    if (cmd?.command === "save") saves.push(cmd);
  });
  const button = name => page.getByRole("button",{name,exact:true});
  const draftMoves = page.locator(".draft-moves");
  async function play(move) {
    const field=page.getByLabel("Chess move");
    if (!await field.isVisible()) await page.getByText("Enter a move",{exact:true}).click();
    await field.fill(move); await field.press("Enter");
  }
  await page.goto(origin+"/#games");
  await button("Andy vs River").click();
  await play("d2d3"); await play("g8f6");
  const original = await draftMoves.innerText();
  assert.match(original,/Nd4 4.d3 Nf6/);
  await button("Previous move").click();
  await play("d7d6");
  assert.equal(await draftMoves.innerText(),original);
  await button("Starting position").click();
  await page.reload(); await button("Return to draft").waitFor();
  assert.equal(await draftMoves.innerText(),original);
  await button("← Games").click();
  await page.goBack();
  await button("Return to draft").waitFor();
  assert.equal(await draftMoves.innerText(),original);
  await button("← Games").click();
  await button("Andy vs River").click();
  await button("Return to draft").click();
  await play("e1g1");
  assert.match(await draftMoves.innerText(),/5.O-O/);
  await button("Starting position").click();
  await play("d2d4");
  assert.match(await draftMoves.innerText(),/5.O-O/);
  await button("Replace draft with viewed line").click();
  assert.equal(await draftMoves.innerText(),"1.d4");
  await button("Discard draft").click();
  assert.equal(await button("Discard draft").count(),0);
  await page.reload();
  assert.equal(await button("Discard draft").count(),0);
  await page.getByRole("button",{name:/Opponent played an unprepared move/}).click();
  await play("d2d3"); await play("g8f6"); await play("e1g1");
  const editor = await page.context().newPage();
  await editor.goto(page.url());
  const editorMove = async move => {
    const field = editor.getByLabel("Chess move");
    if (!await field.isVisible()) await editor.getByText("Enter a move",{exact:true}).click();
    await field.fill(move); await field.press("Enter");
  };
  await button("Starting position").click();
  let releasePreview, enteredPreview;
  const heldPreview=new Promise(resolve=>{releasePreview=resolve;});
  const previewStarted=new Promise(resolve=>{enteredPreview=resolve;});
  await page.route("**/api/repertoires",async route=>{
    if(route.request().postDataJSON().command!=="marked_preview") return route.continue();
    enteredPreview(); const response = await route.fetch();
    await heldPreview; await route.fulfill({response});
  });
  await button("Preview through 5. O-O").click();
  await previewStarted;
  await editorMove("d7d6");
  await page.waitForFunction(()=>document.querySelector(".draft-moves").textContent.endsWith("d6"));
  releasePreview();
  await page.getByText("The draft changed during preview. Preview its current line.").waitFor();
  assert.equal(await button("Save selected line").count(),0);
  await page.unroute("**/api/repertoires");
  await button("Preview through 5… d6").click();
  await page.getByRole("heading",{name:"Add to White repertoire"}).waitFor();
  assert.deepEqual(previews.at(-1).lines,[["c6d4","d2d3","g8f6","e1g1","d7d6"]]);
  await button("Next move").click();
  await page.route("**/api/repertoires",async route=>{
    if(route.request().postDataJSON().command!=="save") return route.continue();
    await route.fetch(); await route.abort("failed");
  });
  await button("Save selected line").click();
  await page.locator(".review-side [role=alert]").waitFor();
  await button("Retry same save").waitFor();
  await editorMove("c2c3");
  await page.waitForFunction(()=>document.querySelector(".draft-moves").textContent.endsWith("c3"));
  await button("Retry same save").waitFor();
  await page.unroute("**/api/repertoires");
  await button("Retry same save").click();
  await page.getByText("Saved through 5… d6 to White repertoire.").waitFor();
  assert.equal(saves.length,2);
  assert.deepEqual(saves[0],saves[1]);
  await button("Discard draft").waitFor();
  assert.match(await draftMoves.innerText(),/6.c3$/);
  // Repertoires can also recover the exact command. Its accepted reply clears only the matched draft.
  await button("Preview through 6. c3").click();
  await page.getByRole("heading",{name:"Add to White repertoire"}).waitFor();
  await page.route("**/api/repertoires",async route=>{
    if(route.request().postDataJSON().command!=="save") return route.continue();
    await route.fetch(); await route.abort("failed");
  });
  await button("Save selected line").click();
  await page.locator(".review-side [role=alert]").waitFor();
  await button("Retry same save").waitFor();
  await page.unroute("**/api/repertoires");
  const gameUrl=page.url();
  await page.reload();
  await page.getByText("Repertoire saved.",{exact:true}).waitFor();
  assert.deepEqual(saves[2],saves[3]);
  await page.goto(gameUrl); await page.reload();
  await page.getByRole("heading",{name:"Opening decision"}).waitFor();
  assert.equal(await button("Discard draft").count(),0);
  assert.deepEqual(errors,[]);
  console.log("Verified draft navigation, alternate exploration, reload, Back, library re-entry, explicit replacement/discard and exact signed save.");
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    const exited = once(server, "exit"); server.kill(); await exited;
  }
  await rm(root, {recursive:true, force:true});
}
