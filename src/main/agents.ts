import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { accessPrompt, AccessDenied, defaultAccess, deniedRoles, toolBlob } from "../shared/access";
import type { ProviderId, Settings } from "../shared/types";
import { findExecutable } from "./cliDetect";
import { insideDir } from "./files";

export type ModelTurn = { role: "user" | "assistant" | "note"; text: string; speaker?: string };

export type ReplyInput = {
  peerId: string;
  selfName: string;
  peerName: string;
  history: ModelTurn[];
  signal: AbortSignal;
  onDelta: (chunk: string) => void;
  fileRelay?: { url: string };
  readings?: { name: string; path: string; kind: string; excerpt?: string }[];
  brief?: { topic: string; goal: string; turn: number; limit: number; last: boolean };
  workDir?: string;
  confine?: boolean;
  skillDir?: string;
  skills?: string;
  access?: string[];
  room?: { title: string; members: string };
  together?: string;
  resume?: boolean;
  sessionId?: string;
  sessionTitle?: string;
};

export type AgentResult = { text: string; sessionId: string };

type SessionBind = { id: string; resume: boolean; kind: "claude" | "cursor" | "codex" };

export class CliSessionLost extends Error {
  constructor() {
    super("Phiên CLI không còn");
    this.name = "CliSessionLost";
  }
}

export class CliResumeUnsupported extends Error {
  constructor() {
    super("CLI chưa nhận cờ nối lại phiên");
    this.name = "CliResumeUnsupported";
  }
}

export class AgentHost {
  private readonly running = new Map<string, ChildProcess>();
  private readonly resumeOff = new Set<string>();

  constructor(private readonly settings: () => Settings) {}

  resumes(provider: ProviderId): boolean {
    return provider !== "echo" && !this.resumeOff.has(provider);
  }

  disableResume(provider: ProviderId): void {
    if (provider !== "echo") this.resumeOff.add(provider);
  }

