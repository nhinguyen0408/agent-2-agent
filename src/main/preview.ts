import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { protocol } from "electron";
import { previewKind, previewMime } from "../shared/preview";

const allowed = new Set<string>();

export function registerPreviewScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "lan-file",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true,
      },
    },
  ]);
}

export function allowPreview(filePath: string): void {
  allowed.add(path.resolve(filePath).toLowerCase());
}

export function attachPreviewProtocol(workDir: () => string): void {
  protocol.handle("lan-file", (request) => servePreview(request, workDir()));
}

function servePreview(request: Request, workDir: string): Response {
  let filePath = "";
  try {
    filePath = new URL(request.url).searchParams.get("p") ?? "";
  } catch {
    return new Response("Đường dẫn không hợp lệ", { status: 400 });
  }
  const resolved = path.resolve(filePath);
  if (!canPreview(resolved, workDir)) return new Response("Không xem được file này", { status: 403 });
  const stat = fs.statSync(resolved);
  const mime = previewMime(resolved);
  const range = request.headers.get("range");
  if (range) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (!match) return new Response("Vùng không hợp lệ", { status: 416 });
    const start = Number(match[1]);
    const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : Math.min(start + 1024 * 1024 - 1, stat.size - 1);
    if (start >= stat.size || start > end) {
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${stat.size}` } });
    }
    return new Response(webStream(resolved, start, end), {
      status: 206,
      headers: {
        "content-type": mime,
        "content-length": String(end - start + 1),
        "content-range": `bytes ${start}-${end}/${stat.size}`,
        "accept-ranges": "bytes",
      },
    });
  }
  return new Response(webStream(resolved), {
    status: 200,
    headers: {
      "content-type": mime,
      "content-length": String(stat.size),
      "accept-ranges": "bytes",
    },
  });
}

function webStream(filePath: string, start?: number, end?: number): ReadableStream {
  const node = fs.createReadStream(filePath, start === undefined ? undefined : { start, end });
  return Readable.toWeb(node) as ReadableStream;
}

function canPreview(resolved: string, workDir: string): boolean {
  if (!previewKind(resolved)) return false;
  try {
    if (!fs.statSync(resolved).isFile()) return false;
  } catch {
    return false;
  }
  if (insideWork(resolved, workDir) || allowed.has(resolved.toLowerCase())) return true;
  if (previewKind(resolved) !== "image") return false;
  const dir = path.dirname(resolved).toLowerCase();
  for (const item of allowed) {
    if (path.dirname(item).toLowerCase() === dir) return true;
  }
  return false;
}

function insideWork(resolved: string, workDir: string): boolean {
  if (!workDir.trim()) return false;
  const rel = path.relative(path.resolve(workDir), resolved);
  return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
}
