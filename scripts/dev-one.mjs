import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "./build.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profile = process.argv[2] || "A";
const extra = process.argv.slice(3);

await build();
const electron = createRequire(path.join(root, "package.json"))("electron");
const child = spawn(electron, [".", `--profile=${profile}`, ...extra], {
  cwd: root,
  stdio: "inherit",
  windowsHide: false,
});
child.on("exit", (code) => process.exit(code ?? 0));
