import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { accessAnnounce, accessPrompt, AccessDenied, defaultAccess, deniedRoles, toolBlob } from "../shared/access";
import { DECISION_END, DECISION_HEADING, DECISION_MARK } from "../shared/brief";
import { codingRoleDuty, type CodingRole } from "../shared/group";
import type { ProviderId, Settings } from "../shared/types";
import { cliLaunchFile, findExecutable } from "./cliDetect";
import { codingSteps, type CodingStep } from "../shared/codingLive";
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
  coding?: boolean;
  codingRole?: CodingRole;
  resultFile?: string;
  workDir?: string;
  confine?: boolean;
  skillDir?: string;
  skillDirs?: string[];
  skills?: string;
  access?: string[] | null;
  granted?: string[] | null;
  announceAccess?: boolean;
  room?: { title: string; members: string };
  together?: string;
  replyTo?: { name: string; boss: boolean; called?: string[] };
  summary?: { title: string; sessionId: string };
  resume?: boolean;
  sessionId?: string;
  sessionTitle?: string;
  onTool?: (info: { sessionId: string; steps: CodingStep[] }) => void;
  onTask?: (sessionId: string) => void;
};

export type AgentResult = { text: string; sessionId: string };

type SessionBind = { id: string; resume: boolean; kind: "claude" | "cursor" | "codex" | "gemini" };

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

export const PROMPT_CACHE_DIR = "prompt-cache";

export function promptCacheDir(dataDir: string): string {
  return path.join(dataDir, PROMPT_CACHE_DIR);
}

export class AgentHost {
  private readonly running = new Map<string, ChildProcess>();
  private readonly resumeOff = new Set<string>();

