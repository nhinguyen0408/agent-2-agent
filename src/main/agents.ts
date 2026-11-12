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
        ["-p", prompt, "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-mode", "dontAsk"],
        ["-p", prompt, "--output-format", "text", "--permission-mode", "dontAsk"],
      ],
    });
  }

  private cursorCli(input: ReplyInput, settings: Settings): Promise<string> {
    const prompt = oneLine(conversationPrompt(input));
    return this.runCli(input, {
      command: settings.cursorCommand || "agent",
      cwd: settings.workDir,
      missing: "Không tìm thấy lệnh agent. Cài Cursor CLI, rồi chạy `agent login` một lần trên máy này.",
      attempts: [
        ["-p", "--output-format", "stream-json", "--stream-partial-output", prompt],
        ["-p", prompt],
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
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat.length <= 4000) return flat;
  return `${flat.slice(0, 1800)} ... ${flat.slice(-1800)}`;
}

function conversationPrompt(input: ReplyInput): string {
  const lines = input.history.map((turn) => `${turn.role === "user" ? input.peerName : input.selfName}: ${turn.text}`);
  return [
    `Bạn là ${input.selfName}, đang nói chuyện với ${input.peerName} qua mạng LAN.`,
    "Trả lời cùng ngôn ngữ với tin nhắn cuối. Chỉ trả lời bằng văn bản.",
    "Không sửa file và không chạy lệnh trừ khi tin nhắn cuối yêu cầu rõ một việc trên máy này.",
    "",
    "Hội thoại:",
    lines.join("\n\n"),
  ].join("\n");
}

function launch(command: string, args: string[], cwd: string): ChildProcess {
  const env = cliEnv();
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    const comspec = process.env.ComSpec || "cmd.exe";
    const line = [command, ...args].map(quoteCmd).join(" ");
    return spawn(comspec, ["/d", "/s", "/c", line], {
      cwd,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  return spawn(command, args, {
    cwd,
    env,
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
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
