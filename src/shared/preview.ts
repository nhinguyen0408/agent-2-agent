export type PreviewKind = "image" | "html" | "markdown" | "audio" | "video";

export type FileRef = {
  name: string;
  path: string;
  preview: PreviewKind;
};

export type WorkFile = {
  name: string;
  path: string;
  preview: PreviewKind | null;
  size: number;
};

const KINDS: Record<string, PreviewKind> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  bmp: "image",
  svg: "image",
  html: "html",
  htm: "html",
  md: "markdown",
  markdown: "markdown",
  mp3: "audio",
  wav: "audio",
  ogg: "audio",
  m4a: "audio",
  flac: "audio",
  mp4: "video",
  webm: "video",
  mov: "video",
  ogv: "video",
};

const MIMES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  flac: "audio/flac",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  ogv: "video/ogg",
};

export function fileExtension(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  if (dot < 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

export function previewKind(name: string): PreviewKind | null {
  return KINDS[fileExtension(name)] ?? null;
}

export function previewMime(name: string): string {
  return MIMES[fileExtension(name)] ?? "application/octet-stream";
}

export function fileRef(filePath: string): FileRef | null {
  const preview = previewKind(filePath);
  if (!preview) return null;
  const name = filePath.split(/[/\\]/).pop() || "file";
  return { name, path: filePath, preview };
}
