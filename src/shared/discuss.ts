import zlib from "node:zlib";
import { fileExtension } from "./preview";

export type DiscussKind = "text" | "markdown" | "image" | "pdf";

export type DiscussFile = {
  name: string;
  path: string;
  kind: DiscussKind;
  excerpt: string;
  remoteName?: string;
};

const KINDS: Record<string, DiscussKind> = {
  txt: "text",
  md: "markdown",
  markdown: "markdown",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  bmp: "image",
  pdf: "pdf",
};

export const DISCUSS_EXCERPT = 6000;

export function discussKind(name: string): DiscussKind | null {
  return KINDS[fileExtension(name)] ?? null;
}

export function discussExcerpt(name: string, data: Buffer): string {
  const kind = discussKind(name);
  if (kind === "text" || kind === "markdown") return clipText(data.toString("utf8").replace(/^\uFEFF/, ""));
  if (kind === "pdf") return clipText(extractPdfText(data));
  return "";
}

function clipText(value: string): string {
  const clean = value.replace(/\u0000/g, "").trim();
  if (clean.length <= DISCUSS_EXCERPT) return clean;
  return `${clean.slice(0, DISCUSS_EXCERPT)}\n…(còn tiếp trong file)`;
}

export function extractPdfText(data: Buffer): string {
  const source = data.toString("latin1");
  const pieces: string[] = [];
  const streams = /stream\r?\n([\s\S]*?)endstream/g;
  for (const match of source.matchAll(streams)) {
    let bytes = Buffer.from(match[1], "latin1");
    if (bytes[bytes.length - 1] === 0x0a) bytes = bytes.subarray(0, -1);
    if (bytes[bytes.length - 1] === 0x0d) bytes = bytes.subarray(0, -1);
    let text = "";
    try {
      text = zlib.inflateSync(bytes).toString("latin1");
    } catch {
      text = bytes.toString("latin1");
    }
    const pulled = pullPdfText(text);
    if (pulled) pieces.push(pulled);
  }
  const joined = pieces.join("\n").replace(/[^\S\n]+/g, " ").trim();
  const letters = joined.replace(/[^0-9A-Za-zÀ-ỹ]/g, "");
  return letters.length >= 2 ? joined : "";
}

function pullPdfText(content: string): string {
  const parts: string[] = [];
  const pattern = /\[((?:[^[\]]|\\\[|\\\])*)\]\s*TJ|\(((?:\\.|[^\\)])*)\)\s*Tj|<([0-9A-Fa-f\s]+)>\s*Tj/g;
  for (const match of content.matchAll(pattern)) {
    if (match[1] !== undefined) {
      const inner = /<([0-9A-Fa-f\s]+)>|\(((?:\\.|[^\\)])*)\)/g;
      const bits: string[] = [];
      for (const piece of match[1].matchAll(inner)) {
        bits.push(piece[1] !== undefined ? decodePdfHex(piece[1]) : decodePdfLiteral(piece[2] ?? ""));
      }
      if (bits.length) parts.push(bits.join(""));
    } else if (match[2] !== undefined) {
      parts.push(decodePdfLiteral(match[2]));
    } else if (match[3] !== undefined) {
      parts.push(decodePdfHex(match[3]));
    }
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function decodePdfLiteral(value: string): string {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\")
    .replace(/\\([0-7]{1,3})/g, (_item, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function decodePdfHex(value: string): string {
  const hex = value.replace(/\s+/g, "");
  if (!hex || hex.length % 2) return "";
  const bytes = Buffer.from(hex, "hex");
  if (bytes.length >= 4 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.alloc(bytes.length - 2);
    for (let index = 2; index + 1 < bytes.length; index += 2) {
      swapped[index - 2] = bytes[index + 1];
      swapped[index - 1] = bytes[index];
    }
    return swapped.toString("utf16le").replace(/\u0000/g, "");
  }
  return bytes.toString("latin1");
}
