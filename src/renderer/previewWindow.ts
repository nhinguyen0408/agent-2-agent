import type { FileRef } from "../shared/types";
import { previewSrc, renderMarkdownHtml, renderPreview } from "./previewView";

const stage = document.querySelector<HTMLElement>("#stage");
const bar = document.querySelector<HTMLElement>("#preview-bar");
const name = document.querySelector<HTMLElement>("#preview-name");
const remove = document.querySelector<HTMLButtonElement>("#preview-delete");
if (!stage || !bar || !name || !remove) throw new Error("Thiếu khung xem trước");
const root: HTMLElement = stage;
const toolbar: HTMLElement = bar;
const title: HTMLElement = name;
const drop: HTMLButtonElement = remove;

let refreshTimer = 0;

function paint(file: FileRef): void {
  window.clearInterval(refreshTimer);
  document.title = file.name;
  const log = isCodingLog(file.name);
  toolbar.hidden = !log;
  title.textContent = file.name;
  drop.hidden = !log;
  const view = renderPreview(file);
  view.classList.add("preview-fill");
  root.replaceChildren(view);
  drop.onclick = () => {
    if (!log) return;
    if (!window.confirm("Xóa file log coding này?")) return;
    void window.lan.deleteCodingLog(file.path).then((ok) => {
      if (!ok) return;
      window.clearInterval(refreshTimer);
      toolbar.hidden = true;
      const note = document.createElement("p");
      note.className = "preview-gone";
      note.textContent = "Đã xóa file log.";
      root.replaceChildren(note);
    });
  };
  if (!log) return;
  refreshTimer = window.setInterval(() => {
    void refreshLog(file, view);
  }, 1200);
}

async function refreshLog(file: FileRef, view: HTMLElement): Promise<void> {
  const article = view.querySelector<HTMLElement>("article.markdown");
  if (!article || !article.isConnected) return;
  try {
    const res = await fetch(previewSrc(file.path), { cache: "no-store" });
    if (!res.ok) return;
    const text = await res.text();
    if (article.dataset.raw === text) return;
    const stick = article.scrollHeight - article.scrollTop - article.clientHeight < 48;
    const top = article.scrollTop;
    article.dataset.raw = text;
    article.innerHTML = renderMarkdownHtml(text.slice(0, 200_000));
    article.scrollTop = stick ? article.scrollHeight : top;
  } catch {
    /* file đang được ghi, lần sau đọc lại */
  }
}

function isCodingLog(fileName: string): boolean {
  return /^coding-live-.+\.md$/i.test(fileName);
}

if (window.lan) window.lan.onPreviewFile(paint);
