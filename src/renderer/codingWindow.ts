import { codingFilePath, mergeCodingStep, type CodingLive, type CodingStep, type CodingViewSnap } from "../shared/codingLive";

const title = document.querySelector<HTMLElement>("#coding-live-title");
const stat = document.querySelector<HTMLElement>("#coding-live-stat");
const stage = document.querySelector<HTMLElement>("#coding-live-stage");
const list = document.querySelector<HTMLElement>("#coding-live-list");
const board = document.querySelector<HTMLElement>("#coding-live");
const copyPath = document.querySelector<HTMLButtonElement>("#coding-copy-path");
if (!title || !stat || !stage || !list || !board || !copyPath) throw new Error("Thiếu khung coding");

const heading = title;
const marks = stat;
const code = stage;
const stepsBox = list;
const root = board;
const copyBtn = copyPath;

let sessionId = "";
let steps: CodingStep[] = [];
let pin = "";
let live = false;
let viewKey = "";
let workDir = "";
const queued: CodingLive[] = [];

function paint(): void {
  const latest = steps[steps.length - 1];
  const focus = steps.find((step) => step.key === pin) ?? latest;
  const busy = live || steps.some((step) => step.status === "run");
  const tail = `${focus?.diff.slice(-48) || ""}:${focus?.code.slice(-48) || ""}:${focus?.output.slice(-48) || ""}`;
  const signature = `${sessionId}:${busy ? 1 : 0}:${focus?.key || ""}:${focus?.status || ""}:${focus?.diff.length || 0}:${focus?.code.length || 0}:${focus?.output.length || 0}:${tail}:${steps.map((step) => `${step.key}:${step.status}:${step.label}`).join("|")}`;
  root.classList.toggle("run", busy);
  syncCopy(focus);
  if (signature === viewKey) return;
  const follow = focus?.status === "run" && code.dataset.key === focus.key && code.scrollHeight - code.scrollTop - code.clientHeight < 36;
  const sameStage = code.dataset.key === (focus?.key || "") && code.dataset.status === (focus?.status || "");
  viewKey = signature;
  heading.textContent = focus?.label || (busy ? "Đang chờ agent đụng vào code" : "Agent đã làm trong code");
  marks.replaceChildren();
  if (focus && (focus.added || focus.removed)) {
    const added = document.createElement("span");
    added.className = "add";
    added.textContent = `+${focus.added}`;
    const removed = document.createElement("span");
    removed.className = "del";
    removed.textContent = `−${focus.removed}`;
    marks.append(added, removed);
  }
  fillStage(focus);
  code.dataset.key = focus?.key || "";
  code.dataset.status = focus?.status || "";
  if (!sameStage) code.scrollTop = 0;
  else if (follow) code.scrollTop = code.scrollHeight;
  const stickList = stepsBox.scrollHeight - stepsBox.scrollTop - stepsBox.clientHeight < 48;
  const listTop = stepsBox.scrollTop;
  stepsBox.hidden = steps.length < 1;
  stepsBox.replaceChildren();
  for (const step of steps) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `coding-row${step.key === focus?.key ? " on" : ""}${step.status === "run" ? " run" : ""}${step.status === "error" ? " bad" : ""}`;
    const name = document.createElement("span");
    name.className = "coding-name";
    const shown = rowTitle(step.label || "Kết quả tool");
    const file = document.createElement("strong");
    file.textContent = shown.title;
    name.append(file);
    if (shown.detail) {
      const detail = document.createElement("small");
      detail.textContent = shown.detail;
      name.append(detail);
    }
    row.append(name);
    if (step.added || step.removed) {
      const pair = document.createElement("span");
      pair.className = "coding-marks";
      const added = document.createElement("span");
      added.className = "add";
      added.textContent = `+${step.added}`;
      const removed = document.createElement("span");
      removed.className = "del";
      removed.textContent = `−${step.removed}`;
      pair.append(added, removed);
      row.append(pair);
    }
    if (step.status === "run" || step.status === "error") {
      const flag = document.createElement("span");
      flag.className = "coding-flag";
      flag.textContent = step.status === "run" ? "đang làm" : "lỗi";
      row.append(flag);
    }
    row.addEventListener("click", () => {
      pin = step.key;
      viewKey = "";
      paint();
    });
    stepsBox.append(row);
  }
  if (stickList) {
    stepsBox.querySelector(".coding-row.on")?.scrollIntoView({ block: "nearest" });
  } else {
    stepsBox.scrollTop = listTop;
  }
}

