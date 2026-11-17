export type CodingKind = "edit" | "shell" | "read" | "search" | "delete";

export type CodingStep = {
  key: string;
  kind: CodingKind | "";
  status: "run" | "done" | "error";
  label: string;
  path: string;
  command: string;
  diff: string;
  code: string;
  output: string;
  added: number;
  removed: number;
};

export type CodingLive = {
  sessionId: string;
  reset?: boolean;
  step?: CodingStep;
};

export type CodingViewSnap = {
  sessionId: string;
  title: string;
  steps: CodingStep[];
  live: boolean;
  workDir?: string;
};

export function codingFilePath(step: Pick<CodingStep, "path" | "label" | "kind">, workDir = ""): string {
  if (step.kind === "shell" || step.kind === "search") return "";
  const raw = (step.path || pathAfterVerb(step.label)).trim();
  if (!raw || /[*?]/.test(raw)) return "";
  const slash = raw.replace(/\\/g, "/");
  const root = workDir.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (root) {
    const full = slash.toLowerCase();
    const base = root.toLowerCase();
    if (full === base) return "";
    if (full.startsWith(`${base}/`)) return slash.slice(root.length + 1);
  }
  if (/^[a-zA-Z]:\//.test(slash) || slash.startsWith("/")) return "";
  return slash.replace(/^\.\//, "");
}

function pathAfterVerb(label: string): string {
  const match = /^(?:Đọc|Sửa|Ghi|Xóa|Xoá)\s+(.+)$/i.exec(label.trim());
  return match?.[1]?.trim() ?? "";
}

export function mergeCodingStep(prev: CodingStep | undefined, next: CodingStep): CodingStep {
  if (!prev) return next;
  const longer = (current: string, incoming: string) => {
    if (!incoming) return current;
    if (!current || incoming.length >= current.length) return incoming;
    return current;
  };
  const diff = next.diff || prev.diff;
  return {
    key: next.key,
    kind: next.kind || prev.kind,
    status: next.status === "run" && prev.status !== "run" ? prev.status : next.status,
    label: next.label || prev.label,
    path: next.path || prev.path,
    command: longer(prev.command, next.command),
    diff,
    code: diff ? prev.code : longer(prev.code, next.code),
    output: longer(prev.output, next.output),
    added: next.diff ? next.added : next.added || prev.added,
    removed: next.diff ? next.removed : next.removed || prev.removed,
  };
}

const PATH_KEYS = ["path", "file_path", "filePath", "target_file", "target_notebook", "uri", "file"];
const COMMAND_KEYS = ["command", "cmd", "script"];
const OLD_KEYS = ["old_string", "oldString", "old_str"];
const NEW_KEYS = ["new_string", "newString", "new_str", "replacement"];
const WRITE_KEYS = ["streamContent", "contents", "content", "fileText", "file_text", "file_content", "fileContent"];
const DIFF_KEYS = ["diffString", "diff_string", "diff", "patch", "unified_diff", "unifiedDiff"];
const OUTPUT_KEYS = ["stdout", "output", "aggregated_output", "aggregatedOutput", "interleavedOutput"];
const QUERY_KEYS = ["pattern", "query", "search_term", "searchTerm", "glob", "regex"];

export function codingSteps(event: unknown): CodingStep[] {
  if (!event || typeof event !== "object") return [];
  const record = event as Record<string, unknown>;
  const type = text(record.type);
  if (!type || type === "stream_event" || type === "result" || type === "system") return [];
  if (type === "tool_call" && record.tool_call && typeof record.tool_call === "object") return cursorTools(record);
  if ((type === "tool_call" || type === "tool_use") && (record.tool_name || record.name)) return namedCall(record);
  if (type === "tool_result") return toolResult(record);
  if (type === "assistant" || type === "user" || type === "message") return messageTools(record);
  if (type === "item.started" || type === "item.completed" || type === "item.updated") return codexItem(record, type);
  return [];
}

export function diffCounts(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

export function unifiedDiff(before: string, after: string): string {
  if (before === after) return "";
  if (!before) return marked(after, "+");
  if (!after) return marked(before, "-");
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length > 320 || b.length > 320) return coarse(a, b);
  return formatHunks(diffOps(a, b));
}

function cursorTools(record: Record<string, unknown>): CodingStep[] {
  const subtype = text(record.subtype);
  let status: CodingStep["status"] = subtype === "completed" ? "done" : "run";
  if (subtype === "error" || subtype === "failed") status = "error";
  const callId = text(record.call_id || record.tool_call_id || record.id);
  const tool = asRecord(record.tool_call);
  const entries = Object.entries(tool).filter(([, value]) => value && typeof value === "object");
  const steps: CodingStep[] = [];
  for (const [name, value] of entries) {
    const body = asRecord(value);
    const key = callId ? (entries.length > 1 ? `${callId}:${name}` : callId) : "";
    const step = build(name, asRecord(body.args ?? body.input ?? body.parameters), body, key, status);
    if (step) steps.push(step);
  }
  return steps;
}

function namedCall(record: Record<string, unknown>): CodingStep[] {
  const name = text(record.tool_name || record.name);
  const args = asArgs(record.parameters ?? record.input ?? record.args ?? record.arguments);
  const key = text(record.tool_id || record.tool_use_id || record.id || record.call_id);
  const subtype = text(record.subtype);
  const status: CodingStep["status"] = subtype === "completed" ? "done" : "run";
  const step = build(name, args, record, key, status);
  return step ? [step] : [];
}

function toolResult(record: Record<string, unknown>): CodingStep[] {
  const key = text(record.tool_use_id || record.tool_id || record.call_id || record.id);
  if (!key) return [];
  const failed = Boolean(record.is_error || record.isError || text(record.status) === "error");
  const output = clip(textOf(record.content ?? record.output ?? record.result ?? record.error), 10_000);
  if (!output) return [];
  return [blank(key, failed ? "error" : "done", output)];
}

function messageTools(record: Record<string, unknown>): CodingStep[] {
  const message = asRecord(record.message);
  const content = Array.isArray(record.content) ? record.content : Array.isArray(message.content) ? message.content : [];
  const steps: CodingStep[] = [];
  for (const block of content) {
    const item = asRecord(block);
    if (text(item.type) === "tool_use") {
      const step = build(text(item.name), asArgs(item.input), item, text(item.id), "run");
      if (step) steps.push(step);
    } else if (text(item.type) === "tool_result") {
      steps.push(...toolResult(item));
    } else {
      const call = asRecord(item.functionCall ?? item.function_call);
      const name = text(call.name);
      if (!name) continue;
      const step = build(name, asArgs(call.args ?? call.arguments), item, text(call.id), "run");
      if (step) steps.push(step);
    }
  }
  return steps;
}

function codexItem(record: Record<string, unknown>, type: string): CodingStep[] {
  const item = asRecord(record.item);
  const itemType = text(item.type);
  if (!itemType || itemType === "agent_message" || itemType === "reasoning") return [];
  const status = codexStatus(type, item);
  const itemId = text(item.id);
  if (itemType === "command_execution") {
    const step = build("shell", item, item, itemId, status);
    return step ? [step] : [];
  }
  if (itemType === "file_change") {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    if (!changes.length) {
      const step = build("edit", item, item, itemId, status);
      return step ? [step] : [];
    }
    const steps: CodingStep[] = [];
    for (const change of changes) {
      const body = asRecord(change);
      const key = changes.length === 1 ? itemId : `${itemId}:${textOf(body.path) || steps.length}`;
      const name = text(body.kind || body.type) === "delete" ? "delete" : "edit";
      const step = build(name, body, body, key, status);
      if (step) steps.push(step);
    }
    return steps;
  }
  if (itemType === "mcp_tool_call") {
    const step = build(text(item.name || item.tool || "mcp"), asArgs(item.arguments ?? item.args), item, itemId, status);
    return step ? [step] : [];
  }
  return [];
}

function build(name: string, args: Record<string, unknown>, body: Record<string, unknown>, key: string, status: CodingStep["status"]): CodingStep | null {
  const outcome = readOutcome(body);
  const sources = [outcome.data, args, body];
  let kind = kindOf(name);
  const filePath = pick(sources, PATH_KEYS);
  const command = pick(sources, COMMAND_KEYS);
  const query = pick(sources, QUERY_KEYS);
  if (!kind && command) kind = "shell";
  if (!kind && (pick(sources, DIFF_KEYS) || pick(sources, OLD_KEYS) || pick(sources, NEW_KEYS))) kind = "edit";
  if (!kind && filePath && !command) kind = "read";
  if (!kind && !filePath && !command && !query) return null;

  const explicit = pick(sources, DIFF_KEYS);
  const oldText = pick([args], OLD_KEYS);
  const newText = pick([args], NEW_KEYS);
  const written = pick([args, outcome.data], WRITE_KEYS);
  const edits = editsDiff(args.edits ?? args.changes);
  let diff = edits || (explicit && (looksLikeDiff(explicit) || kind === "edit" || kind === "delete") ? explicit : "");
  if (!diff && kind !== "shell" && kind !== "search" && kind !== "read" && (oldText || newText)) {
    diff = status === "run" && !oldText ? "" : unifiedDiff(oldText, newText);
  }
  if (!diff && (kind === "edit" || kind === "delete") && written && status !== "run") {
    diff = kind === "delete" ? unifiedDiff(written, "") : unifiedDiff("", written);
  }

  let code = "";
  if (!diff && kind === "read") code = written || pick(sources, ["text"]);
  else if (!diff && status === "run" && kind !== "shell" && kind !== "search") code = written || newText;

  let output = "";
  if (kind === "shell" || kind === "search" || kind === "") {
    const stdout = pick(sources, OUTPUT_KEYS);
    const stderr = pick(sources, ["stderr"]);
    output = [stdout, stderr && stderr !== stdout ? stderr : "", !stdout && kind === "shell" ? written : ""].filter(Boolean).join("\n");
  }
  if (outcome.failed) {
    status = "error";
    output = [outcome.message, output].filter(Boolean).join("\n");
  }
  const exitRaw = outcome.data.exitCode ?? outcome.data.exit_code ?? args.exitCode ?? args.exit_code;
  if (status === "done" && exitRaw !== undefined && Number(exitRaw) !== 0) status = "error";

  const counts = diffCounts(diff);
  const added = numberOf(outcome.data.linesAdded ?? outcome.data.lines_added) || counts.added;
  const removed = numberOf(outcome.data.linesRemoved ?? outcome.data.lines_removed) || counts.removed;
  const step: CodingStep = {
    key: (key || `${kind}:${filePath}:${command || query}`).slice(0, 180),
    kind,
    status,
    label: labelFor(kind, filePath, command, query, name),
    path: filePath,
    command: clip(command, 4_000),
    diff: clip(diff, 14_000),
    code: clip(code, 14_000),
    output: clip(output, 10_000),
    added,
    removed,
  };
  if (!step.path && !step.command && !step.diff && !step.code && !step.output) return null;
  return step;
}

function blank(key: string, status: CodingStep["status"], output: string): CodingStep {
  return { key, kind: "", status, label: "", path: "", command: "", diff: "", code: "", output, added: 0, removed: 0 };
}

function readOutcome(body: Record<string, unknown>): { data: Record<string, unknown>; failed: boolean; message: string } {
  if (typeof body.result === "string") return { data: { output: body.result }, failed: false, message: "" };
  const result = asRecord(body.result);
  const success = asRecord(result.success);
  const error = result.error ?? result.failure ?? body.error;
  if (error !== undefined && !Object.keys(success).length) {
    const message = textOf(error);
    return { data: { ...result, ...asRecord(error), output: message }, failed: true, message: message || "Tool lỗi" };
  }
  return { data: Object.keys(success).length ? { ...result, ...success } : result, failed: false, message: "" };
}

function kindOf(name: string): CodingKind | "" {
  const value = name.toLowerCase();
  if (!value) return "";
  if (/shell|bash|powershell|command|terminal/.test(value)) return "shell";
  if (/delete|remove_file/.test(value)) return "delete";
  if (/search_replace|str_replace|strreplace|multiedit|edit|write|patch|apply|notebook|replace/.test(value)) return "edit";
  if (/grep|glob|semantic|search|find/.test(value)) return "search";
  if (/read/.test(value)) return "read";
  return "";
}

function labelFor(kind: CodingKind | "", filePath: string, command: string, query: string, name: string): string {
  if (kind === "shell") return one(command) || "Lệnh";
  if (kind === "search") return query ? `Tìm ${one(query)}` : filePath ? `Tìm trong ${filePath}` : "Tìm";
  if (kind === "read") return filePath ? `Đọc ${filePath}` : "Đọc file";
  if (kind === "delete") return filePath ? `Xóa ${filePath}` : "Xóa file";
  if (kind === "edit") return filePath ? `Sửa ${filePath}` : "Sửa file";
  return one(name) || "Tool";
}

function editsDiff(value: unknown): string {
  if (!Array.isArray(value)) return "";
  const parts: string[] = [];
  for (const item of value) {
    const record = asRecord(item);
    const explicit = pick([record], DIFF_KEYS);
    if (explicit) {
      parts.push(explicit);
      continue;
    }
    const oldText = pick([record], OLD_KEYS);
    const newText = pick([record], NEW_KEYS);
    if (oldText || newText) {
      const diff = unifiedDiff(oldText, newText);
      if (diff) parts.push(diff);
    }
  }
  return parts.join("\n");
}

function codexStatus(type: string, item: Record<string, unknown>): CodingStep["status"] {
  const status = text(item.status).toLowerCase();
  if (status === "failed" || status === "error" || item.error) return "error";
  if (type === "item.completed" || status === "completed" || status === "success") return "done";
  return "run";
}

function looksLikeDiff(value: string): boolean {
  return /^(?:diff |--- |\+\+\+ |@@ )/m.test(value);
}

type Op = { type: "eq" | "del" | "ins"; line: string };

function diffOps(before: string[], after: string[]): Op[] {
  const width = after.length + 1;
  const dp = new Uint32Array((before.length + 1) * width);
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      dp[i * width + j] = before[i] === after[j] ? dp[(i + 1) * width + j + 1] + 1 : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      ops.push({ type: "eq", line: before[i] });
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      ops.push({ type: "del", line: before[i] });
      i += 1;
    } else {
      ops.push({ type: "ins", line: after[j] });
      j += 1;
    }
  }
  while (i < before.length) ops.push({ type: "del", line: before[i++] });
  while (j < after.length) ops.push({ type: "ins", line: after[j++] });
  return ops;
}