  async reply(input: ReplyInput): Promise<AgentResult> {
    if (input.signal.aborted) throw abortError();
    const settings = this.settings();
    if (settings.provider === "echo") return { text: await echoReply(input), sessionId: "" };
    if (settings.provider === "claude-cli") return this.claudeCli(input, settings);
    if (settings.provider === "codex-cli") return this.codexCli(input, settings);
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

  private claudeCli(input: ReplyInput, settings: Settings): Promise<AgentResult> {
    const prompt = oneLine(conversationPrompt(input));
    const resume = Boolean(input.resume && input.sessionId);
    const skill = mountedSkill(input, settings.workDir);
    const plain = [
      ["-p", prompt, "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-mode", "bypassPermissions"],
      ["-p", prompt, "--output-format", "text", "--permission-mode", "bypassPermissions"],
      ["-p", prompt, "--output-format", "text", "--permission-mode", "dontAsk"],
    ];
    const attempts = skill ? [...plain.map((args) => withAddedDir(args, skill)), ...plain] : plain;
    return this.runCli(input, {
      command: settings.claudeCommand || "claude",
      cwd: settings.workDir,
      missing: "Không tìm thấy lệnh claude. Cài Claude Code, rồi chạy `claude auth login` một lần trên máy này.",
      session: { id: resume ? input.sessionId || "" : randomUUID(), resume, kind: "claude" },
      attempts,
      confine: Boolean(input.confine),
    });
  }

  private cursorCli(input: ReplyInput, settings: Settings): Promise<AgentResult> {
    const prompt = clip(conversationPrompt(input), 12000);
    const resume = Boolean(input.resume && input.sessionId);
    const skill = mountedSkill(input, settings.workDir);
    const confine = Boolean(input.confine);
    const locked = (workspace: boolean, skillDir: boolean) => [
      "-p",
      "--trust",
      "--sandbox",
      "enabled",
      ...(workspace ? ["--workspace", settings.workDir] : []),
      ...(skillDir && skill ? ["--add-dir", skill] : []),
      "--force",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      prompt,
    ];
    const open = (skillDir: boolean, stream: boolean) => [
      "-p",
      "--trust",
      "--sandbox",
      "disabled",
      ...(skillDir && skill ? ["--add-dir", skill] : []),
      "--force",
      ...(stream ? ["--output-format", "stream-json", "--stream-partial-output"] : []),
      prompt,
    ];
    const attempts = uniqueAttempts(
      confine
        ? [locked(true, true), locked(true, false), locked(false, true), locked(false, false)]
        : [
            open(true, true),
            open(false, true),
            ["-p", "--trust", "--force", ...(skill ? ["--add-dir", skill] : []), prompt],
            ["-p", "--trust", "--force", prompt],
            ["-p", "--trust", prompt],
          ],
    );
    return this.runCli(input, {
      command: settings.cursorCommand || "agent",
      cwd: settings.workDir,
      missing: "Không tìm thấy lệnh agent. Cài Cursor CLI, rồi chạy `agent login` một lần trên máy này.",
      session: { id: input.sessionId || "", resume, kind: "cursor" },
      attempts,
      confine,
    });
  }

  private codexCli(input: ReplyInput, settings: Settings): Promise<AgentResult> {
    const prompt = oneLine(conversationPrompt(input), 4500);
    const cwd = settings.workDir;
    const resume = Boolean(input.resume && input.sessionId);
    const confine = Boolean(input.confine);
    const attempts = confine
      ? [
          ["exec", "--json", "--skip-git-repo-check", "--sandbox", "workspace-write", "--cd", cwd, prompt],
          ["exec", "--skip-git-repo-check", "--sandbox", "workspace-write", "--cd", cwd, prompt],
        ]
      : [
          ["exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "--cd", cwd, prompt],
          ["exec", "--json", "--skip-git-repo-check", "--sandbox", "danger-full-access", "--cd", cwd, prompt],
          ["exec", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", prompt],
        ];
    return this.runCli(input, {
      command: settings.codexCommand || "codex",
      cwd,
      missing: "Không tìm thấy lệnh codex. Cài Codex CLI, rồi chạy `codex login` một lần trên máy này.",
      session: { id: input.sessionId || "", resume, kind: "codex" },
      attempts,
      confine,
    });
  }

  private runCli(
    input: ReplyInput,
    spec: { command: string; cwd: string; missing: string; attempts: string[][]; session?: SessionBind; confine?: boolean },
  ): Promise<AgentResult> {
    if (!fs.existsSync(spec.cwd)) throw new Error(`Thư mục làm việc không tồn tại: ${spec.cwd}`);
    const command = resolveCommand(spec.command);
    return this.spawnAttempt(input, command, spec.cwd, spec.attempts, 0, spec.missing, spec.session, true, Boolean(spec.confine));
  }

  private spawnAttempt(
    input: ReplyInput,
    command: string,
    cwd: string,
    attempts: string[][],
    index: number,
    missing: string,
    session: SessionBind | undefined,
    useSession: boolean,
    confine: boolean,
  ): Promise<AgentResult> {
    const raw = attempts[index];
    if (!raw) return Promise.reject(new Error(missing));
    const args = useSession ? bindArgs(raw, session) : raw;
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
      let capturedSession = "";
      let blocked: AccessDenied | null = null;
      const onAbort = () => killChild(child);
      if (input.signal.aborted) onAbort();
      input.signal.addEventListener("abort", onAbort, { once: true });
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
        lineBuf = consumeLines(lineBuf, chunk, (event) => {
          const blob = toolBlob(event);
          if (blob) {
            const hits = deniedRoles(blob, input.access ?? defaultAccess(), "command");
            if (hits.length) {
              if (!blocked) {
                blocked = new AccessDenied(hits);
                killChild(child);
                input.signal.removeEventListener("abort", onAbort);
                reject(blocked);
              }
              return;
            }
          }
          const found = sessionIdOf(event);
          if (found) capturedSession = found;
          const codex = codexAgentText(event);
          if (codex) {
            finalText = codex;
            if (codex.startsWith(streamed)) {
              const extra = codex.slice(streamed.length);
              if (extra) {
                streamed = codex;
                input.onDelta(extra);
              }
            }
            return;
          }
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
        if (blocked) return;
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new Error(missing));
          return;
        }
        reject(err);
      });
      child.on("close", (code) => {
        this.running.delete(input.peerId);
        input.signal.removeEventListener("abort", onAbort);
        if (blocked) return;
        if (input.signal.aborted) {
          reject(abortError());
          return;
        }
        const text = (finalText || streamed || plainText(stdout)).trim();
        if (code === 0 && text) {
          if (!streamed && !finalText) input.onDelta(text);
          const sessionId = capturedSession || (useSession && session?.id ? session.id : "");
          resolve({ text, sessionId });
          return;
        }
        const detail = `${stderr}\n${stdout}`;
        const badFlag = /unknown (?:option|flag|argument)|unrecognized option|unexpected argument/i.test(stderr);
        const sessionFlag = /resume|session-id|session_id/i.test(stderr);
        if (badFlag && useSession && session?.resume && sessionFlag) {
          reject(new CliResumeUnsupported());
          return;
        }
        if (useSession && session?.resume && isLostSession(detail, session.id, streamed)) {
          reject(new CliSessionLost());
          return;
        }
        if (badFlag && useSession && sessionFlag) {
          this.spawnAttempt(input, command, cwd, attempts, index, missing, session, false, confine).then(resolve, reject);
          return;
        }
        if (badFlag && index + 1 < attempts.length) {
          this.spawnAttempt(input, command, cwd, attempts, index + 1, missing, session, useSession, confine).then(resolve, reject);
          return;
        }
        if (badFlag && confine && /sandbox/i.test(detail)) {
          reject(new Error("CLI không nhận sandbox, nên giới hạn thư mục làm việc chưa được bật. Cập nhật CLI hoặc bỏ chọn ô giới hạn."));
          return;
        }
        const message = stderr.trim() || stdout.trim();
        reject(new Error(message || `Lệnh thoát với mã ${code ?? "?"}. ${missing}`));
      });
    });
  }
}