function rowTitle(label: string): { title: string; detail: string } {
  const text = label.trim() || "Kết quả tool";
  if (/[|;]/.test(text) || /^(npm|pnpm|yarn|npx|git|node|Get-|cd\b)/i.test(text)) return { title: text, detail: "" };
  const match = /^(Đọc|Sửa|Ghi|Tìm|Xóa|Xoá)\s+(.+)$/i.exec(text);
  const verb = match?.[1] ?? "";
  const rest = (match?.[2] ?? text).replace(/\//g, "\\");
  const slash = rest.lastIndexOf("\\");
  if (slash <= 0) return { title: text, detail: "" };
  const file = rest.slice(slash + 1);
  const dir = rest.slice(0, slash);
  return { title: file, detail: verb ? `${verb} · ${dir}` : dir };
}

function syncCopy(step: CodingStep | undefined): void {
  const rel = step ? codingFilePath(step, workDir) : "";
  copyBtn.hidden = !rel;
  copyBtn.dataset.path = rel;
  if (copyBtn.dataset.copied === rel) return;
  copyBtn.classList.remove("on");
  copyBtn.setAttribute("aria-label", "Copy relative path");
}

copyBtn.addEventListener("click", () => {
  const rel = copyBtn.dataset.path || "";
  if (!rel) return;
  void navigator.clipboard.writeText(rel).then(() => {
    copyBtn.dataset.copied = rel;
    copyBtn.classList.add("on");
    copyBtn.setAttribute("aria-label", "Đã chép");
    window.setTimeout(() => {
      if (copyBtn.dataset.copied !== rel) return;
      copyBtn.dataset.copied = "";
      copyBtn.classList.remove("on");
      copyBtn.setAttribute("aria-label", "Copy relative path");
    }, 1200);
  });
});

function applySnap(snap: CodingViewSnap): void {
  sessionId = snap.sessionId;
  steps = Array.isArray(snap.steps) ? snap.steps.slice() : [];
  live = Boolean(snap.live);
  workDir = typeof snap.workDir === "string" ? snap.workDir : workDir;
  pin = "";
  viewKey = "";
  document.title = snap.title ? `Coding · ${snap.title}` : "Coding";
  const pending = queued.splice(0, queued.length).filter((event) => event.sessionId === sessionId);
  for (const event of pending) absorb(event);
  paint();
}

function applyLive(event: CodingLive): void {
  if (!sessionId) {
    queued.push(event);
    return;
  }
  if (event.sessionId !== sessionId) return;
  absorb(event);
  paint();
}

function absorb(event: CodingLive): void {
  if (event.reset) {
    steps = [];
    pin = "";
    live = true;
  }
  if (event.step?.key) {
    const known = steps.some((item) => item.key === event.step?.key);
    if (!known) pin = "";
    const index = steps.findIndex((item) => item.key === event.step?.key);
    const merged = mergeCodingStep(index >= 0 ? steps[index] : undefined, event.step);
    if (index >= 0) steps[index] = merged;
    else steps.push(merged);
    while (steps.length > 40) steps.shift();
    if (event.step.status === "run") live = true;
    else if (!steps.some((step) => step.status === "run")) live = false;
  }
}

function fillStage(step: CodingStep | undefined): void {
  code.classList.toggle("shell", step?.kind === "shell");
  code.replaceChildren();
  if (!step || (!step.diff && !step.code && !step.output && !step.command)) {
    const wait = document.createElement("p");
    wait.className = "coding-live-wait";
    wait.textContent = "Phiên này chưa có bản coding đã lưu. Khi agent đọc, sửa hoặc chạy lệnh, code hiện ở đây.";
    code.append(wait);
    return;
  }
  if (step.kind === "shell" && step.command) {
    const cmd = document.createElement("div");
    cmd.className = "coding-cmd";
    cmd.textContent = `$ ${step.command}`;
    code.append(cmd);
  }
  if (step.diff) appendLines(step.diff, true);
  else if (step.code) appendLines(step.code, false);
  if (step.output && (step.kind === "shell" || step.kind === "search" || step.status === "error" || (!step.diff && !step.code))) {
    appendLines(step.output, false);
  }
}

function appendLines(source: string, diff: boolean): void {
  const box = document.createElement("div");
  box.className = diff ? "coding-diff" : "coding-code";
  for (const line of source.split("\n")) {
    const row = document.createElement("div");
    row.textContent = line || " ";
    if (!diff) row.className = "coding-line";
    else if (line.startsWith("@@")) row.className = "coding-line hunk";
    else if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("\\")) row.className = "coding-line meta";
    else if (line.startsWith("+")) row.className = "coding-line add";
    else if (line.startsWith("-")) row.className = "coding-line del";
    else row.className = "coding-line ctx";
    box.append(row);
  }
  code.append(box);
}

if (window.lan) {
  window.lan.onCodingView(applySnap);
  window.lan.onCodingLive(applyLive);
}