function formatHunks(ops: Op[]): string {
  const out: string[] = [];
  const context = 3;
  let index = 0;
  while (index < ops.length) {
    if (ops[index].type === "eq") {
      index += 1;
      continue;
    }
    const from = Math.max(0, index - context);
    let to = index;
    while (to < ops.length) {
      if (ops[to].type !== "eq") {
        to += 1;
        continue;
      }
      let gap = 0;
      while (to + gap < ops.length && ops[to + gap].type === "eq") gap += 1;
      if (gap > context * 2 || to + gap >= ops.length) {
        to = Math.min(ops.length, to + context);
        break;
      }
      to += gap;
    }
    const start = lineStart(ops, from);
    let oldCount = 0;
    let newCount = 0;
    const body: string[] = [];
    for (let cursor = from; cursor < to; cursor += 1) {
      const op = ops[cursor];
      if (op.type === "eq") {
        oldCount += 1;
        newCount += 1;
        body.push(` ${op.line}`);
      } else if (op.type === "del") {
        oldCount += 1;
        body.push(`-${op.line}`);
      } else {
        newCount += 1;
        body.push(`+${op.line}`);
      }
    }
    out.push(`@@ -${start.old},${oldCount} +${start.new},${newCount} @@`);
    out.push(...body);
    index = Math.max(to, index + 1);
  }
  return out.join("\n");
}

