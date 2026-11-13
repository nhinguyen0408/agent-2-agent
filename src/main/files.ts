import fs from "node:fs";
import path from "node:path";
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
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("File phải nằm trong thư mục làm việc.");
  }
  return target;
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
    if (!entry.isFile()) continue;
    const full = path.join(root, entry.name);
    let size = 0;
    try {
      size = (await fs.promises.stat(full)).size;
    } catch {
      continue;
    }
    files.push({ name: entry.name, path: full, preview: previewKind(entry.name), size });
    if (files.length >= 300) break;
  }
  files.sort((a, b) => a.name.localeCompare(b.name, "vi"));
  return { found: true, files };
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
