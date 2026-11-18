// Run from the assembled workspace. TEMPO_PLAYWRIGHT names an installed Playwright module.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const { chromium } = await import(process.env.TEMPO_PLAYWRIGHT || "playwright");
const directory = await mkdtemp(join(tmpdir(), "tempo-editor-browser-"));
const database = join(directory, "disposable.sqlite");
const probe = createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const url = `http://127.0.0.1:${port}`;
const endpoint = "**/api/repertoires";
const recoveryKey = "tempo-repertoire-recovery-v4";
const original = "1. e4 e5 2. Nf3 *\n";
const annotated = '[Event "Annotated"]\n\n1. e4 e5 2. Nf3 *\n';
const changed = "1. d4 d5 2. c4 *\n";
let application;
let browser;

async function start() {
  application = spawn("make", ["start-dev", `TEMPO_DB=${database}`, `TEMPO_PORT=${port}`], {
    detached: true, stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve, reject) => {
    let log = "";
    application.stdout.on("data", (chunk) => {
      log += chunk;
      if (log.includes(`Tempo study at ${url}`)) resolve();
    });
    application.once("exit", (code) => reject(new Error(`Tempo exited (${code})\n${log}`)));
  });
}

async function stop() {
  if (application?.exitCode !== null) return;
  const exit = once(application, "exit");
  process.kill(-application.pid, "SIGINT");
  await exit;
}

async function post(command) {
  const result = await fetch(`${url}/api/repertoires`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command),
  });
  assert.equal(result.status, 200);
  return result.json();
}