function lineStart(ops: Op[], from: number): { old: number; new: number } {
  let oldLine = 1;
  let newLine = 1;
  for (let i = 0; i < from; i += 1) {
    if (ops[i].type !== "ins") oldLine += 1;
    if (ops[i].type !== "del") newLine += 1;
  }
  return { old: oldLine, new: newLine };
}

function coarse(before: string[], after: string[]): string {
  const out = ["@@ diff dài, chỉ hiện một phần @@"];
  for (const line of before.slice(0, 40)) out.push(`-${line}`);
  if (before.length > 40) out.push(`-… ${before.length - 40} dòng cũ nữa`);
  for (const line of after.slice(0, 40)) out.push(`+${line}`);
  if (after.length > 40) out.push(`+… ${after.length - 40} dòng mới nữa`);
  return out.join("\n");
}

function marked(value: string, mark: "+" | "-"): string {
  const lines = value.split("\n");
  const shown = lines.slice(0, 220).map((line) => `${mark}${line}`);
  if (lines.length > 220) shown.push(`${mark}… ${lines.length - 220} dòng nữa`);
  return shown.join("\n");
}

function pick(records: Record<string, unknown>[], keys: string[]): string {
  for (const record of records) {
    for (const key of keys) {
      const value = textOf(record[key]);
      if (value) return value;
    }
  }
  return "";
}

