import { build } from "esbuild";
import { copyFile, mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
await rm("dist", { recursive: true, force: true });
await mkdir("dist/assets", { recursive: true });
const chessLicense = await readFile("node_modules/chess.js/LICENSE", "utf8");
await build({
  entryPoints: ["main.jsx"],
  bundle: true,
  format: "esm",
  outdir: "dist/assets",
  entryNames: "app",
  assetNames: "[name]-[hash]",
  loader: { ".svg": "file" },
  banner: { js: `/* chess.js\n${chessLicense}*/` },
});
await Promise.all((await readdir("sounds"))
  .filter(name => name.endsWith(".mp3"))
  .map(name => copyFile(`sounds/${name}`, `dist/assets/${name}`)));
await writeFile(
  "dist/index.html",
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tempo</title><link rel="stylesheet" href="/assets/app.css"></head><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>',
);
