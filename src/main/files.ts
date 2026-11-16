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

const PROJECT_SKILL_DIRS = [
  ".claude/skills",
  ".cursor/skills",
  ".agents/skills",
  ".codex/skills",
  ".gemini/skills",
  ".github/skills",
  "skills",
];
const SKILL_SKIP = new Set(["node_modules", ".git", "dist", "release", "out", "build", "coverage", ".next", ".turbo"]);
const SKILL_DEPTH = 6;
const SKILL_VISITS = 400;
const SKILL_CAP = 24;
const CATALOG_BUDGET = 1600;

export type SkillHit = { name: string; description: string; file: string };

export function projectSkillRoots(workDir: string, configuredDir: string): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  const add = (dir: string) => {
    const trimmed = dir.trim();
    if (!trimmed) return;
    let resolved = "";
    try {
      if (!fs.statSync(trimmed).isDirectory()) return;
      resolved = fs.realpathSync(path.resolve(trimmed));
    } catch {
      return;
    }
    const key = dirKey(resolved);
    if (seen.has(key)) return;
    seen.add(key);
    roots.push(resolved);
  };
  const work = workDir.trim();
  if (work) {
    for (const rel of PROJECT_SKILL_DIRS) add(path.join(work, rel));
  }
  add(configuredDir);
  return roots;
}

export function skillIndex(dir: string): string {
  return skillCatalog(dir.trim() ? [dir] : []);
}

export function skillCatalog(roots: string[]): string {
  const hits = collectSkills(roots);
  if (!hits.length) return "";
  const lines: string[] = [];
  let used = 0;
  for (const hit of hits) {
    const line = `- ${hit.name}: ${hit.description} | ${hit.file}`;
    const room = CATALOG_BUDGET - used - (lines.length ? 1 : 0);
    if (room < 40) break;
    const fitted = line.length <= room ? line : `${line.slice(0, room - 1)}…`;
    lines.push(fitted);
    used += fitted.length + 1;
    if (fitted !== line) break;
  }
  const hidden = hits.length - lines.length;
  if (hidden > 0 && CATALOG_BUDGET - used > 40) {
    lines.push(`- … còn ${hidden} skill trong các thư mục skill. Liệt kê thư mục nếu việc cần skill chưa có ở trên.`);
  }
  return lines.join("\n");
}

function collectSkills(roots: string[]): SkillHit[] {
  const hits: SkillHit[] = [];
  const seenFiles = new Set<string>();
  const seenDirs = new Set<string>();
  for (const root of roots) {
    walkSkills(root, 0, hits, seenFiles, seenDirs, { visits: 0 });
    if (hits.length >= SKILL_CAP) break;
  }
  hits.sort((a, b) => a.name.localeCompare(b.name, "vi") || a.file.localeCompare(b.file, "vi"));
  return hits.slice(0, SKILL_CAP);
}

function walkSkills(
  dir: string,
  depth: number,
  hits: SkillHit[],
  seenFiles: Set<string>,
  seenDirs: Set<string>,
  state: { visits: number },
): void {
  if (depth > SKILL_DEPTH || state.visits >= SKILL_VISITS || hits.length >= SKILL_CAP) return;
  let resolved = dir;
  try {
    resolved = fs.realpathSync(dir);
  } catch {
    return;
  }
  const key = dirKey(resolved);
  if (seenDirs.has(key)) return;
  seenDirs.add(key);
  state.visits += 1;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(resolved, { withFileTypes: true });
  } catch {
    return;
  }
  const preferred = ["skill.md", "agents.md"]
    .map((wanted) => entries.find((entry) => entry.isFile() && entry.name.toLowerCase() === wanted)?.name)
    .find((name): name is string => Boolean(name));
  if (preferred) {
    const file = path.join(resolved, preferred);
    const fileKey = dirKey(file);
    if (!seenFiles.has(fileKey)) {
      seenFiles.add(fileKey);
      hits.push(readSkill(file, path.basename(resolved)));
    }
  }
  if (depth === SKILL_DEPTH) return;
  const folders = entries
    .filter((entry) => entry.isDirectory() && !SKILL_SKIP.has(entry.name.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name, "vi"));
  for (const folder of folders) {
    walkSkills(path.join(resolved, folder.name), depth + 1, hits, seenFiles, seenDirs, state);
  }
}

function readSkill(file: string, folderName: string): SkillHit {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8").slice(0, 8000);
  } catch {
    return { name: clipMeta(folderName, 48), description: "Chưa đọc được mô tả.", file };
  }
  const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const name = clipMeta(yamlField(front?.[1] ?? "", "name") || folderName, 48);
  let description = yamlField(front?.[1] ?? "", "description");
  if (!description) description = firstUsefulLine(front ? text.slice(front[0].length) : text);
  if (!description) description = "Không có mô tả. Đọc file trước khi dùng.";
  return { name, description: clipMeta(description, 110), file };
}

function yamlField(block: string, key: string): string {
  if (!block) return "";
  const lines = block.split(/\r?\n/);
  const pattern = new RegExp(`^${key}:\\s*(.*)$`, "i");
  for (let index = 0; index < lines.length; index += 1) {
    const match = pattern.exec(lines[index]);
    if (!match) continue;
    const raw = match[1].trim();
    if (raw === ">" || raw === "|" || raw === ">-" || raw === "|-" || raw === "") {
      const folded: string[] = [];
      for (let next = index + 1; next < lines.length; next += 1) {
        if (/^\s+\S/.test(lines[next])) {
          folded.push(lines[next].trim());
          continue;
        }
        if (!lines[next].trim() && folded.length) break;
        if (!lines[next].trim()) continue;
        break;
      }
      return folded.join(" ");
    }
    return unquote(raw);
  }
  return "";
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function firstUsefulLine(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const clean = line.replace(/^#+\s*/, "").trim();
    if (!clean || clean === "---" || /^[-|:>]+$/.test(clean)) continue;
    return clean;
  }
  return "";
}

function clipMeta(value: string, max: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function dirKey(file: string): string {
  const full = path.resolve(file);
  return process.platform === "win32" ? full.toLowerCase() : full;
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
