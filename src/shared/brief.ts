const BRIEF_KINDS = ["text", "markdown", "image", "pdf", "document", "sheet"] as const;

export type BriefKind = (typeof BRIEF_KINDS)[number];

export const BRIEF_TURN_MIN = 1;
export const BRIEF_TURN_MAX = 50;
export const BRIEF_TURN_HARD = 50;
export const CODING_TURN_DEFAULT = 50;
export const CODING_TURN_MAX = 200;
export const CODING_RESULT_FILE = "ket-qua.md";
export const BRIEF_FILE_MAX = 8;
export const BRIEF_TOPIC_CAP = 500;
export const BRIEF_GOAL_CAP = 2000;
export const BRIEF_EXTEND = 4;

export type BriefFile = {
  name: string;
  kind: BriefKind;
  excerpt: string;
  path?: string;
};

export type ProjectBrief = {
  topic: string;
  goal: string;
  turnLimit: number;
  turnsUsed: number;
  running: boolean;
  coding: boolean;
  needTurns: number;
  codingSince: number;
  files: BriefFile[];
};

export function emptyBrief(): ProjectBrief {
  return { topic: "", goal: "", turnLimit: 6, turnsUsed: 0, running: false, coding: false, needTurns: 0, codingSince: 0, files: [] };
}

export function briefCap(coding: boolean): number {
  return coding ? CODING_TURN_MAX : BRIEF_TURN_MAX;
}

export function clampTurnLimit(value: number, hard = BRIEF_TURN_MAX): number {
  const rounded = Math.round(Number(value));
  if (!Number.isFinite(rounded)) return 6;
  return Math.max(BRIEF_TURN_MIN, Math.min(hard, rounded));
}

export function sanitizeBrief(input: Partial<ProjectBrief> | null | undefined): ProjectBrief {
  const files: BriefFile[] = [];
  for (const item of Array.isArray(input?.files) ? input.files : []) {
    const file = sanitizeBriefFile(item);
    if (!file || files.some((known) => known.name === file.name)) continue;
    files.push(file);
    if (files.length >= BRIEF_FILE_MAX) break;
  }
  const coding = Boolean(input?.coding);
  const cap = briefCap(coding);
  const need = Math.round(Number(input?.needTurns) || 0);
  return {
    topic: String(input?.topic ?? "").trim().slice(0, BRIEF_TOPIC_CAP),
    goal: String(input?.goal ?? "").trim().slice(0, BRIEF_GOAL_CAP),
    turnLimit: clampTurnLimit(Number(input?.turnLimit ?? (coding ? CODING_TURN_DEFAULT : 6)), cap),
    turnsUsed: Math.max(0, Math.min(cap, Math.round(Number(input?.turnsUsed) || 0))),
    running: Boolean(input?.running),
    coding,
    needTurns: coding ? Math.max(0, Math.min(CODING_TURN_MAX, Number.isFinite(need) ? need : 0)) : 0,
    codingSince: coding ? Math.max(0, Math.round(Number(input?.codingSince) || 0)) : 0,
    files,
  };
}

export function resultText(text: string): string {
  const match = /(?:^|\n)\s*KẾT QUẢ(?:\s|:|：|\.|$)/u.exec(text);
  if (!match || match.index === undefined) return "";
  const start = text.indexOf("KẾT QUẢ", match.index);
  return start < 0 ? "" : text.slice(start).trim();
}

export function codingNeed(text: string): number {
  const match = /(?:^|\n)\s*CẦN THÊM:\s*(\d{1,3})/u.exec(text);
  if (!match) return 0;
  const count = Math.round(Number(match[1]));
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.min(CODING_TURN_MAX, count);
}

function sanitizeBriefFile(input: unknown): BriefFile | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Partial<BriefFile>;
  const name = cleanBriefName(String(raw.name ?? ""));
  if (!name || !isBriefKind(raw.kind)) return null;
  return { name, kind: raw.kind, excerpt: String(raw.excerpt ?? "").slice(0, 12_000) };
}

function isBriefKind(value: unknown): value is BriefKind {
  return typeof value === "string" && (BRIEF_KINDS as readonly string[]).includes(value);
}

function cleanBriefName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name;
  return base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim().replace(/^\.+/, "").slice(0, 120);
}
