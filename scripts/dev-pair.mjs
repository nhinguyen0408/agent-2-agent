import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "./build.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await build();
const electron = createRequire(path.join(root, "package.json"))("electron");

function launch(profile) {
  return spawn(electron, [".", `--profile=${profile}`], {
    cwd: root,
    stdio: "inherit",
    windowsHide: false,
  });
}

const first = launch("A");
const second = launch("B");
let alive = 2;
const done = () => {
  alive -= 1;
  if (alive === 0) process.exit(0);
};
first.on("exit", done);
second.on("exit", done);
