import fs from "node:fs";
import path from "node:path";

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

export async function readFileLimited(filePath: string, maxBytes: number): Promise<Buffer> {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) throw new Error("Không phải file.");
  if (stat.size > maxBytes) throw new Error(`File lớn hơn ${formatBytes(maxBytes)}.`);
  return fs.promises.readFile(filePath);
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
