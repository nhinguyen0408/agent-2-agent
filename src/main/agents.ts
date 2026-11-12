import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Settings } from "../shared/types";
import { findExecutable } from "./cliDetect";

export type ModelTurn = { role: "user" | "assistant"; text: string };

export type ReplyInput = {
  peerId: string;
  selfName: string;
  peerName: string;
  history: ModelTurn[];
  signal: AbortSignal;
  onDelta: (chunk: string) => void;
  fileRelay?: { url: string };
};

export class AgentHost {
  private readonly running = new Map<string, ChildProcess>();

  constructor(private readonly settings: () => Settings) {}

  async reply(input: ReplyInput): Promise<string> {
    if (input.signal.aborted) throw abortError();
    const settings = this.settings();
    if (settings.provider === "echo") return echoReply(input);
    if (settings.provider === "claude-cli") return this.claudeCli(input, settings);
    return this.cursorCli(input, settings);
  }

  async dispose(): Promise<void> {
    for (const child of this.running.values()) killChild(child);
    this.running.clear();
  }

  async drop(peerId: string): Promise<void> {
    const child = this.running.get(peerId);
    if (!child) return;
    this.running.delete(peerId);
    killChild(child);
  }

  private claudeCli(input: ReplyInput, settings: Settings): Promise<string> {
    const prompt = oneLine(conversationPrompt(input));
    return this.runCli(input, {
      command: settings.claudeCommand || "claude",
      cwd: settings.workDir,
      missing: "Không tìm thấy lệnh claude. Cài Claude Code, rồi chạy `claude auth login` một lần trên máy này.",
      attempts: [
        ["-p", prompt, "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-mode", "bypassPermissions"],
        ["-p", prompt, "--output-format", "text", "--permission-mode", "bypassPermissions"],
        ["-p", prompt, "--output-format", "text", "--permission-mode", "dontAsk"],
      ],
    });
  }

  private cursorCli(input: ReplyInput, settings: Settings): Promise<string> {
    const prompt = clip(conversationPrompt(input), 12000);
    return this.runCli(input, {
      command: settings.cursorCommand || "agent",
      cwd: settings.workDir,
      missing: "Không tìm thấy lệnh agent. Cài Cursor CLI, rồi chạy `agent login` một lần trên máy này.",
      attempts: [
        ["-p", "--trust", "--force", "--output-format", "stream-json", "--stream-partial-output", prompt],
        ["-p", "--trust", "--force", prompt],
        ["-p", "--trust", prompt],
      ],
    });
  }

  private runCli(
    input: ReplyInput,
    spec: { command: string; cwd: string; missing: string; attempts: string[][] },
  ): Promise<string> {
    if (!fs.existsSync(spec.cwd)) throw new Error(`Thư mục làm việc không tồn tại: ${spec.cwd}`);
    const command = resolveCommand(spec.command);
    return this.spawnAttempt(input, command, spec.cwd, spec.attempts, 0, spec.missing);
  }

  private spawnAttempt(
    input: ReplyInput,
    command: string,
    cwd: string,
    attempts: string[][],
    index: number,
    missing: string,
  ): Promise<string> {
    const args = attempts[index];
    if (!args) return Promise.reject(new Error(missing));
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = launch(command, args, cwd);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(missing));
        return;
      }
      this.running.set(input.peerId, child);
      let stdout = "";
      let stderr = "";
      let lineBuf = "";
      let streamed = "";
      let finalText = "";
      const onAbort = () => killChild(child);
      if (input.signal.aborted) onAbort();
      input.signal.addEventListener("abort", onAbort, { once: true });
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
        lineBuf = consumeLines(lineBuf, chunk, (event) => {
          const piece = streamPiece(event);
          if (piece) {
            streamed += piece;
            input.onDelta(piece);
          }
          const result = resultText(event);
          if (result) finalText = result;
        });
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (err) => {
        this.running.delete(input.peerId);
        input.signal.removeEventListener("abort", onAbort);
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new Error(missing));
          return;
        }
        reject(err);
      });
      child.on("close", (code) => {
        this.running.delete(input.peerId);
        input.signal.removeEventListener("abort", onAbort);
        if (input.signal.aborted) {
          reject(abortError());
          return;
        }
        const text = (finalText || streamed || plainText(stdout)).trim();
        if (code === 0 && text) {
          if (!streamed && !finalText) input.onDelta(text);
          resolve(text);
          return;
        }
        const badFlag = /unknown (?:option|flag|argument)|unrecognized option|unexpected argument/i.test(stderr);
        if (badFlag && index + 1 < attempts.length) {
          this.spawnAttempt(input, command, cwd, attempts, index + 1, missing).then(resolve, reject);
          return;
        }
        const detail = stderr.trim() || stdout.trim();
        reject(new Error(detail || `Lệnh thoát với mã ${code ?? "?"}. ${missing}`));
      });
    });
  }
}

