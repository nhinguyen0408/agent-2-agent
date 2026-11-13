import type { FileRef } from "../shared/types";
import { previewKind } from "../shared/preview";

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
  } else {
    const article = document.createElement("article");
    article.className = "markdown";
    article.textContent = "Đang mở…";
    box.append(article);
    void fetch(src)
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error("no"))))
      .then((text) => {
        article.innerHTML = renderMarkdown(text.slice(0, 200_000), file.path);
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

function renderMarkdown(source: string, filePath: string): string {
  const fences: string[] = [];
  const text = escapeHtml(source).replace(/```([\s\S]*?)```/g, (_match, code: string) => {
    const html = `<pre><code>${code}</code></pre>`;
    fences.push(html);
    return `\u0000${fences.length - 1}\u0000`;
  });
  return text
    .split(/\n{2,}/)
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return "";
      const fence = /^\u0000(\d+)\u0000$/.exec(trimmed);
      if (fence) return fences[Number(fence[1])] ?? "";
      const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed);
      if (heading) {
        const level = heading[1].length;
        return `<h${level}>${inlineMarkdown(heading[2], filePath)}</h${level}>`;
      }
      if (/^(?:[-*] |\d+\. )/m.test(trimmed)) {
        const items = trimmed
          .split("\n")
          .map((item) => `<li>${inlineMarkdown(item.replace(/^(?:[-*] |\d+\. )/, ""), filePath)}</li>`)
          .join("");
        return `<ul>${items}</ul>`;
      }
      if (/^&gt; /m.test(trimmed)) {
        return `<blockquote>${inlineMarkdown(trimmed.replace(/^&gt; /gm, ""), filePath)}</blockquote>`;
      }
      return `<p>${inlineMarkdown(trimmed, filePath).replace(/\n/g, "<br>")}</p>`;
    })
    .join("");
}

function inlineMarkdown(value: string, filePath: string): string {
  return value
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt: string, src: string) => {
      const local = resolveRelative(filePath, src);
      if (!local || previewKind(local) !== "image") return alt;
      return `<img alt="${alt}" src="${previewSrc(local)}">`;
    })
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

function resolveRelative(baseFile: string, rel: string): string | null {
  if (!baseFile.trim() || /^[a-z]+:/i.test(rel) || rel.startsWith("\\\\") || rel.startsWith("/")) return null;
  const parts = baseFile.replace(/[/\\][^/\\]*$/, "").split(/[/\\]/);
  for (const bit of rel.split(/[/\\]/)) {
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

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