function asArgs(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value) as unknown);
    } catch {
      return {};
    }
  }
  return asRecord(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((item) => textOf(item)).filter(Boolean).join("\n");
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if (typeof record.content === "string") return record.content;
    if (typeof record.message === "string") return record.message;
  }
  return "";
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberOf(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.round(parsed);
}

function one(value: string): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > 180 ? `${clean.slice(0, 179)}…` : clean;
}

function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n… đã cắt bớt`;
}

export function parseCodingLog(source: string): CodingStep[] {
  const lines = source.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").split("\n");
  const chunks: { label: string; body: string[] }[] = [];
  let current: { label: string; body: string[] } | null = null;
  let fence = "";
  for (const line of lines) {
    if (!fence) {
      const open = /^(`{3,})(.*)$/.exec(line);
      if (open) fence = open[1];
    } else if (line.trim() === fence) {
      fence = "";
    }
    if (!fence) {
      const head = /^##\s+\d{1,2}:\d{2}:\d{2}\s·\s+(.+)$/.exec(line);
      if (head) {
        current = { label: head[1].trim(), body: [] };
        chunks.push(current);
        continue;
      }
    }
    if (current) current.body.push(line);
  }
  if (!chunks.length) {
    for (const line of lines) {
      const plain = /^(\d{1,2}:\d{2}:\d{2})\s+(\S.+)$/.exec(line.trim());
      if (!plain) continue;
      chunks.push({ label: plain[2].trim(), body: [] });
    }
  }
  const steps: CodingStep[] = [];
  for (const chunk of chunks) {
    const step = loggedStep(chunk.label, chunk.body.join("\n"), steps.length);
    const prev = steps[steps.length - 1];
    if (prev && sameLoggedLabel(prev.label, step.label) && !loggedBody(prev) && loggedBody(step)) {
      steps[steps.length - 1] = { ...step, key: prev.key };
    } else if (prev && sameLoggedLabel(prev.label, step.label) && !loggedBody(step)) {
      continue;
    } else {
      steps.push(step);
    }
  }
  return steps.slice(-120);
}