function oneLine(value: string): string {
  return clip(value.replace(/\s+/g, " ").trim(), 4000);
}

function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  const head = Math.floor(max * 0.45);
  return `${value.slice(0, head)}\n...\n${value.slice(-(max - head - 5))}`;
}

function conversationPrompt(input: ReplyInput): string {
  const transcript = input.history
    .map((turn) => `${turn.role === "user" ? input.peerName : input.selfName}: ${turn.text}`)
    .join("\n");
  return [
    `Bạn là ${input.selfName}. Bạn đang nói chuyện trực tiếp với ${input.peerName} qua LAN Agents.`,
    "Hãy trả lời tin nhắn cuối như một người trong cuộc hội thoại này.",
    "Quy tắc:",
    "- Chỉ viết nội dung sẽ gửi cho đối phương. Không mở đầu bằng việc nhắc lại các quy tắc này.",
    "- Dùng cùng ngôn ngữ với tin nhắn cuối. Giữ câu trả lời gọn, thường dưới 120 từ.",
    "- Bám các lượt trước. Không bịa việc máy kia đã làm.",
    `- Nếu ${input.peerName} nhờ một việc trên máy này, làm trong thư mục làm việc rồi nói kết quả. Lệnh và sửa file được tự chạy, không hỏi lại.`,
    "- Nếu đối phương chỉ trò chuyện, chỉ trả lời bằng lời. Không chạy lệnh và không sửa file. Riêng khi họ nhờ gửi file thì dùng đúng lệnh gửi file bên dưới.",
    input.fileRelay
      ? `- Để gửi file cho ${input.peerName}, không copy sang ổ đĩa máy kia và không dùng đường UNC. File phải nằm trong thư mục làm việc. Chạy: curl.exe -s -H "Content-Type: text/plain; charset=utf-8" --data-binary "ĐƯỜNG_DẪN_ĐẦY_ĐỦ" ${input.fileRelay.url} . Khi kết quả có ok, file đã tới thư mục làm việc của ${input.peerName}.`
      : "",
    "",
    "Hội thoại:",
    transcript,
    "",
    `Hãy trả lời ${input.peerName}.`,
  ].join("\n");
}

