// Real UI and SQLite application with independent, optional analysis providers.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { checkDesktopBoardResize } from "./desktop_board_resize_browser.mjs";

const { chromium } = await import(process.env.TEMPO_PLAYWRIGHT || "playwright");
const temp = await mkdtemp(join(tmpdir(), "tempo-analysis-"));
const db = join(temp, "study.sqlite");
const binary = resolve(process.env.TEMPO_BINARY || "target/debug/tempo");
let server, browser;
try {
  execFileSync(binary, ["init", db]);
  server = spawn(binary, ["serve", db, resolve("tempo-ui/dist"), "0"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const [line] = await once(createInterface({ input: server.stdout }), "line");
  const url = line.replace("Tempo study at ", "");
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const button = (name) => page.getByRole("button", { name, exact: true });
  await page.goto(url);
  await button("Repertoires").click();
  await button("Build new repertoire").click();
  await checkDesktopBoardResize(page, "Analysis board");
  await page.getByRole("checkbox",{name:"All legal moves"}).check();
  await page.getByLabel("Name", { exact: true }).fill("Board test");
  await button("Pin e4").click();
  const surface = await page.locator("cg-board").first().boundingBox();
  assert(surface && surface.width > 100);
  const point = (file, rank) => [
    surface.x + ((file + 0.5) * surface.width) / 8,
    surface.y + ((8.5 - rank) * surface.height) / 8,
  ];
  await page.mouse.click(...point(4, 2));
  await page.mouse.click(...point(4, 4));
  await button("e5").waitFor();
  for (const [opponent, reply] of [
    ["e5", "Nf3"],
    ["c5", "Nf3"],
  ]) {
    await button(opponent).click();
    await button(reply).click();
    await button("Mark line").click();
    await button("Back one move").click();
    await button("Back one move").click();
  }
  await button("Back one move").click();
  assert.equal(await button("Pin e4").getAttribute("aria-pressed"), "true");
  await button("d4").click();
  const previewResponse = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/repertoires") &&
      r.request().postDataJSON()?.command === "marked_preview",
  );
  await button("Preview changes").click();
  const preview = await (await previewResponse).json();
  assert.equal(preview.status, "preview", JSON.stringify(preview));
  await button("Save repertoire").click();
  await page.getByText("Repertoire saved.", { exact: true }).waitFor();
  await button("Return").click();
  const post = async (cmd) =>
    (
      await fetch(url + "/api/repertoires", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cmd),
      })
    ).json();
  const list = await post({ command: "list" });
  const doc = await post({
    command: "read_document",
    dataset_id: list.dataset_id,
    repertoire_id: list.repertoires[0].id,
  });
  assert.match(doc.document.pgn, /e5/);
  assert.match(doc.document.pgn, /c5/);
  assert.doesNotMatch(doc.document.pgn, /d4/);
  await button("Analyze and build").click();
  await page.getByRole("heading", { name: "Analysis board" }).waitFor();
  await page.getByRole("checkbox",{name:"All legal moves"}).check();
  await button("e4").click();
  await page.waitForFunction(() =>
    document.querySelector("tbody")?.textContent.includes("This repertoire"),
  );
  await button("d5").click();
  await button("exd5").click();
  await button("Mark line").click();
  await button("Preview changes").click();
  await button("Save repertoire").waitFor();
  await post({
    command: "rename",
    dataset_id: list.dataset_id,
    repertoire_id: doc.repertoire_id,
    name: "Renamed by another page",
  });
  await button("Preview changes").click();
  await button("Refresh document").waitFor();
  assert.equal(await button("Save repertoire").count(), 0);
  await button("Refresh document").click();
  await page.getByRole("heading", { name: "Renamed by another page" }).waitFor();
  await button("Preview changes").click();
  await button("Save repertoire").click();
  await page.getByText("Repertoire saved.", { exact: true }).waitFor();
  const refreshed = await post({
    command: "read_document",
    dataset_id: list.dataset_id,
    repertoire_id: doc.repertoire_id,
  });
  assert.match(refreshed.document.pgn, /exd5/);
  assert.match(refreshed.document.pgn, /c5/);
  assert.deepEqual(errors, []);
  console.log(
    "Marked branches saved, unmarked experiment excluded, pin restored, opponent moves shown, stale preview rejected and refreshed.",
  );
} finally {
  await browser?.close();
  server?.kill();
  await rm(temp, { recursive: true, force: true });
}