  constructor(
    private readonly settings: () => Settings,
    private readonly dataDir: string,
  ) {}

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
    if (settings.provider === "gemini-cli") return this.geminiCli(input, settings);
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
    const prompt = this.promptText(input);
    const resume = Boolean(input.resume && input.sessionId);
    const skills = mountedSkills(input, settings.workDir);
    const plain = [
      ["--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-mode", "bypassPermissions", "-p"],
      ["--output-format", "text", "--permission-mode", "bypassPermissions", "-p"],
      ["--output-format", "text", "--permission-mode", "dontAsk", "-p"],
    ];
    const attempts = skills.length ? [...plain.map((args) => withAddedDirs(args, skills)), ...plain] : plain;
    return this.runCli(input, {
      command: settings.claudeCommand || "claude",
      cwd: settings.workDir,
      missing: "Không tìm thấy lệnh claude. Cài Claude Code, rồi chạy `claude auth login` một lần trên máy này.",
      session: { id: resume ? input.sessionId || "" : randomUUID(), resume, kind: "claude" },
      attempts,
      confine: Boolean(input.confine),
      stdin: prompt,
    });
  }

  private cursorCli(input: ReplyInput, settings: Settings): Promise<AgentResult> {
    const prompt = this.promptText(input);
    const resume = Boolean(input.resume && input.sessionId);
    const skills = mountedSkills(input, settings.workDir);
    const confine = Boolean(input.confine);
    const sandbox = confine && cursorSandboxAvailable() ? "enabled" : "disabled";
    const added = skills.flatMap((dir) => ["--add-dir", dir]);
    const locked = (workspace: boolean, skillDir: boolean) => [
      "-p",
      "--trust",
      "--sandbox",
      sandbox,
      ...(workspace ? ["--workspace", settings.workDir] : []),
      ...(skillDir ? added : []),
      "--force",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
    ];
    const open = (skillDir: boolean, stream: boolean) => [
      "-p",
      "--trust",
      "--sandbox",
      "disabled",
      ...(skillDir ? added : []),
      "--force",
      ...(stream ? ["--output-format", "stream-json", "--stream-partial-output"] : []),
    ];
    const attempts = uniqueAttempts(
      confine
        ? [locked(true, true), locked(true, false), locked(false, true), locked(false, false)]
        : [
            open(true, true),
            open(false, true),
            ["-p", "--trust", "--force", ...added],
            ["-p", "--trust", "--force"],
            ["-p", "--trust"],
          ],
    );
    return this.runCli(input, {
      command: settings.cursorCommand || "agent",
      cwd: settings.workDir,
      missing: "Không tìm thấy lệnh agent. Cài Cursor CLI, rồi chạy `agent login` một lần trên máy này.",
      session: { id: input.sessionId || "", resume, kind: "cursor" },
      attempts,
      confine,
      stdin: prompt,
    });
  }

  private codexCli(input: ReplyInput, settings: Settings): Promise<AgentResult> {
    const prompt = this.promptText(input);
    const cwd = settings.workDir;
    const resume = Boolean(input.resume && input.sessionId);
    const confine = Boolean(input.confine);
    const skills = mountedSkills(input, settings.workDir);
    const plain = confine
      ? [
          ["exec", "--json", "--skip-git-repo-check", "--sandbox", "workspace-write", "--cd", cwd],
          ["exec", "--skip-git-repo-check", "--sandbox", "workspace-write", "--cd", cwd],
        ]
      : [
          ["exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "--cd", cwd],
          ["exec", "--json", "--skip-git-repo-check", "--sandbox", "danger-full-access", "--cd", cwd],
          ["exec", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox"],
        ];
    const attempts = skills.length ? [...plain.map((args) => withCodexDirs(args, skills)), ...plain] : plain;
    return this.runCli(input, {
      command: settings.codexCommand || "codex",
      cwd,
      missing: "Không tìm thấy lệnh codex. Cài Codex CLI, rồi chạy `codex login` một lần trên máy này.",
      session: { id: input.sessionId || "", resume, kind: "codex" },
      attempts,
      confine,
      stdin: prompt,
    });
  }

  private geminiCli(input: ReplyInput, settings: Settings): Promise<AgentResult> {
    const prompt = this.promptText(input);
    const resume = Boolean(input.resume && input.sessionId);
    const skills = mountedSkills(input, settings.workDir);
    const attempts = uniqueAttempts([
      geminiArgs("stream-json", "approval", skills, true),
      geminiArgs("stream-json", "approval", [], true),
      geminiArgs("stream-json", "yolo", skills, true),
      geminiArgs("json", "approval", skills, true),
      geminiArgs("json", "yolo", [], false),
      geminiArgs("", "yolo", [], false),
      [],
    ]);
    return this.runCli(input, {
      command: settings.geminiCommand || "gemini",
      cwd: settings.workDir,
      missing: "Không tìm thấy lệnh gemini. Cài Gemini CLI, rồi chạy `gemini` và đăng nhập một lần trên máy này.",
      session: { id: input.sessionId || "", resume, kind: "gemini" },
      attempts,
      confine: Boolean(input.confine),
      stdin: prompt,
    });
  }

  private promptText(input: ReplyInput): string {
    const dir = promptCacheDir(this.dataDir);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${randomUUID()}.gz`);
    fs.writeFileSync(file, zlib.gzipSync(Buffer.from(conversationPrompt(input), "utf8"), { level: 9 }));
    return zlib.gunzipSync(fs.readFileSync(file)).toString("utf8");
  }

  private runCli(
    input: ReplyInput,
    spec: { command: string; cwd: string; missing: string; attempts: string[][]; session?: SessionBind; confine?: boolean; stdin?: string },
  ): Promise<AgentResult> {
    if (!fs.existsSync(spec.cwd)) throw new Error(`Thư mục làm việc không tồn tại: ${spec.cwd}`);
    const command = resolveCommand(spec.command);
    return this.spawnAttempt(input, command, spec.cwd, spec.attempts, 0, spec.missing, spec.session, true, Boolean(spec.confine), spec.stdin);
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
    stdin?: string,
  ): Promise<AgentResult> {
    const raw = attempts[index];
    if (!raw) return Promise.reject(new Error(missing));
    const args = useSession ? bindArgs(raw, session) : raw;
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = launch(command, args, cwd, stdin);
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
      const take = (event: unknown) => {
        const blob = toolBlob(event);
        const found = sessionIdOf(event);
        if (found) {
          capturedSession = found;
          input.onTask?.(found);
        }
        if (blob && input.access !== null) {
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
        if (input.onTool) {
          try {
            const steps = codingSteps(event);
            if (steps.length) input.onTool({ sessionId: capturedSession, steps });
          } catch {
            /* sự kiện tool lạ không chặn lượt chat */
          }
        }
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
        const gemini = geminiAgentText(event);
        if (gemini?.mode === "delta") {
          if (gemini.text) {
            streamed += gemini.text;
            input.onDelta(gemini.text);
          }
          return;
        }
        if (gemini?.mode === "full") {
          if (streamed && !gemini.text.startsWith(streamed)) return;
          finalText = gemini.text;
          const extra = gemini.text.slice(streamed.length);
          if (extra) {
            streamed = gemini.text;
            input.onDelta(extra);
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
      };
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
        lineBuf = consumeLines(lineBuf, chunk, take);
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (err) => {
        this.running.delete(input.peerId);
        input.signal.removeEventListener("abort", onAbort);
        if (blocked) return;
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          const wrapped = new Error(missing);
          wrapped.cause = err;
          reject(wrapped);
          return;
        }
        reject(err);
      });
      child.on("close", (code) => {
        this.running.delete(input.peerId);
        input.signal.removeEventListener("abort", onAbort);
        const tail = lineBuf.trim();
        if (tail.startsWith("{")) {
          try {
            take(JSON.parse(tail));
          } catch {
            /* dòng cuối không phải JSON */
          }
        }
        if (blocked) return;
        if (input.signal.aborted) {
          reject(abortError());
          return;
        }
        const blob = readGeminiBlob(stdout);
        if (!capturedSession && blob.sessionId) capturedSession = blob.sessionId;
        const text = (finalText || streamed || blob.response || plainText(stdout)).trim();
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
          this.spawnAttempt(input, command, cwd, attempts, index, missing, session, false, confine, stdin).then(resolve, reject);
          return;
        }
        const sandboxMissing = /sandbox mode is enabled but not available|sandbox requires macos or linux/i.test(detail);
        if ((badFlag || sandboxMissing) && index + 1 < attempts.length) {
          this.spawnAttempt(input, command, cwd, attempts, index + 1, missing, session, useSession, confine, stdin).then(resolve, reject);
          return;
        }
        if (badFlag && confine && /sandbox/i.test(detail)) {
          reject(new Error("CLI không nhận sandbox, nên giới hạn thư mục làm việc chưa được bật. Cập nhật CLI hoặc bỏ chọn ô giới hạn."));
          return;
        }
        const message = stderr.trim() || stdout.trim();
        const exit = typeof code === "number" ? `Mã thoát ${code}` : "CLI dừng trước khi trả mã thoát";
        const body = message || `${exit}. ${missing}`;
        reject(new Error(body.includes(exit) ? body : `${body}\n${exit}`));
      });
    });
  }
}

function conversationPrompt(input: ReplyInput): string {
  if (input.summary) return summaryPrompt(input);
  if (input.resume) return continuePrompt(input);
  const title = input.sessionTitle?.replace(/\s+/g, " ").trim();
  const body = [
    briefLead(input),
    castLine(input),
    scopeBlock(input, true),
    accessPrompt(input.access),
    accessTurn(input),
    "Quy tắc:",
    "- Mỗi máy có một người dùng và một agent riêng. Bạn chỉ là agent của máy mình, không phải người dùng đó và không phải một người chung của cả đoạn chat.",
    "- @Tên gọi agent của máy mang tên đó. @me gọi agent của chính máy đã gửi tin.",
    "- Chỉ gửi câu trả lời cho người vừa gọi mình. Hội thoại phía dưới vẫn là cả chủ đề, gồm lời của mọi agent. Hãy đọc và bám phần đó, không bỏ người không được tag.",
    "- Không gắn @ vào câu trả lời chỉ để đáp lại. Chỉ @ khi cần gọi thêm một agent khác.",
    "- Không mở đầu bằng việc nhắc lại các quy tắc này. Khối QUYỀN ở lượt đầu chủ đề là nội dung gửi đi.",
    input.coding
      ? input.room
        ? "- Viết mô tả ảnh hưởng bằng Markdown, đủ ý. Không giới hạn số từ. Chỉ làm đúng vai đã giao."
        : "- Viết mô tả ảnh hưởng bằng Markdown, đủ ý. Không giới hạn số từ. Chỉ sửa code trên máy này."
      : "- Dùng cùng ngôn ngữ với tin nhắn cuối. Giữ câu trả lời trong khoảng 500 từ, trừ khi đang tóm tắt file hoặc đang viết khối KẾT QUẢ.",
    "- Bám các lượt trước. Không bịa việc máy kia đã làm.",
    input.confine
      ? `- Nếu ${askerName(input)} nhờ một việc trên máy này, chỉ làm trong thư mục làm việc đã đăng ký rồi nói kết quả. Lệnh và sửa file trong thư mục đó được tự chạy, không hỏi lại.`
      : `- Nếu ${askerName(input)} nhờ một việc trên máy này, hãy làm rồi nói kết quả. Lệnh và sửa file được tự chạy, không hỏi lại.`,
    input.coding
      ? input.room
        ? "- Chỉ sửa file và chạy lệnh khi việc đó thuộc đúng vai của mình. Không làm việc của vai khác. Không gửi file cho nhóm khi việc chưa xong."
        : "- Được sửa file và chạy lệnh trong thư mục làm việc của máy này. Không gửi file cho máy kia khi việc chưa xong."
      : "- Nếu đối phương chỉ trò chuyện, chỉ trả lời bằng lời. Không chạy lệnh và không sửa file. Riêng khi họ nhờ gửi file thì dùng đúng lệnh gửi file bên dưới.",
    "- Nếu có file trong hồ sơ hoặc file đính kèm, hãy đọc đúng file tại đường dẫn trên máy này. txt, md và csv có thể đã có đoạn trích; ảnh, pdf, docx và excel phải mở file khi đoạn trích trống hoặc chưa đủ. Không bịa phần chưa đọc được.",
    relayLine(input),
    "",
    "Hội thoại:",
    formatHistory(input),
    readingBlock(input),
    "",
    briefTail(input),
    skillBlock(input),
    replyCue(input),
  ]
    .filter((part) => part !== "")
    .join("\n");
  return title ? `Phiên: ${title}\n${body}` : body;
}

function summaryPrompt(input: ReplyInput): string {
  const meta = input.summary;
  return [
    "Bạn là agent của máy này. Hãy tóm tắt phiên làm việc sau thành Markdown.",
    meta ? `Phiên: ${meta.title}` : "",
    meta ? `Session ID: ${meta.sessionId}` : "",
    "Chỉ viết Markdown. Không chạy lệnh, không sửa file, không gọi tool.",
    "Viết bằng tiếng Việt. Gồm mục tiêu, việc đã làm, quyết định và việc còn mở. Giữ tên người và agent như trong hội thoại.",
    "Mở đầu bằng tiêu đề phiên. Ghi session ID trên một dòng riêng để người dùng chép lại.",
    "",
    "Hội thoại:",
    input.history.map((turn) => turn.text).join("\n"),
  ]
    .filter((part) => part !== "")
    .join("\n");
}

function continuePrompt(input: ReplyInput): string {
  const pace = input.brief?.topic && !input.brief.last ? `Lượt ${input.brief.turn}/${input.brief.limit} của hồ sơ: ${input.brief.topic}` : "";
  return [
    scopeBlock(input, false),
    accessPrompt(input.access),
    accessTurn(input),
    input.coding ? codingPace(input) : "",
    formatHistory(input),
    pace,
    briefTail(input),
    skillBlock(input),
    input.coding
      ? input.room
        ? `${replyCue(input)} Viết mô tả ảnh hưởng bằng Markdown, không giới hạn số từ. Chỉ làm đúng vai của mình.`
        : `${replyCue(input)} Viết mô tả ảnh hưởng bằng Markdown, không giới hạn số từ. Chỉ sửa code trên máy này.`
      : `${replyCue(input)} Chỉ viết nội dung sẽ gửi, cùng ngôn ngữ với tin trên, trong khoảng 500 từ.`,
  ]
    .filter((part) => part !== "")
    .join("\n");
}

function scopeBlock(input: ReplyInput, full: boolean): string {
  const work = input.workDir?.trim() ?? "";
  const lines: string[] = [];
  if (input.confine && work) {
    lines.push(
      full
        ? [
            `Thư mục làm việc đã đăng ký: ${work}`,
            "- Agent máy khác chỉ được nhờ việc bằng file và lệnh trong thư mục này hoặc thư mục con.",
            "- Không cd ra ngoài và không dùng đường dẫn tuyệt đối bên ngoài thư mục đã đăng ký, trừ file skill đã liệt kê ở cuối. Việc ghi file vẫn nằm trong thư mục làm việc.",
          ].join("\n")
        : `Chỉ dùng thư mục làm việc ${work}. Được đọc các file skill đã liệt kê. Từ chối việc bên ngoài những chỗ này.`,
    );
  }
  return lines.filter(Boolean).join("\n");
}

function skillBlock(input: ReplyInput): string {
  const catalog = input.skills?.trim() ?? "";
  if (catalog) {
    return [
      "Skill của dự án này, kể cả skill nằm trong thư mục con. Khi việc khớp mô tả, đọc đúng file rồi làm theo. Không bịa bước chưa đọc.",
      catalog,
    ].join("\n");
  }
  const chosen = input.skillDir?.trim() ?? "";
  return chosen ? `Thư mục skill đã chọn (${chosen}) không có SKILL.md. Không bịa skill.` : "";
}

function cursorSandboxAvailable(): boolean {
  return process.platform === "darwin" || process.platform === "linux";
}

function mountedSkills(input: ReplyInput, workDir: string): string[] {
  const source = input.skillDirs?.length ? input.skillDirs : input.skillDir ? [input.skillDir] : [];
  const dirs: string[] = [];
  const seen = new Set<string>();
  for (const dir of source) {
    const skill = dir.trim();
    if (!skill) continue;
    let resolved = "";
    try {
      if (!fs.statSync(skill).isDirectory()) continue;
      resolved = path.resolve(skill);
    } catch {
      continue;
    }
    if (insideDir(workDir, resolved)) continue;
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    dirs.push(resolved);
  }
  return dirs;
}

function withAddedDirs(args: string[], dirs: string[]): string[] {
  if (!dirs.length) return args;
  const extra = dirs.flatMap((dir) => ["--add-dir", dir]);
  if (args[0] === "-p" && args.length >= 2) return [args[0], args[1], ...extra, ...args.slice(2)];
  if (args[args.length - 1] === "-p") return [...args.slice(0, -1), ...extra, "-p"];
  return args;
}

function withCodexDirs(args: string[], dirs: string[]): string[] {
  if (!dirs.length) return args;
  return [...args, ...dirs.flatMap((dir) => ["--add-dir", dir])];
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

function castLine(input: ReplyInput): string {
  const self = `${input.selfName} · agent`;
  if (input.room) {
    return `Bạn là ${self}, agent của ${input.selfName}. Nhóm "${input.room.title}" gồm các cặp người dùng và agent của họ: ${input.room.members}. Mỗi người chỉ nói với agent của mình hoặc với agent mà họ gọi. Bạn không phải ${input.selfName} và không phải người chung của cả nhóm.`;
  }
  return `Bạn là ${self}, agent của ${input.selfName}. Đoạn chat này có hai cặp: ${input.selfName} với ${self}, và ${input.peerName} với ${input.peerName} · agent. Bạn không phải ${input.selfName} và không phải người chung của cả đoạn chat.`;
}

function askerName(input: ReplyInput): string {
  return input.replyTo?.name || input.peerName;
}

function replyCue(input: ReplyInput): string {
  const target = input.replyTo?.name || input.peerName;
  const called = input.replyTo?.called ?? [];
  const scope = called.length
    ? called.length === 1
      ? "Câu này chỉ tag 1 agent, là bạn. Chỉ bạn gửi câu trả lời, không gửi cho những người khác. Vẫn dùng cả chủ đề và lời của mọi agent làm ngữ cảnh."
      : `Câu này tag đúng ${called.length} agent: ${called.join(", ")}. Chỉ ${called.length} agent này trả lời. Bạn là một trong số đó. Đừng nói hộ agent khác. Vẫn dùng cả chủ đề và lời của mọi agent làm ngữ cảnh.`
    : "";
  const cue = input.replyTo?.boss && !input.brief?.last
    ? `Hãy trả lời ${input.selfName}. Mở đầu bằng "Thưa sếp".`
    : input.replyTo?.name.endsWith(" · agent")
      ? `Hãy trả lời ${target}. Đây là một agent, không phải người dùng của agent đó.`
      : `Hãy trả lời ${target}.`;
  return scope ? `${scope} ${cue}` : cue;
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
  return `- Để gửi file cho ${input.peerName}, không copy sang ổ đĩa máy kia và không dùng đường UNC. ${place}Chạy: curl.exe --silent -H "Content-Type: text/plain; charset=utf-8" --data-binary "ĐƯỜNG_DẪN_ĐẦY_ĐỦ" ${input.fileRelay.url} . Khi kết quả có ok, file đã tới thư mục làm việc của ${input.peerName}.`;
}

function bindArgs(args: string[], session: SessionBind | undefined): string[] {
  if (!session?.id) return args;
  if (session.kind === "claude") {
    const flag = session.resume ? ["--resume", session.id] : ["--session-id", session.id];
    if (args[args.length - 1] === "-p" && args[0] !== "-p") return [...args.slice(0, -1), ...flag, "-p"];
    if (args[0] !== "-p" || args.length < 2) return args;
    return [args[0], args[1], ...flag, ...args.slice(2)];
  }
  if (!session.resume) return args;
  if (session.kind === "cursor") return [...args, `--resume=${session.id}`];
  if (session.kind === "codex" && args[0] === "exec") return ["exec", "resume", ...args.slice(1), session.id];
  if (session.kind === "gemini") return ["--resume", session.id, ...args];
  return args;
}

function isLostSession(detail: string, sessionId: string, streamed: string): boolean {
  if (streamed.trim()) return false;
  if (sessionId && detail.includes(sessionId)) return true;
  return /no conversation found|unable to resume|failed to resume|could not resume|cannot resume|unknown session|no sessions found|no session found|session does not exist|no matching session|could not find session|failed to load session|no rollout found|thread not found/i.test(detail);
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

function accessTurn(input: ReplyInput): string {
  if (!input.brief?.topic) return "";
  const granted = input.granted ?? input.access;
  const card = accessAnnounce(input.selfName, granted);
  if (!card) return "";
  if (input.announceAccess) {
    return [
      "Lượt đầu của máy này trong chủ đề: mở đầu câu trả lời bằng đúng khối sau, rồi mới bàn việc. Giữ nguyên tiêu đề và hai dòng Được/Không. Không thêm quyền. Khối này không tính vào hạn 500 từ.",
      card,
      "Không yêu cầu agent khác làm việc họ đã ghi ở mục Không. Nếu họ chưa nêu khối quyền, chỉ bàn luận, chưa giao việc trên máy họ.",
    ].join("\n");
  }
  if (input.brief.turn > 1) return "Quyền mỗi máy đã nêu ở đầu chủ đề. Không yêu cầu máy khác làm việc nằm trong mục Không của máy đó. Không lặp lại khối quyền của mình.";
  return "";
}

function briefLead(input: ReplyInput): string {
  const brief = input.brief;
  if (!brief?.topic) return "";
  const goal = brief.goal || (input.coding ? "Hoàn thành việc đúng vai và chốt một tài liệu chung." : "Chốt một kết luận ngắn mà cả hai cùng chấp nhận.");
  const pace = input.coding
    ? codingPace(input)
    : brief.last
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
  if (input.coding) {
    if (!input.brief?.last) return "";
    return "Lượt cuối: nếu xong thì bắt đầu bằng dòng KẾT QUẢ và ghi file chung; nếu chưa xong thì bắt đầu bằng dòng CẦN THÊM: N.";
  }
  if (!input.brief?.last) return "";
  return "Lượt cuối: bắt đầu câu trả lời bằng dòng KẾT QUẢ.";
}

function codingPace(input: ReplyInput): string {
  const file = input.resultFile?.trim();
  const last = Boolean(input.brief?.last);
  const duty = input.room
    ? codingRoleDuty(input.codingRole)
    : "Chế độ coding 1-1. Bạn và agent máy kia cùng làm chủ đề. Bạn chỉ sửa code trong thư mục làm việc của máy này, rồi mô tả phần đã làm và ảnh hưởng bằng Markdown.";
  return [
    duty,
    `Không dừng lại hỏi người. Khi phân vân (yêu cầu chưa rõ, có nhiều cách làm), tự chọn cách hợp lý nhất rồi ghi lại trong câu trả lời bằng khối: dòng ${DECISION_MARK}; mỗi điểm một mục "- Phân vân: …", kèm "Phương án: …", "Chọn: …", "Lý do: …"; kết thúc bằng dòng ${DECISION_END}.`,
    `File kết quả và khối KẾT QUẢ phải có mục "## ${DECISION_HEADING}": gom mọi điểm ${DECISION_MARK} của tất cả agent trong hội thoại, mỗi điểm ghi điểm phân vân, các phương án, đã chọn gì, lý do, ai chốt. Không có điểm nào thì ghi rõ là không có.`,
    file
      ? input.room
        ? `Khi toàn bộ việc đã xong, ghi một file Markdown chung tại ${file}. Trước đó không tạo file chung và không gửi file cho nhóm. File code đúng vai của mình vẫn được ghi trong thư mục làm việc.`
        : `Khi toàn bộ việc đã xong, ghi một file Markdown chung tại ${file}. Trước đó không tạo file chung và không gửi file cho máy kia. File code của máy này vẫn được ghi trong thư mục làm việc.`
      : input.room
        ? "Trước khi toàn bộ việc xong, không tạo file chung và không gửi file cho nhóm."
        : "Trước khi toàn bộ việc xong, không tạo file chung và không gửi file cho máy kia.",
    last
      ? "Đây là lượt cuối của hạn mức. Nếu việc đã xong, bắt đầu bằng dòng KẾT QUẢ rồi ghi file chung. Nếu chưa xong, không viết KẾT QUẢ và không tạo file chung. Bắt đầu bằng đúng dòng CẦN THÊM: N, N là số nguyên lượt còn cần để hoàn thành, rồi nêu phần còn thiếu."
      : "Nếu toàn bộ việc đã xong ở lượt này, bắt đầu bằng dòng KẾT QUẢ và ghi file chung. Nếu chưa xong, mô tả ảnh hưởng bằng Markdown, đủ ý, không giới hạn số từ. Không viết KẾT QUẢ và không tạo file chung.",
  ].join("\n");
}

function launch(command: string, args: string[], cwd: string, stdinText?: string): ChildProcess {
  const env = cliEnv();
  const file = cliLaunchFile(command);
  const stdio = stdinText !== undefined ? (["pipe", "pipe", "pipe"] as const) : (["ignore", "pipe", "pipe"] as const);
  const cursor = cursorRuntime(file);
  if (cursor) env.CURSOR_INVOKED_AS = "agent";
  const runtime = cursor ?? scriptRuntime(file, env);
  let child: ChildProcess;
  if (runtime) {
    child = spawn(runtime.node, [runtime.index, ...args], {
      cwd,
      env,
      windowsHide: true,
      shell: false,
      stdio: [...stdio],
    });
  } else {
    const safeArgs = args.map((arg) => arg.replace(/\s+/g, " ").trim());
    if (process.platform === "win32" && /\.(cmd|bat)$/i.test(file)) {
      const comspec = process.env.ComSpec || "cmd.exe";
      const line = [file, ...safeArgs].map(quoteCmd).join(" ");
      child = spawn(comspec, ["/d", "/s", "/c", line], {
        cwd,
        env,
        windowsHide: true,
        stdio: [...stdio],
      });
    } else {
      child = spawn(file, safeArgs, {
        cwd,
        env,
        windowsHide: true,
        shell: false,
        stdio: [...stdio],
      });
    }
  }
  if (stdinText !== undefined && child.stdin) {
    child.stdin.on("error", () => undefined);
    child.stdin.end(stdinText, "utf8");
  }
  return child;
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

function scriptRuntime(command: string, env: NodeJS.ProcessEnv): { node: string; index: string } | null {
  if (process.platform !== "win32" || !/\.(cmd|bat)$/i.test(command) || !fs.existsSync(command)) return null;
  let text = "";
  try {
    text = fs.readFileSync(command, "utf8");
  } catch {
    return null;
  }
  const dir = path.dirname(path.resolve(command));
  const root = /[\\/]$/.test(dir) ? dir : `${dir}\\`;
  const expand = (token: string) => token.replace(/%~dp0\\?/gi, root).replace(/%dp0%\\?/gi, root);
  const jsMatch = text.match(/["']([^"']+\.js)["']/i);
  if (!jsMatch) return null;
  const index = path.normalize(expand(jsMatch[1]));
  if (!fs.existsSync(index)) return null;
  const bundled = [...text.matchAll(/["']([^"']*node\.exe)["']/gi)]
    .map((match) => path.normalize(expand(match[1])))
    .find((file) => fs.existsSync(file));
  const node = bundled || nodeOnPath(env);
  if (!node) return null;
  return { node, index };
}

function nodeOnPath(env: NodeJS.ProcessEnv): string | null {
  const listed = env.PATH || env.Path || "";
  for (const dir of listed.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "node.exe");
    if (fs.existsSync(candidate)) return candidate;
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
    path.join(os.homedir(), ".gemini", "bin"),
  ].filter((dir) => dir && fs.existsSync(dir));
  const current = env.PATH || env.Path || "";
  const next = [...prefix, current].filter(Boolean).join(path.delimiter);
  env.PATH = next;
  env.Path = next;
  return env;
}

function resolveCommand(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return trimmed;
  if (path.isAbsolute(trimmed) || trimmed.includes(path.sep) || trimmed.includes("/")) {
    return fs.existsSync(trimmed) ? cliLaunchFile(trimmed) : trimmed;
  }
  return findExecutable(trimmed) ?? trimmed;
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

function geminiArgs(
  format: "stream-json" | "json" | "",
  mode: "approval" | "yolo" | "none",
  dirs: string[],
  trust: boolean,
): string[] {
  const args: string[] = [];
  if (format) args.push("--output-format", format);
  if (mode === "approval") args.push("--approval-mode", "yolo");
  if (mode === "yolo") args.push("--yolo");
  if (trust) args.push("--skip-trust");
  for (const dir of dirs) args.push("--include-directories", dir);
  return args;
}

function geminiAgentText(event: unknown): { mode: "delta" | "full"; text: string } | null {
  if (!event || typeof event !== "object") return null;
  const record = event as { type?: string; role?: string; content?: unknown; delta?: boolean; response?: unknown };
  if (!record.type && typeof record.response === "string" && record.response) return { mode: "full", text: record.response };
  if (record.type !== "message" || (record.role !== "assistant" && record.role !== "model")) return null;
  const text = joinedText(record.content);
  if (!text) return null;
  return record.delta ? { mode: "delta", text } : { mode: "full", text };
}

function joinedText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") return (part as { text: string }).text;
      return "";
    })
    .join("");
}

function readGeminiBlob(stdout: string): { response: string; sessionId: string } {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return { response: "", sessionId: "" };
  try {
    const parsed = JSON.parse(trimmed) as { response?: unknown; session_id?: unknown };
    return {
      response: typeof parsed.response === "string" ? parsed.response.trim() : "",
      sessionId: typeof parsed.session_id === "string" ? parsed.session_id.trim().slice(0, 80) : "",
    };
  } catch {
    return { response: "", sessionId: "" };
  }
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
  const from = input.replyTo?.name || input.peerName;
  const reply = input.summary
    ? echoSummary(input)
    : input.brief?.last
    ? `KẾT QUẢ\n${input.brief.goal || input.brief.topic}`
    : input.replyTo?.boss
      ? `Thưa sếp, echo của ${input.selfName} đã nhận: ${incoming}`
      : `Echo của ${input.selfName} đã nhận từ ${from}: ${incoming}`;
  const size = 12;
  for (let i = 0; i < reply.length; i += size) {
    if (input.signal.aborted) throw abortError();
    input.onDelta(reply.slice(i, i + size));
    await delay(16);
  }
  return reply;
}

function echoSummary(input: ReplyInput): string {
  const rows = input.history
    .map((turn) => turn.text)
    .join("\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-12);
  const bullets = rows.map((row) => `- ${row}`).join("\n");
  const title = input.summary?.title || "Phiên";
  const id = input.summary?.sessionId || "";
  return `## Tóm tắt phiên ${title}\n\nSession ID: \`${id}\`\n\n${bullets}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function abortError(): Error {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}
