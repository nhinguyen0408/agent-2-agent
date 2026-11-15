import fs from "node:fs";
import path from "node:path";
import type { Settings } from "../shared/types";
import type { WorkFile } from "../shared/preview";
import { previewKind } from "../shared/preview";

export const MAX_FILE_BYTES = 32 * 1024 * 1024;

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function safeFileName(name: string): string {
  const base = path.basename(name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  const cleaned = base.replace(/^\.+/, "").slice(0, 120);
  return cleaned || "file.bin";
}

export function fileNameFromHeader(value: string | string[] | undefined): string {
  const raw = (Array.isArray(value) ? value[0] : value || "").trim();
  if (!raw) return "file.bin";
  try {
    return safeFileName(decodeURIComponent(raw));
  } catch {
    return safeFileName(raw);
  }
}

export function resolveInside(workDir: string, requested: string): string {
  const root = path.resolve(workDir);
  const target = path.resolve(root, requested.trim());
  if (!insideDir(root, target)) throw new Error("File phải nằm trong thư mục làm việc.");
  return target;
}

export function insideDir(root: string, target: string): boolean {
  const base = path.resolve(root);
  const full = path.resolve(target);
  const rel = path.relative(base, full);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function configuredSkillDir(settings: Settings): string {
  const dirs: Partial<Record<Settings["provider"], string>> = {
    "claude-cli": settings.claudeSkillDir,
    "cursor-cli": settings.cursorSkillDir,
    "codex-cli": settings.codexSkillDir,
    "gemini-cli": settings.geminiSkillDir,
  };
  return (dirs[settings.provider] ?? "").trim();
}

export function skillIndex(dir: string): string {
  const root = dir.trim();
  if (!root) return "";
  let entries: fs.Dirent[];
  try {
    if (!fs.statSync(root).isDirectory()) return "";
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return "";
  }
  const lines: string[] = [];
  const folders = entries.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name, "vi"));
  for (const folder of folders) {
    if (lines.length >= 8) break;
    const base = path.join(root, folder.name);
    const skill = ["SKILL.md", "skill.md", "AGENTS.md"].map((name) => path.join(base, name)).find((file) => fs.existsSync(file));
    if (!skill) continue;
    const note = firstTextLine(skill);
    lines.push(note ? `- ${folder.name}: ${base} — ${note}` : `- ${folder.name}: ${base}`);
  }
  const docs = entries
    .filter((entry) => entry.isFile() && /\.(md|markdown)$/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name, "vi"));
  for (const file of docs) {
    if (lines.length >= 8) break;
    const full = path.join(root, file.name);
    const note = firstTextLine(full);
    lines.push(note ? `- ${file.name}: ${full} — ${note}` : `- ${file.name}: ${full}`);
  }
  return lines.join("\n");
}

function firstTextLine(file: string): string {
  try {
    const text = fs.readFileSync(file, "utf8").slice(0, 2000);
    const line = text.split(/\r?\n/).map((item) => item.replace(/^#+\s*/, "").trim()).find(Boolean) ?? "";
    return line.slice(0, 80);
  } catch {
    return "";
  }
}

export async function listWorkFiles(dir: string): Promise<{ found: boolean; files: WorkFile[] }> {
  const root = path.resolve(dir);
  let entries: fs.Dirent[];
  try {
    const stat = await fs.promises.stat(root);
    if (!stat.isDirectory()) return { found: false, files: [] };
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return { found: false, files: [] };
  }
  const files: WorkFile[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      files.push({ name: entry.name, path: path.join(root, entry.name), preview: null, size: 0, dir: true });
      continue;
    }
    if (!entry.isFile()) continue;
    const full = path.join(root, entry.name);
    let size = 0;
    try {
      size = (await fs.promises.stat(full)).size;
    } catch {
      continue;
    }
    files.push({ name: entry.name, path: full, preview: previewKind(entry.name), size, dir: false });
  }
  files.sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    return a.name.localeCompare(b.name, "vi");
  });
  return { found: true, files: files.slice(0, 300) };
}

export async function readFileLimited(filePath: string, maxBytes: number): Promise<Buffer> {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) throw new Error("Không phải file.");
  if (stat.size > maxBytes) throw new Error(`File lớn hơn ${formatBytes(maxBytes)}.`);
  return fs.promises.readFile(filePath);
}

export function briefFolder(workDir: string, sessionId: string): string {
  const id = sessionId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80) || "session";
  return path.join(path.resolve(workDir), "briefs", id);
}

export async function saveExact(dir: string, name: string, data: Buffer): Promise<string> {
  const folder = path.resolve(dir);
  await fs.promises.mkdir(folder, { recursive: true });
  const saved = path.join(folder, safeFileName(name));
  await fs.promises.writeFile(saved, data);
  return saved;
}

export async function saveReceivedFile(workDir: string, name: string, data: Buffer): Promise<string> {
  const dir = path.resolve(workDir);
  await fs.promises.mkdir(dir, { recursive: true });
  const safe = safeFileName(name);
  const ext = path.extname(safe);
  const stem = path.basename(safe, ext);
  let saved = path.join(dir, safe);
  for (let n = 2; fs.existsSync(saved) && n < 1000; n += 1) {
    saved = path.join(dir, `${stem}-${n}${ext}`);
  }
  await fs.promises.writeFile(saved, data);
  return saved;
}
