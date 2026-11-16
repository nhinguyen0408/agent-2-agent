import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { cliClientLabel, type ProviderId } from "../shared/types";
import { briefFolder } from "./files";

const EDIT = /editToolCall|writeToolCall|deleteToolCall|strReplaceToolCall|applyPatch|"name"\s*:\s*"(Edit|Write|ApplyPatch|StrReplace|search_replace|edit_file|write|write_file|replace|MultiEdit|NotebookEdit|Delete)"|file_change|apply_patch/i;
const SHELL = /shellToolCall|command_execution|"name"\s*:\s*"(Bash|Shell|PowerShell|shell|bash|run_shell_command)"/i;
const READ = /readToolCall|grepToolCall|globToolCall|"name"\s*:\s*"(Read|Grep|Glob|SemanticSearch|read_file|grep|glob)"/i;

export type CodingTrace = {
  chatSessionId: string;
  since: number;
  taskId: string;
  provider: ProviderId;
  title: string;
  workDir: string;
  line: string;
  arm: boolean;
};

type Run = {
  since: number;
  task: string;
  logPath: string;
  pidPath: string;
  born: number;
  lastLine: string;
};

export function describeTool(blob: string): { line: string; writesCode: boolean } | null {
  const text = blob.trim();
  if (!text) return null;
  const command = field(text, "command") || field(text, "cmd");
  const file = field(text, "path") || field(text, "file_path") || field(text, "target_file") || field(text, "filePath") || field(text, "target_notebook");
  if (SHELL.test(text)) return { line: clip(command ? `Lệnh: ${one(command)}` : "Lệnh"), writesCode: true };
  if (EDIT.test(text)) return { line: clip(file ? `Sửa ${file}` : "Sửa file"), writesCode: true };
  if (READ.test(text)) return { line: clip(file ? `Đọc ${file}` : "Đọc"), writesCode: false };
  if (file) return { line: clip(file), writesCode: false };
  return null;
}

export function resumeCommand(provider: ProviderId, taskId: string): string {
  const id = taskId.trim();
  if (!id) return "";
  if (provider === "cursor-cli") return `agent --resume=${id}`;
  if (provider === "claude-cli") return `claude --resume ${id}`;
  if (provider === "codex-cli") return `codex resume ${id}`;
  if (provider === "gemini-cli") return `gemini --resume ${id}`;
  return "";
}

export class CodingWatch {
  private readonly runs = new Map<string, Run>();
  private readonly pendingTask = new Map<string, string>();
  private readonly failed = new Set<string>();

  write(input: CodingTrace): { opened: boolean; error: string } {
    const since = input.since || 0;
    const taskId = input.taskId || this.pendingTask.get(input.chatSessionId) || "";
    if (taskId) this.pendingTask.set(input.chatSessionId, taskId);
    let run = this.runs.get(input.chatSessionId);
    if (run && run.since !== since) run = undefined;
    if (!run && !input.arm) return { opened: false, error: "" };
    let opened = false;
    if (!run) {
      const created = this.spawnRun(input, taskId, since);
      if (created.error || !created.run) return { opened: false, error: created.error };
      run = created.run;
      opened = true;
    } else if (input.arm && !this.alive(run)) {
      try {
        openTerminal(run.logPath, run.pidPath, input.workDir, windowTitle(input.title, taskId));
        run.born = Date.now();
        this.failed.delete(this.failKey(input.chatSessionId, since));
      } catch (err) {
        const key = this.failKey(input.chatSessionId, since);
        if (this.failed.has(key)) return { opened: false, error: "" };
        this.failed.add(key);
        const message = err instanceof Error && err.message.trim() ? err.message.trim() : "Không mở được terminal.";
        return { opened: false, error: message };
      }
    }
    if (taskId && taskId !== run.task) {
      run.task = taskId;
      for (const line of taskLines(input.provider, taskId)) this.append(run.logPath, line);
    }
    if (input.line && input.line !== run.lastLine) {
      run.lastLine = input.line;
      this.append(run.logPath, `${stamp()}  ${input.line}`);
    }
    return { opened, error: "" };
  }

  noteTask(chatSessionId: string, taskId: string, provider: ProviderId): void {
    const id = taskId.trim();
    if (!id) return;
    this.pendingTask.set(chatSessionId, id);
    const run = this.runs.get(chatSessionId);
    if (!run || run.task === id) return;
    run.task = id;
    for (const line of taskLines(provider, id)) this.append(run.logPath, line);
  }

  private spawnRun(input: CodingTrace, taskId: string, since: number): { run?: Run; error: string } {
    try {
      const run = this.begin({ ...input, taskId });
      this.runs.set(input.chatSessionId, run);
      this.failed.delete(this.failKey(input.chatSessionId, since));
      return { run, error: "" };
    } catch (err) {
      const key = this.failKey(input.chatSessionId, since);
      if (this.failed.has(key)) return { error: "" };
      this.failed.add(key);
      const message = err instanceof Error && err.message.trim() ? err.message.trim() : "Không mở được terminal.";
      return { error: message };
    }
  }

