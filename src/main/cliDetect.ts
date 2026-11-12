import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CliReport, Settings } from "../shared/types";

const TOKEN_MARK = /oauth|access_token|accessToken|refresh_token|refreshToken|claudeAiOauth/i;

export function detectLocalClis(settings: Pick<Settings, "claudeCommand" | "cursorCommand">): CliReport {
  return {
    claude: detectOne("claude", "Claude CLI", uniqueNames(settings.claudeCommand, "claude"), claudeLoggedIn),
    cursor: detectOne("cursor", "Cursor CLI", uniqueNames(settings.cursorCommand, "agent", "cursor-agent"), cursorLoggedIn),
  };
}

export function installedCliList(report: CliReport): string {
  const ids: string[] = [];
  if (report.claude.installed) ids.push("claude");
  if (report.cursor.installed) ids.push("cursor");
  return ids.join(",");
}

export function parseCliList(value: unknown): string {
  if (typeof value !== "string") return "";
  const ids = new Set<string>();
  for (const part of value.split(",")) {
    const id = part.trim().toLowerCase();
    if (id === "claude" || id === "cursor") ids.add(id);
  }
  return [...ids].join(",");
}

export function findExecutable(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (path.isAbsolute(trimmed) || trimmed.includes(path.sep) || trimmed.includes("/")) {
    if (!fs.existsSync(trimmed) || isCursorIde(trimmed)) return null;
    return trimmed;
  }
  const home = os.homedir();
  const local = process.env.LOCALAPPDATA || "";
  const roaming = process.env.APPDATA || "";
  const candidates = [
    path.join(home, ".local", "bin", `${trimmed}.exe`),
    path.join(home, ".local", "bin", `${trimmed}.cmd`),
    path.join(home, ".local", "bin", trimmed),
    path.join(home, ".claude", "local", `${trimmed}.exe`),
    path.join(home, ".claude", "bin", `${trimmed}.exe`),
    path.join(local, "cursor-agent", `${trimmed}.exe`),
    path.join(local, "cursor-agent", `${trimmed}.cmd`),
    path.join(roaming, "npm", `${trimmed}.cmd`),
    path.join(roaming, "npm", `${trimmed}.exe`),
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate) && !isCursorIde(candidate)) return candidate;
  }
  return whereExecutable(trimmed);
}

function isCursorIde(file: string): boolean {
  const base = path.basename(file).toLowerCase();
  if (base !== "cursor.cmd" && base !== "cursor.exe" && base !== "cursor") return false;
  const lower = file.toLowerCase();
  return lower.includes(`${path.sep}resources${path.sep}app${path.sep}bin${path.sep}`);
}

function detectOne(
  id: "claude" | "cursor",
  label: string,
  names: string[],
  login: () => boolean | null,
): CliReport["claude"] {
  for (const name of names) {
    const found = findExecutable(name);
    if (!found) continue;
    return { id, label, installed: true, path: found, loggedIn: login() };
  }
  return { id, label, installed: false, path: null, loggedIn: null };
}

function uniqueNames(...names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    const trimmed = name.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function claudeLoggedIn(): boolean | null {
  const home = os.homedir();
  const files = [
    path.join(home, ".claude", ".credentials.json"),
    path.join(home, ".claude", "credentials.json"),
    path.join(home, ".claude.json"),
  ];
  let sawFile = false;
  for (const file of files) {
    const text = readHead(file);
    if (!text) continue;
    sawFile = true;
    if (TOKEN_MARK.test(text)) return true;
  }
  return sawFile ? false : null;
}

function cursorLoggedIn(): boolean | null {
  const home = os.homedir();
  const files = [
    path.join(home, ".cursor", "cli-config.json"),
    path.join(home, ".cursor", "auth.json"),
    path.join(home, ".config", "cursor", "auth.json"),
  ];
  for (const file of files) {
    const text = readHead(file);
    if (text && TOKEN_MARK.test(text)) return true;
  }
  return null;
}

function readHead(file: string): string {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(65536);
      const read = fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.subarray(0, read).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

function whereExecutable(name: string): string | null {
  if (process.platform !== "win32") return null;
  try {
    const output = execFileSync("where.exe", [name], {
      encoding: "utf8",
      timeout: 2000,
      windowsHide: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const hits = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.toLowerCase().startsWith("info:") && fs.existsSync(line) && !isCursorIde(line));
    return hits.find((hit) => hit.toLowerCase().endsWith(".exe")) ?? hits[0] ?? null;
  } catch {
    return null;
  }
}