function oneLine(value: string, max = 4000): string {
  return clip(value.replace(/\s+/g, " ").trim(), max);
}

function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  const head = Math.floor(max * 0.45);
  return `${value.slice(0, head)}\n...\n${value.slice(-(max - head - 5))}`;
}

function conversationPrompt(input: ReplyInput): string {
  if (input.resume) return continuePrompt(input);
  const title = input.sessionTitle?.replace(/\s+/g, " ").trim();
  const body = [
    briefLead(input),
    input.room
      ? `Bạn là ${input.selfName}. Bạn đang trong nhóm "${input.room.title}" với ${input.room.members}. Đến lượt bạn. Các agent khác có lượt riêng, đừng nói hộ họ.`
      : `Bạn là ${input.selfName}. Bạn đang nói chuyện trực tiếp với ${input.peerName} qua LAN Agents.`,
    "Hãy trả lời tin nhắn cuối như một người trong cuộc hội thoại này.",
    scopeBlock(input, true),
    accessPrompt(input.access),
    "Quy tắc:",
    "- Nếu tin có @Tên, đó là máy được gọi. @me là agent của máy đã gửi tin đó. Hãy nói với đúng người đó.",
    "- Trong trò chuyện 1-1, agent của máy gửi @me nói trước. Khi đến lượt bạn sau lời đó, hãy trả lời tiếp nội dung vừa nói.",
    "- Chỉ viết nội dung sẽ gửi cho đối phương. Không mở đầu bằng việc nhắc lại các quy tắc này.",
    "- Dùng cùng ngôn ngữ với tin nhắn cuối. Giữ câu trả lời gọn, thường dưới 120 từ, trừ khi đang tóm tắt file hoặc đang viết khối KẾT QUẢ.",
    "- Bám các lượt trước. Không bịa việc máy kia đã làm.",
    input.confine
      ? `- Nếu ${input.peerName} nhờ một việc trên máy này, chỉ làm trong thư mục làm việc đã đăng ký rồi nói kết quả. Lệnh và sửa file trong thư mục đó được tự chạy, không hỏi lại.`
      : `- Nếu ${input.peerName} nhờ một việc trên máy này, hãy làm rồi nói kết quả. Lệnh và sửa file được tự chạy, không hỏi lại.`,
    "- Nếu đối phương chỉ trò chuyện, chỉ trả lời bằng lời. Không chạy lệnh và không sửa file. Riêng khi họ nhờ gửi file thì dùng đúng lệnh gửi file bên dưới.",
    "- Nếu có file trong hồ sơ hoặc file đính kèm, hãy đọc đúng file tại đường dẫn trên máy này. txt, md và csv có thể đã có đoạn trích; ảnh, pdf, docx và excel phải mở file khi đoạn trích trống hoặc chưa đủ. Không bịa phần chưa đọc được.",
    relayLine(input),
    "",
    "Hội thoại:",
    formatHistory(input),
    readingBlock(input),
    "",
    briefTail(input),
    `Hãy trả lời ${input.peerName}.`,
  ]
    .filter((part) => part !== "")
    .join("\n");
  return title ? `Phiên: ${title}\n${body}` : body;
}

