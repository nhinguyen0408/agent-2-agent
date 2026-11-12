import type { FileRef } from "../shared/types";
import { renderPreview } from "./previewView";

const stage = document.querySelector<HTMLElement>("#stage");
if (!stage) throw new Error("Thiếu #stage");
const root: HTMLElement = stage;

function paint(file: FileRef): void {
  document.title = file.name;
  const view = renderPreview(file);
  view.classList.add("preview-fill");
  root.replaceChildren(view);
}

if (window.lan) window.lan.onPreviewFile(paint);
