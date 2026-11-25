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

export const TOPIC_QUEUE_MAX = 20;

export type QueuedTopic = {
  id: string;
  topic: string;
  goal: string;
};

export function sanitizeQueue(input: unknown): QueuedTopic[] {
  const out: QueuedTopic[] = [];
  for (const item of Array.isArray(input) ? input : []) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Partial<QueuedTopic>;
    const id = String(raw.id ?? "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
    const topic = String(raw.topic ?? "").trim().slice(0, BRIEF_TOPIC_CAP);
    if (!id || !topic || out.some((known) => known.id === id)) continue;
    out.push({ id, topic, goal: String(raw.goal ?? "").trim().slice(0, BRIEF_GOAL_CAP) });
    if (out.length >= TOPIC_QUEUE_MAX) break;
  }
  return out;
}

export type RunStatus = "done" | "limit" | "stopped";

export type RunReport = {
  number: number;
  topic: string;
  goal: string;
  coding: boolean;
  status: RunStatus;
  needTurns: number;
  turnsUsed: number;
  turnLimit: number;
  startedAt: string;
  endedAt: string;
  minutes: number;
  agents: string;
  result: string;
  lastReply: string;
  decisions: string;
  next: string;
};

const REPORT_NAME = /^ket-qua-(\d{1,4})\.md$/i;

export function reportFileName(number: number): string {
  return `ket-qua-${String(number).padStart(2, "0")}.md`;
}

export function reportNumber(name: string): number {
  const match = REPORT_NAME.exec(name);
  return match ? Number(match[1]) : 0;
}

export function runStatusText(status: RunStatus, needTurns: number): string {
  if (status === "done") return "Hoàn thành";
  if (status === "limit") return needTurns > 0 ? `Hết lượt, agent ước tính cần thêm ${needTurns} lượt` : "Hết lượt, chưa có KẾT QUẢ";
  return "Đã dừng trước khi có KẾT QUẢ";
}

export function runReportMarkdown(report: RunReport): string {
  const head = [
    `# Báo cáo lần chạy ${String(report.number).padStart(2, "0")}: ${report.topic.replace(/\s+/g, " ")}`,
    "",
    `- **Trạng thái:** ${runStatusText(report.status, report.needTurns)}`,
    `- **Chế độ:** ${report.coding ? "Coding" : "Trao đổi"}`,
    `- **Bắt đầu:** ${report.startedAt}`,
    `- **Kết thúc:** ${report.endedAt} (${report.minutes < 1 ? "dưới 1 phút" : `khoảng ${report.minutes} phút`})`,
    `- **Số lượt agent:** ${report.turnsUsed}/${report.turnLimit}`,
    report.agents ? `- **Agent tham gia:** ${report.agents}` : "",
    report.next ? `- **Hàng đợi:** ${report.next}` : "",
  ].filter((line, index) => index < 2 || line);
  const goal = report.goal.trim() ? ["", "## Kết quả mong muốn", "", report.goal.trim()] : [];
  const body = report.result.trim()
    ? ["", "## Kết quả", "", report.result.trim()]
    : [
        "",
        "## Kết quả",
        "",
        "Lần chạy này chưa có khối KẾT QUẢ.",
        ...(report.lastReply.trim() ? ["", "Câu trả lời cuối của agent:", "", report.lastReply.trim()] : []),
      ];
  const decisions = report.decisions.trim() ? ["", report.decisions.trim()] : [];
  return [...head, ...goal, ...body, ...decisions, ""].join("\n");
}

export const DECISION_MARK = "TỰ CHỐT";
export const DECISION_END = "HẾT TỰ CHỐT";
export const DECISION_HEADING = "Các điểm agent tự chốt";

export type DecisionEntry = {
  who: string;
  text: string;
};

const DECISION_START = /^\s*(?:#{1,6}\s*)?\**\s*TỰ CHỐT\s*:?\s*\**\s*:?\s*$/u;
const DECISION_STOP = /^\s*(?:\**\s*HẾT TỰ CHỐT\s*\**\s*$)/u;
const DECISION_BREAK = /^\s*(?:KẾT QUẢ(?:\s|:|：|\.|$)|CẦN THÊM:)|^#{1,6}\s/u;
const DECISION_MORE = /^(?:\s+\S|\s*[-*+]\s|\s*\d+[.)]\s)/;

export function decisionBlocks(text: string): string[] {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!DECISION_START.test(lines[index] ?? "")) continue;
    const end = decisionEnd(lines, index + 1);
    const body = lines.slice(index + 1, end).join("\n").trim();
    if (body) blocks.push(body.slice(0, 4000));
    index = end - 1;
  }
  return blocks;
}

function decisionEnd(lines: string[], from: number): number {
  for (let index = from; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (DECISION_STOP.test(line)) return index;
    if (DECISION_START.test(line) || DECISION_BREAK.test(line)) break;
  }
  for (let index = from; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (DECISION_STOP.test(line) || DECISION_START.test(line) || DECISION_BREAK.test(line)) return index;
    if (line.trim() || index === from) continue;
    let next = index + 1;
    while (next < lines.length && !(lines[next] ?? "").trim()) next += 1;
    const after = lines[next] ?? "";
    if (next >= lines.length || !DECISION_MORE.test(after) || DECISION_STOP.test(after)) return index;
  }
  return lines.length;
}

export function hasDecisionSection(markdown: string): boolean {
  return /^#{1,6}\s*\**\s*Các điểm (?:agent )?tự chốt/imu.test(markdown);
}

export function decisionSection(entries: DecisionEntry[]): string {
  const head = [
    `## ${DECISION_HEADING}`,
    "",
    "Mục này do app tổng hợp từ các khối TỰ CHỐT trong hội thoại, vì file kết quả chưa có mục này. Chế độ coding không dừng lại hỏi người, nên agent tự quyết các điểm dưới đây. Người cần xem lại trước khi dùng kết quả.",
  ];
  if (!entries.length) return [...head, "", "Agent không ghi lại điểm phân vân nào trong lúc làm."].join("\n");
  const items = entries.map((entry, index) => [`### ${index + 1}. ${entry.who}`, "", entry.text].join("\n"));
  return [...head, "", ...items.flatMap((item) => [item, ""])].join("\n").trimEnd();
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