function launch(command: string, args: string[], cwd: string): ChildProcess {
  const env = cliEnv();
  const runtime = cursorRuntime(command);
  if (runtime) {
    env.CURSOR_INVOKED_AS = "agent";
    return spawn(runtime.node, [runtime.index, ...args], {
      cwd,
      env,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  const safeArgs = args.map((arg) => arg.replace(/\s+/g, " ").trim());
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    const comspec = process.env.ComSpec || "cmd.exe";
    const line = [command, ...safeArgs].map(quoteCmd).join(" ");
    return spawn(comspec, ["/d", "/s", "/c", line], {
      cwd,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  return spawn(command, safeArgs, {
    cwd,
    env,
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function cursorRuntime(command: string): { node: string; index: string } | null {
  const base = path.basename(command).toLowerCase();
  const shim = base === "agent" || base === "agent.cmd" || base === "agent.ps1" || base === "cursor-agent" || base === "cursor-agent.cmd" || base === "cursor-agent.ps1";
  if (!shim && !command.toLowerCase().includes(`${path.sep}cursor-agent${path.sep}`)) return null;
  const beside = path.dirname(path.resolve(command));
  const roots = [
    beside,
    path.join(process.env.LOCALAPPDATA || "", "cursor-agent"),
  ];
  for (const root of roots) {
    const directNode = path.join(root, "node.exe");
    const directIndex = path.join(root, "index.js");
    if (fs.existsSync(directNode) && fs.existsSync(directIndex)) return { node: directNode, index: directIndex };
    const versions = path.join(root, "versions");
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(versions);
    } catch {
      continue;
    }
    const ranked = entries
      .filter((name) => /^\d{4}\.\d{1,2}\.\d{1,2}(?:-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/.test(name))
      .map((name) => ({ name, rank: versionRank(name) }))
      .sort((a, b) => b.rank - a.rank);
    for (const item of ranked) {
      const node = path.join(versions, item.name, "node.exe");
      const index = path.join(versions, item.name, "index.js");
      if (fs.existsSync(node) && fs.existsSync(index)) return { node, index };
    }
  }
  return null;
}

function versionRank(name: string): number {
  const match = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-(\d{2})-(\d{2})-(\d{2}))?/.exec(name);
  if (!match) return 0;
  const [, year, month, day, hour = "0", minute = "0", second = "0"] = match;
  return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
}

function cliEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CURSOR_API_KEY;
  const prefix = [
    path.join(os.homedir(), ".local", "bin"),
    path.join(os.homedir(), ".claude", "local"),
    path.join(process.env.LOCALAPPDATA || "", "cursor-agent"),
    path.join(process.env.APPDATA || "", "npm"),
  ].filter((dir) => dir && fs.existsSync(dir));
  const current = env.PATH || env.Path || "";
  const next = [...prefix, current].filter(Boolean).join(path.delimiter);
  env.PATH = next;
  env.Path = next;
  return env;
}

function resolveCommand(name: string): string {
  return findExecutable(name) ?? name.trim();
}

function consumeLines(buffer: string, chunk: string, onEvent: (event: unknown) => void): string {
  const text = buffer + chunk;
  const lines = text.split(/\r?\n/);
  const rest = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      onEvent(JSON.parse(trimmed));
    } catch {
      /* dòng không phải JSON */
    }
  }
  return rest;
}

function streamPiece(event: unknown): string {
  if (!event || typeof event !== "object") return "";
  const record = event as {
    type?: string;
    timestamp_ms?: number;
    model_call_id?: string;
    event?: { delta?: { type?: string; text?: string } };
    message?: { content?: Array<{ type?: string; text?: string }> };
  };
  const delta = record.event?.delta;
  if (record.type === "stream_event" && delta?.type === "text_delta" && delta.text) return delta.text;
  if (record.type === "assistant" && record.timestamp_ms && !record.model_call_id) {
    const text = record.message?.content?.find((block) => block.type === "text")?.text;
    return text || "";
  }
  return "";
}

function resultText(event: unknown): string {
  if (!event || typeof event !== "object") return "";
  const record = event as { type?: string; result?: unknown };
  if (record.type === "result" && typeof record.result === "string") return record.result;
  return "";
}

function plainText(stdout: string): string {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.every((line) => line.startsWith("{"))) return "";
  return stdout;
}

function quoteCmd(value: string): string {
  if (!value) return '""';
  if (!/[\s"&|<>^]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

function killChild(child: ChildProcess): void {
  if (child.killed || child.exitCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  child.kill("SIGTERM");
}

async function echoReply(input: ReplyInput): Promise<string> {
  const incoming = input.history[input.history.length - 1]?.text ?? "";
  const reply = `Echo của ${input.selfName} đã nhận từ ${input.peerName}: ${incoming}`;
  const size = 12;
  for (let i = 0; i < reply.length; i += size) {
    if (input.signal.aborted) throw abortError();
    input.onDelta(reply.slice(i, i + size));
    await delay(16);
  }
  return reply;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function abortError(): Error {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}