function fencedBodies(body: string): { lang: string; text: string }[] {
  const blocks: { lang: string; text: string }[] = [];
  let fence = "";
  let lang = "";
  let buf: string[] = [];
  for (const line of body.split("\n")) {
    if (!fence) {
      const open = /^(`{3,})(\w*)\s*$/.exec(line);
      if (!open) continue;
      fence = open[1];
      lang = open[2].toLowerCase();
      buf = [];
      continue;
    }
    if (line.trim() === fence) {
      blocks.push({ lang, text: buf.join("\n").replace(/\s+$/, "") });
      fence = "";
      continue;
    }
    buf.push(line);
  }
  return blocks;
}

function loggedBody(step: CodingStep): boolean {
  return Boolean(step.diff || step.code || step.output);
}

function sameLoggedLabel(left: string, right: string): boolean {
  return left.trim() === right.trim();
}

function loggedStep(rawLabel: string, body: string, index: number): CodingStep {
  const counts = /\s+\+(\d+)\s+[−-](\d+)\s*$/.exec(rawLabel);
  const label = (counts ? rawLabel.slice(0, counts.index) : rawLabel).replace(/^Lệnh:\s*/i, "").trim();
  let diff = "";
  let textBody = "";
  for (const fence of fencedBodies(body)) {
    const inner = clip(fence.text, 14000);
    if (!inner) continue;
    if (!diff && (fence.lang === "diff" || fence.lang === "patch") && looksLikeDiff(inner)) diff = inner;
    else if (!textBody) textBody = inner;
  }
  const kind = diff ? (kindOfLogged(label) === "delete" ? "delete" : "edit") : kindOfLogged(label);
  const counted = diff ? diffCounts(diff) : { added: counts ? Number(counts[1]) : 0, removed: counts ? Number(counts[2]) : 0 };
  const shell = kind === "shell";
  return {
    key: `log-${index}`,
    kind,
    status: "done",
    label: label || "Việc của agent",
    path: shell || kind === "search" ? "" : pathAfterVerb(label),
    command: shell ? label : "",
    diff,
    code: !shell && !diff ? textBody : "",
    output: shell ? textBody : "",
    added: counted.added,
    removed: counted.removed,
  };
}

function kindOfLogged(label: string): CodingKind | "" {
  const name = label.trim();
  if (/^(đọc|read)\b/i.test(name)) return "read";
  if (/^(tìm|search|grep|glob)\b/i.test(name)) return "search";
  if (/^(xóa|xoá|delete)\b/i.test(name)) return "delete";
  if (/^(sửa|ghi|edit|write)\b/i.test(name)) return "edit";
  if (/^(lệnh:|npm|pnpm|yarn|npx|git|node|python|pwsh|powershell|cmd|curl|ls|dir|cd|get-)/i.test(name)) return "shell";
  return "";
}
