import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { copyFile, mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
execFileSync("python3", ["-B", fileURLToPath(new URL("./tools/development_guard.py", import.meta.url))], { stdio: "inherit" });
await rm("dist", { recursive: true, force: true });
const chessLicense = await readFile("node_modules/chess.js/LICENSE", "utf8");
const sounds = (await readdir("sounds")).filter(name => name.endsWith(".mp3"));

async function bundle(entry, directory, minify = false) {
  const assets = `${directory}/assets`;
  await mkdir(assets, { recursive: true });
  await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    minify,
    outdir: assets,
    entryNames: "app",
    assetNames: "[name]-[hash]",
    loader: { ".svg": "file" },
    banner: { js: `/* chess.js\n${chessLicense}*/` },
  });
  await Promise.all(sounds.map(name => copyFile(`sounds/${name}`, `${assets}/${name}`)));
}

await Promise.all([
  bundle("main.jsx", "dist"),
  bundle("phone.jsx", "dist/phone", true),
]);
await Promise.all([
  copyFile("phone.html", "dist/phone/index.html"),
  copyFile("phone.webmanifest", "dist/phone/assets/phone.webmanifest"),
  copyFile("phone-icon.png", "dist/phone/assets/phone-icon.png"),
]);
await writeFile(
  "dist/index.html",
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tempo</title><link rel="stylesheet" href="/assets/app.css"></head><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>',
);
