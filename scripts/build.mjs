import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function build() {
  mkdirSync(path.join(root, "dist"), { recursive: true });
  const main = {
    bundle: true,
    sourcemap: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["electron"],
    packages: "external",
    logLevel: "info",
  };
  await esbuild.build({
    ...main,
    entryPoints: [path.join(root, "src/main/index.ts")],
    outfile: path.join(root, "dist/main.js"),
  });
  await esbuild.build({
    ...main,
    entryPoints: [path.join(root, "src/preload/preload.ts")],
    outfile: path.join(root, "dist/preload.js"),
  });
  const page = {
    bundle: true,
    sourcemap: true,
    platform: "browser",
    format: "iife",
    target: "chrome128",
    logLevel: "info",
  };
  await esbuild.build({
    ...page,
    entryPoints: [path.join(root, "src/renderer/renderer.ts")],
    outfile: path.join(root, "dist/renderer.js"),
  });
  await esbuild.build({
    ...page,
    entryPoints: [path.join(root, "src/renderer/previewWindow.ts")],
    outfile: path.join(root, "dist/preview.js"),
  });
  copyFileSync(path.join(root, "src/renderer/index.html"), path.join(root, "dist/index.html"));
  copyFileSync(path.join(root, "src/renderer/preview.html"), path.join(root, "dist/preview.html"));
  copyFileSync(path.join(root, "src/renderer/styles.css"), path.join(root, "dist/styles.css"));
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invoked) {
  await build();
}
