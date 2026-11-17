import fs from "node:fs";
import path from "node:path";
import { cliClientLabel, type ProviderId } from "../shared/types";
import { briefFolder } from "./files";

export type CodingTrace = {
  chatSessionId: string;
  since: number;
  taskId: string;
  provider: ProviderId;
  title: string;
  workDir: string;
  line?: string;
  block?: string;
};

type Run = {
  since: number;
  task: string;
  filePath: string;
  lastLine: string;
  lastBlock: string;
};

export class CodingWatch {
  private readonly runs = new Map<string, Run>();
  private readonly pendingTask = new Map<string, string>();

  open(input: CodingTrace): string {
    return this.ensure(input).filePath;
  }

  write(input: CodingTrace): { path: string } {
    const run = this.ensure(input);
    const taskId = input.taskId || this.pendingTask.get(input.chatSessionId) || "";
    if (taskId && taskId !== run.task) {
      run.task = taskId;
      this.append(run.filePath, taskMarkdown(input.provider, taskId).join("\n") + "\n");
    }
    const label = (input.line || "").trim();
    const block = (input.block || "").trim();
    if ((label && label !== run.lastLine) || (block && block !== run.lastBlock)) {
      if (label) run.lastLine = label;
      if (block) run.lastBlock = block;
      this.append(run.filePath, section(label || "Việc của agent", block));
    }
    return { path: run.filePath };
  }

  noteTask(chatSessionId: string, taskId: string, provider: ProviderId): void {
    const id = taskId.trim();
    if (!id) return;
    this.pendingTask.set(chatSessionId, id);
    const run = this.runs.get(chatSessionId);
    if (!run || run.task === id) return;
    run.task = id;
    this.append(run.filePath, taskMarkdown(provider, id).join("\n") + "\n");
  }

  forget(filePath: string): void {
    const target = path.resolve(filePath);
    for (const [id, run] of this.runs) {
      if (path.resolve(run.filePath) === target) this.runs.delete(id);
    }
  }

  private ensure(input: CodingTrace): Run {
    const since = input.since || 0;
    const taskId = input.taskId || this.pendingTask.get(input.chatSessionId) || "";
    if (taskId) this.pendingTask.set(input.chatSessionId, taskId);
    const current = this.runs.get(input.chatSessionId);
    if (current && current.since === since) return current;
    const folder = briefFolder(input.workDir, input.chatSessionId);
    const filePath = path.join(folder, `coding-live-${since || "now"}.md`);
    fs.mkdirSync(folder, { recursive: true });
    if (!fs.existsSync(filePath)) {
      const header = [
        `# Coding · ${one(input.title || input.chatSessionId)}`,
        "",
        `- Thư mục: \`${input.workDir}\``,
        ...taskMarkdown(input.provider, taskId),
        "",
      ];
      fs.writeFileSync(filePath, header.join("\n"), "utf8");
    }
    const run = { since, task: taskId, filePath, lastLine: "", lastBlock: "" };
    this.runs.set(input.chatSessionId, run);
    return run;
  }

  private append(filePath: string, text: string): void {
    const body = text.replace(/\r\n/g, "\n").trim();
    if (!body) return;
    try {
      fs.appendFileSync(filePath, `${body}\n\n`, "utf8");
    } catch {
      /* lần ghi sau vẫn nối tiếp được */
    }
  }
}

function taskMarkdown(provider: ProviderId, taskId: string): string[] {
  const name = cliClientLabel(provider) || "Agent";
  if (!taskId.trim()) return [`- Task ${name}: đang chờ phiên`];
  const hint = resumeCommand(provider, taskId);
  const lines = [`- Task ${name}: \`${taskId}\``];
  if (hint) lines.push(`- Nối lại: \`${hint}\``);
  return lines;
}

function resumeCommand(provider: ProviderId, taskId: string): string {
  const id = taskId.trim();
  if (!id) return "";
  if (provider === "cursor-cli") return `agent --resume=${id}`;
  if (provider === "claude-cli") return `claude --resume ${id}`;
  if (provider === "codex-cli") return `codex resume ${id}`;
  if (provider === "gemini-cli") return `gemini --resume ${id}`;
  return "";
}

function section(label: string, block: string): string {
  const parts = [`## ${stamp()} · ${label}`];
  if (block) parts.push("", fence(block.includes("\n@@") || block.startsWith("@@") || block.startsWith("+") || block.startsWith("-") ? "diff" : "text", block));
  return parts.join("\n");
}

function fence(lang: string, body: string): string {
  const tick = body.includes("```") ? "````" : "```";
  return `${tick}${lang}\n${body}\n${tick}`;
}

function one(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stamp(): string {
  return new Date().toLocaleTimeString("vi-VN", { hour12: false });
}