function durableRows() {
  const sql = new DatabaseSync(database, { readOnly: true });
  try {
    return ["learning", "attempts", "assessments", "receipts", "daily_tactics_allowances",
      "current_content", "repertoire_documents", "content_receipts", "store_state"].map((table) =>
      sql.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
  } finally {
    sql.close();
  }
}

try {
  execFileSync("make", ["init-dev", `TEMPO_DB=${database}`], { stdio: "inherit" });
  await start();
  const { dataset_id } = await post({ command: "list" });
  async function upload(name, pgn, repertoire_id) {
    const input = { dataset_id, name, pgn, learner_color: "white", repertoire_id };
    const preview = await post({ command: "preview", ...input });
    assert.equal(preview.status, "preview", JSON.stringify(preview));
    const saved = await post({ command: "save", token: preview.token, ...input });
    assert.equal(saved.status, "repertoires", JSON.stringify(saved));
    return saved.repertoires.find((item) => item.name === name).id;
  }
  const alpha = await upload("Alpha", original);
  const beta = await upload("Beta", "1. c4 e5 2. Nc3 *\n");
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(10_000);
  await page.goto(url);
  const button = (name) => page.getByRole("button", { name, exact: true });
  await button("Repertoires").click();
  await button("Edit Alpha").waitFor();
  const text = page.getByRole("textbox", { name: "Repertoire PGN" });
  const waitText = (value) => page.waitForFunction((source) =>
    document.querySelector("textarea")?.value === source, value);
  const commands = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/repertoires")) commands.push(request.postDataJSON());
  });

  let releaseRead;
  const delayed = new Promise((resolve) => { releaseRead = resolve; });
  let readStarted;
  const started = new Promise((resolve) => { readStarted = resolve; });
  const delayAlpha = async (route) => {
    const command = route.request().postDataJSON();
    if (command.command !== "read_document" || command.repertoire_id !== alpha) return route.continue();
    readStarted();
    await delayed;
    await route.continue();
  };
  await page.route(endpoint, delayAlpha);
  await button("Edit Alpha").click();
  await started;
  await button("Edit Beta").click();
  await waitText("1. c4 e5 2. Nc3 *\n");
  const lateResponse = page.waitForResponse((response) => response.url().endsWith("/api/repertoires")
    && response.request().postDataJSON().repertoire_id === alpha);
  releaseRead();
  await lateResponse;
  await page.unroute(endpoint, delayAlpha);
  await page.getByRole("heading", { name: "Edit repertoire: Beta" }).waitFor();

  const sql = new DatabaseSync(database);
  sql.prepare("DELETE FROM repertoire_documents WHERE repertoire_id=?").run(beta);
  sql.close();
  await button("Edit Beta").click();
  await page.getByText(/There is no verified current PGN for this repertoire/).waitFor();
  assert.equal(await text.count(), 0);
  await button("Upload replacement").click();
  assert.equal(await page.getByLabel("Destination").inputValue(), beta);
  await upload("Beta", "1. c4 e5 2. Nc3 *\n", beta);

  await button("Edit Alpha").click();
  await waitText(original);
  const beforeRead = durableRows();
  await text.fill("bad illegal move");
  await button("Preview changes").click();
  await page.getByRole("alert").waitFor();
  assert.equal(await text.inputValue(), "bad illegal move");
  page.once("dialog", (dialog) => dialog.dismiss());
  await button("Cancel edit").click();
  assert.equal(await text.inputValue(), "bad illegal move");
  page.once("dialog", (dialog) => dialog.dismiss());
  await button("Study").click();
  assert.equal(await text.inputValue(), "bad illegal move");

  const downloading = page.waitForEvent("download");
  await button("Download PGN for Alpha").click();
  const download = await downloading;
  assert.equal(download.suggestedFilename(), "Alpha.pgn");
  assert.equal(await readFile(await download.path(), "utf8"), original);
  assert.deepEqual(durableRows(), beforeRead);

  await text.fill(annotated);
  await button("Preview changes").click();
  await button("Save repertoire").waitFor();
  await text.fill(annotated + "\n");
  assert.equal(await button("Save repertoire").count(), 0);
  await text.fill(annotated);
  await button("Preview changes").click();

  let failRead = false;
  const breakRead = async (route) => {
    const command = route.request().postDataJSON().command;
    if (command === "save") failRead = true;
    if (command === "read_document" && failRead) {
      failRead = false;
      return route.abort();
    }
    return route.continue();
  };
  await page.route(endpoint, breakRead);
  await button("Save repertoire").click();
  await page.getByText("Repertoire saved.", { exact: true }).waitFor();
  await button("Retry reload").waitFor();
  assert.equal(await text.inputValue(), annotated);
  assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), recoveryKey), null);
  assert.equal(await button("Retry save").count(), 0);
  const afterFailure = commands.length;
  await button("Retry reload").click();
  await button("Retry reload").waitFor({ state: "hidden" });
  assert.deepEqual(commands.slice(afterFailure).map(({ command }) => command), ["read_document"]);
  await page.unroute(endpoint, breakRead);

  await text.fill(changed);
  await upload("Beta", "1. c4 c5 2. Nc3 *\n", beta);
  await button("Preview changes").click();
  await page.getByText(/changed after you opened it/).waitFor();
  assert.equal(await text.inputValue(), changed);
  assert.equal(await button("Preview changes").isDisabled(), true);
  page.once("dialog", (dialog) => dialog.accept());
  await button("Reload current PGN").click();
  await waitText(annotated);
  await text.fill(changed);
  await button("Preview changes").click();
  await button("Save repertoire").waitFor();
  const renamed = await post({ command: "rename", dataset_id, repertoire_id: alpha, name: "Alpha renamed" });
  assert.equal(renamed.status, "repertoires");
  await button("Save repertoire").click();
  await page.getByText(/Preview this PGN again/).waitFor();
  assert.equal(await text.inputValue(), changed);
  page.once("dialog", (dialog) => dialog.accept());
  await button("Reload current PGN").click();
  await page.getByRole("heading", { name: "Edit repertoire: Alpha renamed" }).waitFor();
  await text.fill(changed);
  await button("Preview changes").click();
  await button("Save repertoire").waitFor();

  const loseSave = async (route) => {
    if (route.request().postDataJSON().command !== "save") return route.continue();
    const response = await route.fetch();
    assert.equal((await response.json()).status, "repertoires");
    await route.abort();
  };
  await page.route(endpoint, loseSave);
  await button("Save repertoire").click();
  await page.getByText("Failed to fetch", { exact: true }).waitFor();
  await button("Retry save").waitFor();
  const pending = JSON.parse(await page.evaluate((key) => sessionStorage.getItem(key), recoveryKey));
  assert.equal(pending.pgn, changed);
  assert.equal(pending.repertoire_id, alpha);
  assert.equal(Object.hasOwn(pending, "base_revision"), false);
  await page.unroute(endpoint, loseSave);
  const acceptedRows = durableRows();
  await stop();
  await start();
  page.once("dialog", (dialog) => dialog.accept());
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("Repertoire saved.", { exact: true }).waitFor();
  await button("Edit Alpha renamed").click();
  await waitText(changed);
  assert.deepEqual(commands.filter((command) => command.command === "save").at(-1), pending);
  assert.deepEqual(durableRows(), acceptedRows);

  await button("Study").click();
  await page.evaluate((key) => {
    const getItem = Storage.prototype.getItem;
    window.restoreRecoveryRead = () => { Storage.prototype.getItem = getItem; };
    Storage.prototype.getItem = function (name) {
      if (name === key) throw new Error("injected recovery read failure");
      return getItem.call(this, name);
    };
  }, recoveryKey);
  await button("Repertoires").click();
  await button("Retry reading recovery").waitFor();
  assert.equal(await button("Reload repertoires").count(), 0);
  assert.equal(await button("Edit Alpha renamed").count(), 0);
  await page.evaluate(() => window.restoreRecoveryRead());
  await button("Retry reading recovery").click();
  await button("Edit Alpha renamed").waitFor();
  console.log("Browser editor, download, freshness, exact Save recovery and restart passed");
} finally {
  await browser?.close();
  await stop();
  await rm(directory, { recursive: true, force: true });
}
