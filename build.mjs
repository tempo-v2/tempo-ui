import { build } from "esbuild";
import { mkdir, writeFile, rm } from "node:fs/promises";
await rm("dist", { recursive: true, force: true });
await mkdir("dist/assets", { recursive: true });
await build({
  entryPoints: ["main.jsx"],
  bundle: true,
  format: "esm",
  outdir: "dist/assets",
  entryNames: "app",
  assetNames: "[name]-[hash]",
  loader: { ".svg": "file" },
});
await writeFile(
  "dist/index.html",
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tempo</title><link rel="stylesheet" href="/assets/app.css"></head><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>',
);