function continuePrompt(input: ReplyInput): string {
  const pace = input.brief?.topic && !input.brief.last ? `Lượt ${input.brief.turn}/${input.brief.limit} của hồ sơ: ${input.brief.topic}` : "";
  return [
    scopeBlock(input, false),
    accessPrompt(input.access),
    formatHistory(input),
    pace,
    briefTail(input),
    `Hãy trả lời ${input.peerName}. Chỉ viết nội dung sẽ gửi, cùng ngôn ngữ với tin trên.`,
  ]
    .filter((part) => part !== "")
    .join("\n");
}

function scopeBlock(input: ReplyInput, full: boolean): string {
  const work = input.workDir?.trim() ?? "";
  const skill = input.skillDir?.trim() ?? "";
  const lines: string[] = [];
  if (input.confine && work) {
    lines.push(
      full
        ? [
            `Thư mục làm việc đã đăng ký: ${work}`,
            "- Agent máy khác chỉ được nhờ việc bằng file và lệnh trong thư mục này hoặc thư mục con.",
            "- Không cd ra ngoài, không đọc ổ đĩa khác, không dùng đường dẫn tuyệt đối bên ngoài thư mục đã đăng ký. Nếu yêu cầu cần chỗ khác, từ chối và nói giới hạn này.",
          ].join("\n")
        : skill
          ? `Chỉ dùng thư mục làm việc ${work}. Được đọc skill tại ${skill}. Từ chối việc bên ngoài hai chỗ này.`
          : `Chỉ dùng thư mục làm việc ${work}. Từ chối việc bên ngoài thư mục này.`,
    );
  }
  if (!full) {
    if (!input.confine && skill) lines.push(`Đọc skill tại ${skill} khi làm yêu cầu của máy khác.`);
    return lines.filter(Boolean).join("\n");
  }
  if (skill && input.skills?.trim()) {
    lines.push(`Thư mục skill của runtime này: ${skill}`);
    lines.push(
      input.confine
        ? "- Trước khi làm yêu cầu của máy khác, đọc skill phù hợp trong thư mục skill và làm theo skill đó. Được đọc thư mục skill. Việc ghi file vẫn nằm trong thư mục làm việc."
        : "- Trước khi làm yêu cầu của máy khác, đọc skill phù hợp trong thư mục skill và làm theo skill đó.",
    );
    lines.push(input.skills.trim());
  } else if (skill) {
    lines.push(`Thư mục skill đã cài (${skill}) nhưng chưa đọc được. Không bịa skill.`);
  }
  return lines.filter(Boolean).join("\n");
}

function mountedSkill(input: ReplyInput, workDir: string): string {
  const skill = input.skillDir?.trim() ?? "";
  if (!skill) return "";
  try {
    if (!fs.statSync(skill).isDirectory()) return "";
  } catch {
    return "";
  }
  if (insideDir(workDir, skill)) return "";
  return skill;
}

function withAddedDir(args: string[], skill: string): string[] {
  if (args[0] !== "-p" || args.length < 2) return args;
  return [args[0], args[1], "--add-dir", skill, ...args.slice(2)];
}

function uniqueAttempts(rows: string[][]): string[][] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = row.join("\0");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatHistory(input: ReplyInput): string {
  return input.history
    .map((turn) => {
      if (turn.role === "note") return turn.text;
      const who = turn.speaker || (turn.role === "user" ? input.peerName : input.selfName);
      return `${who}: ${turn.text}`;
    })
    .join("\n");
}