  private begin(input: CodingTrace): Run {
    const since = input.since || 0;
    const folder = briefFolder(input.workDir, input.chatSessionId);
    const logPath = path.join(folder, `coding-live-${since || "now"}.log`);
    const pidPath = path.join(folder, `coding-live-${since || "now"}.pid`);
    fs.mkdirSync(folder, { recursive: true });
    const header = [
      "LAN Agents · coding",
      "Cửa sổ này hiện đúng việc agent máy này đang làm.",
      `Đoạn chat: ${one(input.title || input.chatSessionId)}`,
      ...taskLines(input.provider, input.taskId),
      `Thư mục: ${input.workDir}`,
      "",
    ];
    fs.writeFileSync(logPath, `\uFEFF${header.join("\r\n")}\r\n`, "utf8");
    openTerminal(logPath, pidPath, input.workDir, windowTitle(input.title, input.taskId));
    return { since, task: input.taskId, logPath, pidPath, born: Date.now(), lastLine: "" };
  }

  private alive(run: Run): boolean {
    const fresh = Date.now() - run.born < 4000;
    try {
      if (!fs.existsSync(run.pidPath)) return fresh;
      const pid = Number(fs.readFileSync(run.pidPath, "utf8").trim());
      if (!Number.isInteger(pid) || pid <= 0) return fresh;
      process.kill(pid, 0);
      return true;
    } catch {
      return fresh;
    }
  }

  private append(logPath: string, text: string): void {
    const line = text.replace(/\s+/g, " ").trim();
    if (!line) return;
    try {
      fs.appendFileSync(logPath, `${line}\r\n`, "utf8");
    } catch {
      /* cửa sổ đang đọc file, lần sau vẫn ghi tiếp được */
    }
  }

  private failKey(chatSessionId: string, since: number): string {
    return `${chatSessionId}:${since}`;
  }
}

function taskLines(provider: ProviderId, taskId: string): string[] {
  const name = cliClientLabel(provider) || "Agent";
  if (!taskId.trim()) return [`Task ${name}: đang chờ phiên`];
  const hint = resumeCommand(provider, taskId);
  return hint ? [`Task ${name}: ${taskId}`, `Nối lại: ${hint}`] : [`Task ${name}: ${taskId}`];
}

function windowTitle(title: string, taskId: string): string {
  const topic = one(title).slice(0, 40);
  const task = taskId.trim().slice(0, 8);
  return ["LAN Agents", "coding", topic, task].filter(Boolean).join(" · ");
}

function openTerminal(logPath: string, pidPath: string, cwd: string, title: string): void {
  if (process.platform === "win32") {
    const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const script = [
      `try { $Host.UI.RawUI.WindowTitle = ${psQuote(title)} } catch {}`,
      `Set-Content -LiteralPath ${psQuote(pidPath)} -Value $PID -Encoding ascii`,
      "try {",
      `  Get-Content -LiteralPath ${psQuote(logPath)} -Wait -Tail 200 -Encoding utf8`,
      "} catch {",
      "  Write-Host $_.Exception.Message",
      "  while ($true) { Start-Sleep -Seconds 5 }",
      "} finally {",
      `  Remove-Item -LiteralPath ${psQuote(pidPath)} -ErrorAction SilentlyContinue`,
      "}",
    ].join("\r\n");
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const command = `Start-Process -FilePath ${psQuote(powershell)} -WorkingDirectory ${psQuote(cwd)} -WindowStyle Normal -ArgumentList '-NoExit','-NoProfile','-EncodedCommand',${psQuote(encoded)}`;
    const result = spawnSync(powershell, ["-NoProfile", "-WindowStyle", "Hidden", "-Command", command], {
      cwd,
      windowsHide: true,
      encoding: "utf8",
      timeout: 20_000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const detail = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
      throw new Error(detail || "Không mở được terminal.");
    }
    return;
  }
  if (process.platform === "darwin") {
    const command = `tail -n +1 -f ${shQuote(logPath)}`;
    const child = spawn("osascript", ["-e", `tell application "Terminal" to do script ${JSON.stringify(command)}`], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return;
  }
  const attempts: Array<{ cmd: string; args: string[] }> = [
    { cmd: "x-terminal-emulator", args: ["-e", "tail", "-n", "+1", "-f", logPath] },
    { cmd: "gnome-terminal", args: ["--", "tail", "-n", "+1", "-f", logPath] },
    { cmd: "xterm", args: ["-e", "tail", "-n", "+1", "-f", logPath] },
  ];
  let last: unknown;
  for (const item of attempts) {
    try {
      const child = spawn(item.cmd, item.args, { detached: true, stdio: "ignore" });
      child.on("error", () => undefined);
      child.unref();
      return;
    } catch (err) {
      last = err;
    }
  }
  throw last instanceof Error ? last : new Error("Không mở được terminal.");
}

function field(blob: string, key: string): string {
  const match = new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`).exec(blob);
  if (!match?.[1]) return "";
  try {
    const value = JSON.parse(`"${match[1]}"`) as unknown;
    return typeof value === "string" ? value : "";
  } catch {
    return match[1];
  }
}

function one(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clip(value: string): string {
  const clean = one(value);
  return clean.length > 180 ? `${clean.slice(0, 179)}…` : clean;
}

function stamp(): string {
  return new Date().toLocaleTimeString("vi-VN", { hour12: false });
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
