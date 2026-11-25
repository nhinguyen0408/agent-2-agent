import MarkdownIt from "markdown-it";
import type { FileRef } from "../shared/types";
import { previewKind } from "../shared/preview";

const TEXT_LIMIT = 200_000;

export function renderPreview(file: FileRef): HTMLElement {
  const box = document.createElement("div");
  box.className = `preview preview-${file.preview}`;
  const src = previewSrc(file.path);
  if (file.preview === "image") {
    const img = document.createElement("img");
    img.alt = file.name;
    img.src = src;
    box.append(img);
  } else if (file.preview === "audio") {
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "metadata";
    audio.src = src;
    box.append(audio);
  } else if (file.preview === "video") {
    const video = document.createElement("video");
    video.controls = true;
    video.preload = "metadata";
    video.src = src;
    box.append(video);
  } else if (file.preview === "html") {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "");
    frame.referrerPolicy = "no-referrer";
    frame.title = file.name;
    frame.src = src;
    box.append(frame);
  } else if (file.preview === "text") {
    const pre = document.createElement("pre");
    pre.className = "text-preview";
    pre.textContent = "Đang mở…";
    box.append(pre);
    void fetchText(src)
      .then((text) => {
        pre.textContent = text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}\n…(đã cắt, file dài hơn ${TEXT_LIMIT} ký tự)` : text;
      })
      .catch(() => {
        pre.textContent = "Không xem được nội dung.";
      });
  } else {
    const article = document.createElement("article");
    article.className = "markdown";
    article.textContent = "Đang mở…";
    box.append(article);
    void fetchText(src)
      .then((text) => {
        article.innerHTML = renderMarkdown(text.slice(0, TEXT_LIMIT), file.path);
      })
      .catch(() => {
        article.textContent = "Không xem được nội dung.";
      });
  }
  return box;
}

export function renderMarkdownHtml(source: string): string {
  return renderMarkdown(source, "");
}

export function previewSrc(filePath: string): string {
  return `lan-file://work/?p=${encodeURIComponent(filePath)}`;
}

async function fetchText(src: string): Promise<string> {
  const res = await fetch(src);
  if (!res.ok) throw new Error("no");
  return (await res.text()).replace(/^﻿/, "");
}

// html: false — HTML thô trong Markdown (câu trả lời agent, file máy khác gửi) được hiện thành chữ, không chạy.
// breaks: true — agent thường xuống dòng bằng một Enter, giữ nguyên như khi đọc.
const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false });

let baseFile = "";

md.renderer.rules.image = (tokens, index) => {
  const token = tokens[index];
  const alt = md.utils.escapeHtml(token.content || "");
  const local = resolveRelative(baseFile, token.attrGet("src") ?? "");
  if (!local || previewKind(local) !== "image") return alt;
  return `<img alt="${alt}" src="${md.utils.escapeHtml(previewSrc(local))}">`;
};

md.renderer.rules.link_open = (tokens, index, options, _env, self) => {
  const token = tokens[index];
  const href = token.attrGet("href") ?? "";
  if (/^https?:\/\//i.test(href)) {
    token.attrSet("target", "_blank");
    token.attrSet("rel", "noopener noreferrer");
  } else {
    // Link tương đối hoặc scheme lạ: giữ chữ, bỏ href để không điều hướng cửa sổ app.
    token.attrs = (token.attrs ?? []).filter(([name]) => name !== "href");
    token.attrSet("class", "md-dead-link");
    token.attrSet("title", href);
  }
  return self.renderToken(tokens, index, options);
};

function renderMarkdown(source: string, filePath: string): string {
  baseFile = filePath;
  try {
    return md.render(source);
  } finally {
    baseFile = "";
  }
}

function resolveRelative(base: string, rel: string): string | null {
  if (!base.trim() || /^[a-z]+:/i.test(rel) || rel.startsWith("\\\\") || rel.startsWith("/")) return null;
  const parts = base.replace(/[/\\][^/\\]*$/, "").split(/[/\\]/);
  let decoded = rel;
  try {
    decoded = decodeURI(rel);
  } catch {
    return null;
  }
  for (const bit of decoded.split(/[/\\]/)) {
    if (!bit || bit === ".") continue;
    if (bit === "..") {
      if (parts.length <= 1) return null;
      parts.pop();
      continue;
    }
    parts.push(bit);
  }
  return parts.join("\\");
}