function readingBlock(input: ReplyInput): string {
  const readings = (input.readings ?? [])
    .map((file) => {
      const excerpt = file.excerpt?.trim().slice(0, 800);
      return `- ${file.name} (${file.kind}): ${file.path}${excerpt ? `\n${excerpt}` : ""}`;
    })
    .join("\n");
  return readings ? `File context trên máy này:\n${readings}` : "";
}

function relayLine(input: ReplyInput): string {
  if (!input.fileRelay) return "";
  const place = input.confine ? "File phải nằm trong thư mục làm việc. " : "";
  return `- Để gửi file cho ${input.peerName}, không copy sang ổ đĩa máy kia và không dùng đường UNC. ${place}Chạy: curl.exe -s -H "Content-Type: text/plain; charset=utf-8" --data-binary "ĐƯỜNG_DẪN_ĐẦY_ĐỦ" ${input.fileRelay.url} . Khi kết quả có ok, file đã tới thư mục làm việc của ${input.peerName}.`;
}

function bindArgs(args: string[], session: SessionBind | undefined): string[] {
  if (!session?.id) return args;
  if (session.kind === "claude") {
    if (args[0] !== "-p" || args.length < 2) return args;
    const flag = session.resume ? ["--resume", session.id] : ["--session-id", session.id];
    return [args[0], args[1], ...flag, ...args.slice(2)];
  }
  if (!session.resume) return args;
  const prompt = args[args.length - 1];
  const head = args.slice(0, -1);
  if (session.kind === "cursor") return [...head, `--resume=${session.id}`, prompt];
  if (session.kind === "codex" && head[0] === "exec") return ["exec", "resume", ...head.slice(1), session.id, prompt];
  return args;
}

function isLostSession(detail: string, sessionId: string, streamed: string): boolean {
  if (streamed.trim()) return false;
  if (sessionId && detail.includes(sessionId)) return true;
  return /no conversation found|unable to resume|failed to resume|could not resume|cannot resume|unknown session|no session found|session does not exist|no rollout found|thread not found/i.test(detail);
}

function sessionIdOf(event: unknown): string {
  if (!event || typeof event !== "object") return "";
  const record = event as { session_id?: unknown; thread_id?: unknown; type?: unknown };
  if (typeof record.session_id === "string" && record.session_id.trim()) return record.session_id.trim().slice(0, 80);
  if (record.type === "thread.started" && typeof record.thread_id === "string" && record.thread_id.trim()) {
    return record.thread_id.trim().slice(0, 80);
  }
  return "";
}

function briefLead(input: ReplyInput): string {
  const brief = input.brief;
  if (!brief?.topic) return "";
  const goal = brief.goal || "Chốt một kết luận ngắn mà cả hai cùng chấp nhận.";
  const pace = brief.last
    ? "Đây là lượt cuối. Chỉ viết khối bắt đầu bằng dòng KẾT QUẢ, đúng cấu trúc kết quả mong muốn. Không mở ý mới."
    : "Bàn trong phạm vi chủ đề và file context. Tiến về kết quả mong muốn. Nói rõ chỗ còn lệch.";
  return [
    `Hồ sơ dự án, dùng chung cho ${input.together ?? "cả hai"} agent:`,
    `Chủ đề: ${brief.topic}`,
    `Kết quả mong muốn:\n${goal}`,
    `Lượt agent này: ${brief.turn}/${brief.limit}.`,
    pace,
    "",
  ].join("\n");
}

function briefTail(input: ReplyInput): string {
  if (!input.brief?.last) return "";
  return "Lượt cuối: bắt đầu câu trả lời bằng dòng KẾT QUẢ.";
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
    path.join(os.homedir(), ".codex"),
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

function codexAgentText(event: unknown): string {
  if (!event || typeof event !== "object") return "";
  const record = event as { type?: string; item?: { type?: string; text?: string; content?: string } };
  if (record.type !== "item.completed" && record.type !== "item.updated") return "";
  if (record.item?.type !== "agent_message") return "";
  if (typeof record.item.text === "string" && record.item.text) return record.item.text;
  if (typeof record.item.content === "string") return record.item.content;
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
  const reply = input.brief?.last
    ? `KẾT QUẢ\n${input.brief.goal || input.brief.topic}`
    : `Echo của ${input.selfName} đã nhận từ ${input.peerName}: ${incoming}`;
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
