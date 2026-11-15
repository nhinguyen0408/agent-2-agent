import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CliReport, Settings } from "../shared/types";

const TOKEN_MARK = /oauth|access_token|accessToken|refresh_token|refreshToken|claudeAiOauth/i;

export function detectLocalClis(settings: Pick<Settings, "claudeCommand" | "cursorCommand" | "codexCommand" | "geminiCommand">): CliReport {
  return {
    claude: detectOne("claude", "Claude CLI", uniqueNames(settings.claudeCommand, "claude"), claudeLoggedIn),
    cursor: detectOne("cursor", "Cursor CLI", uniqueNames(settings.cursorCommand, "agent", "cursor-agent"), cursorLoggedIn),
    codex: detectOne("codex", "Codex CLI", uniqueNames(settings.codexCommand, "codex"), codexLoggedIn),
    gemini: detectOne("gemini", "Gemini CLI", uniqueNames(settings.geminiCommand, "gemini"), geminiLoggedIn),
  };
}

export function installedCliList(report: CliReport): string {
  const ids: string[] = [];
  if (report.claude.installed) ids.push("claude");
  if (report.cursor.installed) ids.push("cursor");
  if (report.codex.installed) ids.push("codex");
  if (report.gemini.installed) ids.push("gemini");
  return ids.join(",");
}

export function parseCliList(value: unknown): string {
  if (typeof value !== "string") return "";
  const ids = new Set<string>();
  for (const part of value.split(",")) {
    const id = part.trim().toLowerCase();
    if (id === "claude" || id === "cursor" || id === "codex" || id === "gemini") ids.add(id);
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
    path.join(home, ".codex", `${trimmed}.exe`),
    path.join(local, "OpenAI", "Codex", `${trimmed}.exe`),
    path.join(local, "Programs", "Codex", `${trimmed}.exe`),
    path.join(home, ".gemini", "bin", `${trimmed}.exe`),
    path.join(home, ".gemini", "bin", `${trimmed}.cmd`),
    path.join(home, ".gemini", "bin", trimmed),
    path.join(local, "gemini-cli", `${trimmed}.exe`),
    path.join(local, "gemini-cli", `${trimmed}.cmd`),
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
  id: "claude" | "cursor" | "codex" | "gemini",
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

function codexLoggedIn(): boolean | null {
  const text = readHead(path.join(os.homedir(), ".codex", "auth.json"));
  if (text && (TOKEN_MARK.test(text) || /"tokens"\s*:/.test(text))) return true;
  if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) return true;
  return text ? false : null;
}

function geminiLoggedIn(): boolean | null {
  const home = path.join(os.homedir(), ".gemini");
  const oauth = readHead(path.join(home, "oauth_creds.json"));
  if (oauth && TOKEN_MARK.test(oauth)) return true;
  const accounts = readHead(path.join(home, "google_accounts.json"));
  if (accounts && /"active"\s*:\s*"[^"]+"/.test(accounts)) return true;
  const envFile = readHead(path.join(home, ".env"));
  if (envFile && /^\s*(GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_GENAI_API_KEY)\s*=\s*\S+/m.test(envFile)) return true;
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENAI_API_KEY) return true;
  if (oauth || accounts) return false;
  return null;
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
