import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { Server, type Socket } from "socket.io";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import {
  BRIEF_EXTEND,
  BRIEF_FILE_MAX,
  BRIEF_GOAL_CAP,
  BRIEF_TOPIC_CAP,
  BRIEF_TURN_MAX,
  CODING_RESULT_FILE,
  CODING_TURN_DEFAULT,
  CODING_TURN_MAX,
  clampTurnLimit,
  codingNeed,
  decisionBlocks,
  decisionSection,
  emptyBrief,
  hasDecisionSection,
  reportFileName,
  reportNumber,
  resultText,
  runReportMarkdown,
  runStatusText,
  sanitizeBrief,
  TOPIC_QUEUE_MAX,
  type DecisionEntry,
  type ProjectBrief,
  type RunStatus,
} from "../shared/brief";
import {
  GROUP_MAX,
  codingRole,
  codingRoleLabel,
  codingSpeakOrder,
  groupKey,
  injectSpeakers,
  mentionTargets,
  rewriteMentionLabels,
  withAliases,
  withSelfAlias,
  nextTicket,
  parseGroupKey,
  sanitizeMembers,
  sanitizeTicket,
  speakOrder,
  ticketFrom,
  type GroupMember,
  type GroupRoom,
  type MentionRef,
  type TurnTicket,
} from "../shared/group";
import type {
  ActivityPatch,
  AppState,
  ChatLine,
  ChatSession,
  CliReport,
  DiscussFile,
  HelloAck,
  HelloPayload,
  LinkStatus,
  PeerActivity,
  PeerView,
  ProviderId,
  Settings,
  WireBrief,
  WireChat,
  WireDelta,
  WireGroup,
  WireGroupTurn,
  WireResume,
} from "../shared/types";
import { DEFAULT_PORT, PORT_SPAN, cliClientLabel, providerLabel } from "../shared/types";
import { AccessDenied, deniedRoles, denialText, latestRequest } from "../shared/access";
import { AgentHost, CliResumeUnsupported, CliSessionLost, type ModelTurn } from "./agents";
import { CodingWatch, type CodingTrace } from "./codingTerm";
import { parseCodingLog, type CodingLive, type CodingStep } from "../shared/codingLive";
import { detectLocalClis, installedCliList, parseCliList } from "./cliDetect";
import { Discovery, lanIPv4, normalizeIp } from "./discovery";
import { briefFolder, configuredSkillDir, fileNameFromHeader, formatBytes, MAX_FILE_BYTES, projectSkillRoots, readFileLimited, resolveInside, safeFileName, saveExact, saveReceivedFile, skillCatalog } from "./files";
import { allowPreview } from "./preview";
import { discussExcerpt, discussKind, isDiscussKind } from "../shared/discuss";
import { fileRef, type FileRef } from "../shared/preview";
import { bearer, listen, readBody, readJson, remoteIp, sendJson } from "./httpUtil";
import { Store, sanitizeSettings } from "./store";

type BriefRun = {
  sessionId: string;
  startedAt: number;
  before: Set<string>;
  topic: string;
  goal: string;
  coding: boolean;
  baseLimit: number;
};

const RUN_SETTLE_MS = 1500;
const MAX_LINES = 200;
const SEEN_LIMIT = 500;
const DIALOGUE_CAP = 8;
const LINE_CAP = 8000;

type Endpoint = {
  name: string;
  host: string;
  port: number;
  provider: string;
  viaLocalhost: boolean;
  discovered: boolean;
  lastSeen: number;
};

type LiveSocket = Socket | ClientSocket;

export class AppCore {
  readonly store: Store;
  private readonly agents: AgentHost;
  private readonly profile: string;
  private readonly sessionAutoAccept: boolean;
  private discovery: Discovery | null = null;
  private server: http.Server | null = null;
  private io: Server | null = null;
  private port = DEFAULT_PORT;
  private readonly endpoints = new Map<string, Endpoint>();
  private readonly inbound = new Map<string, Socket>();
  private readonly outbound = new Map<string, ClientSocket>();
  private readonly pendingHello = new Map<string, Socket>();
  private readonly knockWait = new Map<string, Endpoint>();
  private readonly status = new Map<string, LinkStatus>();
  private readonly epochs = new Map<string, number>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly aborts = new Map<string, AbortController>();
  private readonly codingFileStamp = new Map<string, number>();
  private readonly runs = new Map<string, BriefRun>();
  private readonly codingWatch = new CodingWatch();
  private readonly codingPending = new Map<string, CodingStep>();
  private readonly codingSent = new Map<string, string>();
  private codingFlush: NodeJS.Timeout | null = null;
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private readonly greeted = new Set<string>();
  private readonly manualClose = new Set<string>();
  private readonly linkHost = new Map<string, string>();
  private readonly lastError = new Map<string, string>();
  private readonly deltaTimers = new Map<string, NodeJS.Timeout>();
  private logs: string[] = [];
  private localClis: CliReport = {
    claude: { id: "claude", label: "Claude CLI", installed: false, path: null, loggedIn: null },
    cursor: { id: "cursor", label: "Cursor CLI", installed: false, path: null, loggedIn: null },
    codex: { id: "codex", label: "Codex CLI", installed: false, path: null, loggedIn: null },
    gemini: { id: "gemini", label: "Gemini CLI", installed: false, path: null, loggedIn: null },
  };
  private cliSignature = "";
  private readonly remoteClis = new Map<string, string>();
  private readonly activity = new Map<string, PeerActivity>();
  private readonly activityTimers = new Map<string, NodeJS.Timeout>();
  private readonly replySessions = new Map<string, string>();
  private readonly unread = new Set<string>();
  private readonly noticeAt = new Map<string, number>();
  private watchPeer = "";
  private watchSession = "";
  private windowFocused = false;
  private sweepTimer: NodeJS.Timeout | null = null;
  private scanTimer: NodeJS.Timeout | null = null;
  private cliTimer: NodeJS.Timeout | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private pushTimer: NodeJS.Timeout | null = null;
  private scanning = false;
  onChange: () => void = () => {};
  onNotice: (notice: { peerId: string; sessionId: string; title: string; body: string }) => void = () => {};
  onCodingLive: (event: CodingLive) => void = () => {};

  constructor(profile: string, sessionAutoAccept: boolean) {
    this.profile = profile;
    this.sessionAutoAccept = sessionAutoAccept;
    this.store = new Store(profile);
    this.agents = new AgentHost(() => this.store.settings, path.dirname(this.store.file));
    this.noteClis(detectLocalClis(this.store.settings), false);
    for (const [peerId, trusted] of Object.entries(this.store.trusted)) {
      if (!trusted.host || !trusted.port) continue;
      this.endpoints.set(peerId, {
        name: trusted.name,
        host: trusted.host,
        port: trusted.port,
        provider: trusted.provider || "echo",
        viaLocalhost: trusted.host === "127.0.0.1",
        discovered: false,
        lastSeen: 0,
      });
    }
  }

  async start(): Promise<void> {
    await this.openPort(basePort(this.profile));
    this.discovery = new Discovery(this.store.peerId);
    this.discovery.onLog = (line) => this.log(line);
    this.discovery.onPeer = (sight) => {
      this.remoteClis.set(sight.peerId, parseCliList(sight.clis));
      this.upsertEndpoint(sight.peerId, {
        name: sight.name,
        host: sight.host,
        port: sight.port,
        provider: sight.provider,
        viaLocalhost: false,
        discovered: true,
        lastSeen: sight.lastSeen,
      });
    };
    this.discovery.onLost = (peerId) => {
      const endpoint = this.endpoints.get(peerId);
      if (!endpoint || endpoint.viaLocalhost) return;
      endpoint.discovered = false;
      this.push();
    };
    this.discovery.start(() => ({
      peerId: this.store.peerId,
      name: this.store.settings.name,
      port: this.port,
      provider: this.store.settings.provider,
      host: lanIPv4(),
      clis: installedCliList(this.localClis),
    }));
    this.sweepTimer = setInterval(() => {
      this.discovery?.sweep(8000);
      this.expireEndpoints();
    }, 2000);
    this.scanTimer = setInterval(() => void this.scanLocal(), 3000);
    this.cliTimer = setInterval(() => this.noteClis(detectLocalClis(this.store.settings), false), 20000);
    void this.scanLocal();
    this.log(`Đang nghe ${lanIPv4()}:${this.port}`);
    this.pushNow();
  }

  async stop(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.cliTimer) clearInterval(this.cliTimer);
    for (const timer of this.activityTimers.values()) clearTimeout(timer);
    this.activityTimers.clear();
    for (const timer of this.deltaTimers.values()) clearTimeout(timer);
    this.deltaTimers.clear();
    this.discovery?.stop();
    for (const socket of this.outbound.values()) socket.disconnect();
    this.outbound.clear();
    this.io?.close();
    await new Promise<void>((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
    await this.agents.dispose();
    this.flushSave();
  }

  snapshot(): AppState {
    const now = Date.now();
    const ids = new Set<string>([
      ...this.endpoints.keys(),
      ...Object.keys(this.store.trusted),
      ...Object.keys(this.store.sessions),
      ...this.pendingHello.keys(),
      ...this.knockWait.keys(),
    ]);
    const peers: PeerView[] = [];
    for (const peerId of ids) {
      if (parseGroupKey(peerId)) continue;
      const endpoint = this.endpoints.get(peerId);
      const trusted = this.store.trusted[peerId];
      const discovered = Boolean(endpoint?.discovered && now - endpoint.lastSeen < 10_000);
      const link = this.statusOf(peerId);
      const hasHistory = (this.store.sessions[peerId] ?? []).length > 0;
      if (!discovered && link === "none" && !trusted && !hasHistory) continue;
      peers.push({
        peerId,
        name: endpoint?.name || trusted?.name || "Máy",
        host: endpoint?.host || trusted?.host || "",
        port: endpoint?.port || trusted?.port || 0,
        provider: endpoint?.provider || trusted?.provider || "echo",
        clis: this.remoteClis.get(peerId) ?? "",
        discovered,
        viaLocalhost: Boolean(endpoint?.viaLocalhost),
        status: link,
        token: trusted?.token ?? null,
      });
    }
    peers.sort((a, b) => {
      const byStatus = rankStatus(a.status) - rankStatus(b.status);
      if (byStatus) return byStatus;
      if (a.discovered !== b.discovered) return a.discovered ? -1 : 1;
      return a.name.localeCompare(b.name, "vi");
    });
    return {
      self: {
        peerId: this.store.peerId,
        name: this.store.settings.name,
        profile: this.profile,
        provider: this.store.settings.provider,
        host: lanIPv4(),
        port: this.port,
      },
      settings: this.store.settings,
      localClis: this.localClis,
      activity: Object.fromEntries(this.activity),
      peers,
      sessions: Object.values(this.store.sessions).flat(),
      openSession: { ...this.store.openSessions },
      unreadSessions: [...this.unread],
      transcripts: this.store.transcripts,
      briefs: this.viewBriefs(),
      queues: Object.fromEntries(Object.entries(this.store.topicQueues).map(([sessionId, queue]) => [sessionId, queue.items])),
      groups: this.store.groups.map((room) => ({
        ...room,
        members: room.members.map((member) => this.memberRecord(member)),
      })),
      nicknames: { ...this.store.nicknames },
      logs: [...this.logs],
    };
  }

  locateBriefFile(sessionId: string, name: string): { path: string; preview: FileRef | null } | null {
    const id = sessionId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
    const safe = safeFileName(name);
    if (!id || !safe) return null;
    const folder = path.resolve(briefFolder(this.store.settings.workDir, id));
    const full = path.resolve(folder, safe);
    const rel = path.relative(folder, full);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    if (!fs.existsSync(full)) return null;
    const preview = fileRef(full);
    if (preview) allowPreview(full);
    return { path: full, preview };
  }

  private viewBriefs(): AppState["briefs"] {
    const briefs: AppState["briefs"] = {};
    for (const [sessionId, brief] of Object.entries(this.store.briefs)) {
      const folder = briefFolder(this.store.settings.workDir, sessionId);
      briefs[sessionId] = {
        ...brief,
        files: brief.files.map((file) => {
          const full = path.join(folder, file.name);
          if (!fs.existsSync(full)) return { name: file.name, kind: file.kind, excerpt: file.excerpt };
          if (fileRef(full)) allowPreview(full);
          return { name: file.name, kind: file.kind, excerpt: file.excerpt, path: full };
        }),
      };
    }
    return briefs;
  }

  saveSettings(input: Settings): AppState {
    const prev = this.store.settings;
    const next = sanitizeSettings(input, prev.name);
    this.store.settings = next;
    const runtimeChanged =
      prev.provider !== next.provider ||
      prev.workDir !== next.workDir ||
      prev.claudeCommand !== next.claudeCommand ||
      prev.cursorCommand !== next.cursorCommand ||
      prev.codexCommand !== next.codexCommand ||
      prev.geminiCommand !== next.geminiCommand;
    if (runtimeChanged) void this.agents.dispose();
    if (prev.claudeCommand !== next.claudeCommand || prev.cursorCommand !== next.cursorCommand || prev.codexCommand !== next.codexCommand || prev.geminiCommand !== next.geminiCommand) {
      this.noteClis(detectLocalClis(next), false);
    }
    this.scheduleSave();
    this.log(`Đã lưu cài đặt (${next.provider}).`);
    for (const room of this.store.groups) {
      if (room.hostId === this.store.peerId) this.relay(room, "group", this.wireGroup(room));
    }
    this.pushNow();
    return this.snapshot();
  }

  rescanClis(): AppState {
    this.noteClis(detectLocalClis(this.store.settings), true);
    return this.snapshot();
  }

  async connect(peerId: string): Promise<void> {
    if (peerId === this.store.peerId) return;
    if (this.isLinked(peerId)) return;
    const endpoint = this.endpoints.get(peerId) ?? this.endpointFromTrusted(peerId);
    if (!endpoint?.port || !endpoint.host) throw new Error("Chưa thấy địa chỉ máy này.");
    if (this.store.peerId < peerId) {
      await this.openClient(peerId, endpoint, this.store.peerId);
      return;
    }
    await this.knock(peerId, endpoint);
  }

  async connectAddress(host: string, port: number): Promise<void> {
    const cleanHost = host.trim();
    if (!cleanHost || port < 1 || port > 65535) throw new Error("Địa chỉ không hợp lệ.");
    let body: { peerId?: string; name?: string; provider?: string; port?: number; clis?: string };
    try {
      const res = await fetch(`http://${cleanHost}:${port}/identity`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) throw new Error(`Máy đó trả về HTTP ${res.status}.`);
      body = (await res.json()) as typeof body;
    } catch (err) {
      this.recordError(`gọi ${cleanHost}:${port}`, err, "Không gọi được máy đó.");
      const wrapped = new Error(err instanceof Error ? err.message : "Không gọi được /identity.");
      wrapped.cause = err;
      throw wrapped;
    }
    if (!body.peerId || body.peerId === this.store.peerId) throw new Error("Đó là chính máy này.");
    this.remoteClis.set(body.peerId, parseCliList(body.clis));
    this.upsertEndpoint(
      body.peerId,
      {
        name: body.name || cleanHost,
        host: cleanHost,
        port: body.port || port,
        provider: body.provider || "echo",
        viaLocalhost: cleanHost === "127.0.0.1" || cleanHost === "localhost",
        discovered: true,
        lastSeen: Date.now(),
      },
      true,
    );
    await this.connect(body.peerId);
  }

  async disconnect(peerId: string): Promise<void> {
    this.manualClose.add(peerId);
    this.halt(peerId, false);
    this.outbound.get(peerId)?.disconnect();
    this.inbound.get(peerId)?.disconnect(true);
    this.outbound.delete(peerId);
    this.inbound.delete(peerId);
    this.pendingHello.delete(peerId);
    this.knockWait.delete(peerId);
    this.status.set(peerId, "none");
    this.system(peerId, "Đã ngắt kết nối.");
  }

  async accept(peerId: string): Promise<void> {
    const knock = this.knockWait.get(peerId);
    if (knock) {
      this.knockWait.delete(peerId);
      await this.openClient(peerId, knock, peerId);
      return;
    }
    const socket = this.pendingHello.get(peerId);
    if (!socket) return;
    this.pendingHello.delete(peerId);
    if (!socket.connected) {
      this.status.set(peerId, "none");
      this.system(peerId, "Máy kia đã ngắt trước khi được chấp nhận.");
      return;
    }
    const endpoint = this.endpoints.get(peerId);
    const token = this.store.trusted[peerId]?.token || randomBytes(24).toString("hex");
    this.trust(peerId, token, endpoint?.name || "Máy kia");
    this.bindInbound(peerId, socket);
    socket.emit("paired", { token, name: this.store.settings.name });
    this.markConnected(peerId, endpoint?.name || "Máy kia");
  }

  reject(peerId: string): void {
    const knock = this.knockWait.get(peerId);
    if (knock) {
      this.knockWait.delete(peerId);
      this.status.set(peerId, "none");
      this.system(peerId, "Đã từ chối kết nối.");
      return;
    }
    const socket = this.pendingHello.get(peerId);
    this.pendingHello.delete(peerId);
    if (socket) {
      socket.emit("rejected");
      socket.disconnect(true);
    }
    this.status.set(peerId, "none");
    this.system(peerId, "Đã từ chối kết nối.");
  }

  async sendHuman(peerId: string, text: string, attachmentPath?: string): Promise<void> {
    if (parseGroupKey(peerId)) {
      await this.sendGroup(peerId, text, attachmentPath);
      return;
    }
    const clean = text.trim().slice(0, LINE_CAP);
    let attachment: DiscussFile | undefined;
    try {
      if (attachmentPath?.trim()) attachment = await this.deliverDiscuss(peerId, attachmentPath);
    } catch (err) {
      this.system(peerId, this.recordError(`gửi file đính kèm cho ${this.who(peerId)}`, err, "Không gửi được file đính kèm."));
      return;
    }
    const spoken = clean || (attachment ? `Đọc file đính kèm ${attachment.name} và trao đổi nội dung.` : "");
    if (!spoken) return;
    const sessionId = this.ensureSession(peerId);
    this.nameSession(peerId, sessionId, spoken);
    const line = this.makeLine(peerId, this.store.peerId, this.store.settings.name, "human", spoken);
    line.mentions = mentionTargets(spoken, this.mentionPeople(peerId));
    if (attachment) {
      line.attachment = attachment;
      const preview = fileRef(attachment.path);
      if (preview) {
        line.file = preview;
        allowPreview(attachment.path);
      }
    }
    this.appendLine(sessionId, line);
    const wire = this.toWire(line, sessionId);
    const published = this.publishMentions(line.text, this.mentionPeople(peerId));
    wire.text = published.text;
    wire.mentions = published.mentions;
    const callsSelf = Boolean(line.mentions?.some((item) => item.peerId === this.store.peerId));
    const callsPeer = Boolean(line.mentions?.some((item) => item.peerId === peerId));
    const briefRunning = Boolean(this.store.briefs[sessionId]?.running);
    if (!callsPeer) wire.defer = true;
    if (callsSelf && callsPeer && !briefRunning) {
      wire.defer = true;
      const sent = this.sendTo(peerId, "chat", wire);
      const epoch = this.epochs.get(peerId) ?? 0;
      await this.enqueueReply(peerId, sessionId);
      if ((this.epochs.get(peerId) ?? 0) !== epoch) return;
      if (sent) {
        this.sendTo(peerId, "after-me", { sessionId, sessionTitle: this.sessionTitle(sessionId) } satisfies WireResume);
        return;
      }
    } else {
      if (callsSelf) void this.enqueueReply(peerId, sessionId);
      if (this.sendTo(peerId, "chat", wire)) return;
      if (!callsPeer) {
        this.system(peerId, "Chưa nối được máy kia, tin nhắn chưa gửi.");
        return;
      }
    }
    if (attachment) {
      this.system(peerId, "File đã tới máy kia, nhưng cần kết nối đang mở thì agent mới đọc và trao đổi.");
      return;
    }
    try {
      const reply = await this.httpTrigger(peerId, wire.text);
      const name = this.endpoints.get(peerId)?.name || this.store.trusted[peerId]?.name || "Máy kia";
      this.appendLine(sessionId, this.makeLine(peerId, peerId, name, "agent", reply));
    } catch (err) {
      this.system(peerId, this.recordError(`gọi agent của ${this.who(peerId)} qua HTTP`, err, "Không gửi được."));
    }
  }

  async startDialogue(peerId: string, topic: string, replies: number): Promise<void> {
    const clean = topic.trim().slice(0, BRIEF_TOPIC_CAP);
    if (!clean) return;
    const sessionId = this.ensureSession(peerId);
    const brief = this.ensureBrief(sessionId);
    if (!brief.running) {
      brief.topic = clean;
      brief.turnLimit = clampTurnLimit(replies, DIALOGUE_CAP);
    }
    await this.startBrief(peerId);
  }

  saveBrief(peerId: string, patch: { topic?: string; goal?: string; turnLimit?: number; coding?: boolean }): AppState {
    const sessionId = this.ensureSession(peerId);
    const brief = this.ensureBrief(sessionId);
    if (!brief.running) {
      brief.topic = String(patch.topic ?? brief.topic).trim().slice(0, BRIEF_TOPIC_CAP);
      brief.goal = String(patch.goal ?? brief.goal).trim().slice(0, BRIEF_GOAL_CAP);
      if (typeof patch.coding === "boolean") brief.coding = patch.coding;
      if (!brief.coding) {
        brief.needTurns = 0;
        brief.codingSince = 0;
      }
      brief.turnLimit = clampTurnLimit(Number(patch.turnLimit ?? brief.turnLimit), brief.coding ? CODING_TURN_MAX : BRIEF_TURN_MAX);
      this.syncBrief(peerId, sessionId);
      this.scheduleSave();
      this.pushNow();
    }
    return this.snapshot();
  }

  setMemberRole(groupId: string, peerId: string, role: string): AppState {
    const room = this.groupById(groupId);
    if (!room || room.hostId !== this.store.peerId) return this.snapshot();
    const member = room.members.find((item) => item.peerId === peerId);
    if (!member) return this.snapshot();
    const clean = codingRole(role);
    if (clean) member.role = clean;
    else delete member.role;
    this.relay(room, "group", this.wireGroup(room));
    this.scheduleSave();
    this.pushNow();
    return this.snapshot();
  }

  async addBriefFiles(peerId: string, paths: string[]): Promise<AppState> {
    if (parseGroupKey(peerId)) return this.addGroupFiles(peerId, paths);
    const sessionId = this.ensureSession(peerId);
    const brief = this.ensureBrief(sessionId);
    if (brief.running) return this.snapshot();
    let offline = false;
    for (const filePath of Array.isArray(paths) ? paths : []) {
      if (typeof filePath !== "string" || !filePath.trim()) continue;
      const replacing = brief.files.some((file) => file.name === safeFileName(path.basename(filePath)));
      if (!replacing && brief.files.length >= BRIEF_FILE_MAX) {
        this.system(peerId, `Hồ sơ chỉ giữ ${BRIEF_FILE_MAX} file.`);
        break;
      }
      try {
        const stored = await this.storeBriefFile(sessionId, filePath);
        if (this.isLinked(peerId)) await this.postBriefFile(peerId, sessionId, stored.name, stored.data);
        else offline = true;
        const next = { name: stored.name, kind: stored.kind, excerpt: stored.excerpt };
        const index = brief.files.findIndex((file) => file.name === stored.name);
        if (index >= 0) brief.files[index] = next;
        else brief.files.push(next);
      } catch (err) {
        this.system(peerId, this.recordError(`thêm file context cho ${this.who(peerId)}`, err, "Không thêm được file context."));
      }
    }
    if (offline) this.system(peerId, "File context đang ở máy này. Khi bắt đầu và đã nối, file được gửi sang máy kia.");
    this.syncBrief(peerId, sessionId);
    this.scheduleSave();
    this.pushNow();
    return this.snapshot();
  }

  removeBriefFile(peerId: string, name: string): AppState {
    const sessionId = this.ensureSession(peerId);
    const brief = this.ensureBrief(sessionId);
    if (!brief.running) {
      brief.files = brief.files.filter((file) => file.name !== safeFileName(name));
      this.syncBrief(peerId, sessionId);
      this.scheduleSave();
      this.pushNow();
    }
    return this.snapshot();
  }

  async startBrief(peerId: string, wanted = ""): Promise<AppState> {
    if (parseGroupKey(peerId)) return this.startGroupBrief(peerId, wanted);
    const known = Boolean(wanted && (this.store.sessions[peerId] ?? []).some((session) => session.id === wanted));
    const sessionId = known ? wanted : this.ensureSession(peerId);
    const brief = this.ensureBrief(sessionId);
    if (!brief.running && !brief.topic.trim()) this.takeQueued(peerId, sessionId);
    if (!brief.topic.trim()) {
      this.system(peerId, "Hãy nhập chủ đề trước khi bắt đầu.");
      return this.snapshot();
    }
    if (!this.isLinked(peerId)) {
      this.system(peerId, "Cần nối socket trước khi cho hai agent nói với nhau.");
      return this.snapshot();
    }
    this.halt(peerId, true);
    brief.running = true;
    brief.turnsUsed = 0;
    brief.needTurns = 0;
    if (brief.coding) {
      brief.codingSince = Date.now();
      this.resetCodingView(sessionId);
    }
    brief.turnLimit = clampTurnLimit(brief.turnLimit, brief.coding ? CODING_TURN_MAX : BRIEF_TURN_MAX);
    this.pushNow();
    try {
      await this.pushBriefFiles(peerId, sessionId, brief);
    } catch (err) {
      brief.running = false;
      this.system(peerId, this.recordError(`gửi file context cho ${this.who(peerId)}`, err, "Không gửi được file context."));
      return this.snapshot();
    }
    this.nameSession(peerId, sessionId, brief.topic);
    const line = this.makeLine(peerId, this.store.peerId, this.store.settings.name, "human", brief.topic);
    this.appendLine(sessionId, line);
    const wire = this.toWire(line, sessionId);
    wire.text = this.publishMentions(line.text, this.mentionPeople(peerId)).text;
    wire.dialogue = { repliesLeft: brief.turnLimit };
    wire.brief = sanitizeBrief(brief);
    this.syncBrief(peerId, sessionId);
    if (!this.sendTo(peerId, "chat", wire)) {
      brief.running = false;
      this.system(peerId, "Cần nối socket trước khi cho hai agent nói với nhau.");
    }
    this.scheduleSave();
    this.pushNow();
    return this.snapshot();
  }

  async extendBrief(peerId: string, extra?: number): Promise<AppState> {
    if (parseGroupKey(peerId)) return this.extendGroup(peerId, extra);
    if (!this.isLinked(peerId)) {
      this.system(peerId, "Cần nối socket trước khi gia hạn lượt.");
      return this.snapshot();
    }
    const sessionId = this.ensureSession(peerId);
    const brief = this.ensureBrief(sessionId);
    const cap = brief.coding ? CODING_TURN_MAX : BRIEF_TURN_MAX;
    const requested = Math.round(Number(extra));
    const add = Number.isFinite(requested) && requested > 0 ? Math.min(cap, requested) : BRIEF_EXTEND;
    if (!brief.topic.trim()) {
      this.system(peerId, "Hãy nhập chủ đề trước khi gia hạn.");
      return this.snapshot();
    }
    const nextLimit = brief.turnsUsed >= brief.turnLimit ? brief.turnsUsed + add : brief.turnLimit + add;
    brief.turnLimit = clampTurnLimit(nextLimit, cap);
    if (brief.coding) brief.needTurns = 0;
    if (brief.running) {
      this.syncBrief(peerId, sessionId);
      this.scheduleSave();
      this.pushNow();
      return this.snapshot();
    }
    brief.running = true;
    this.syncBrief(peerId, sessionId);
    const lines = this.store.transcripts[sessionId] ?? [];
    const lastAgent = [...lines].reverse().find((line) => line.kind === "agent" && !line.pending && !line.aside);
    if (lastAgent && lastAgent.fromPeerId !== this.store.peerId) void this.enqueueReply(peerId, sessionId, true);
    else this.sendTo(peerId, "resume", { sessionId, sessionTitle: this.sessionTitle(sessionId) } satisfies WireResume);
    this.scheduleSave();
    this.pushNow();
    return this.snapshot();
  }

  stopTalk(peerId: string): void {
    const groupId = parseGroupKey(peerId);
    if (groupId) {
      const room = this.groupById(groupId);
      if (!room) return;
      const running = this.aborts.has(peerId);
      const summary = this.aborts.has(this.summaryKey(peerId));
      this.haltGroupLocal(room, true);
      if (!running && !summary) this.groupNote(room, "Đã dừng.", false);
      return;
    }
    const running = this.aborts.has(peerId);
    const summary = this.aborts.has(this.summaryKey(peerId));
    this.halt(peerId, true);
    if (!running && !summary) this.system(peerId, "Đã dừng.");
  }

  private async openPort(start: number): Promise<void> {
    let last = "hết dải cổng";
    for (let port = start; port < start + PORT_SPAN; port += 1) {
      const server = http.createServer((req, res) => {
        void this.onHttp(req, res);
      });
      // Node mặc định đóng request sau 5 phút. Agent vẫn đang chạy thì không cắt.
      server.requestTimeout = 0;
      const io = new Server(server, {
        cors: { origin: true },
        maxHttpBufferSize: 1_000_000,
        pingInterval: 5000,
        pingTimeout: 4000,
      });
      this.bindIo(io);
      try {
        await listen(server, port);
        server.on("error", (err) => this.recordError(`máy chủ HTTP cổng ${port}`, err, "Lỗi máy chủ"));
        this.server = server;
        this.io = io;
        this.port = port;
        return;
      } catch (err) {
        io.close();
        server.close();
        const code = (err as NodeJS.ErrnoException).code;
        last = err instanceof Error ? err.message : String(err);
        if (code !== "EADDRINUSE") {
          this.recordError(`mở cổng ${port}`, err, last);
          throw err;
        }
      }
    }
    const error = new Error(`Không mở được cổng từ ${start}: ${last}`);
    this.recordError(`mở cổng từ ${start}`, error, error.message);
    throw error;
  }

  private bindIo(io: Server): void {
    io.on("connection", (socket) => {
      let bound: string | null = null;
      socket.on("hello", (payload: Partial<HelloPayload>, ack?: (res: HelloAck) => void) => {
        const respond = typeof ack === "function" ? ack : () => undefined;
        const hello = this.readHello(payload);
        if (!hello) {
          respond({ ok: false, error: "hello không hợp lệ" });
          return;
        }
        const result = this.onHello(socket, hello);
        bound = result.bound;
        respond(result.ack);
      });
      socket.on("session", (body: { id?: string; title?: string; createdAt?: number }) => {
        if (!bound) return;
        this.onRemoteSession(bound, body);
      });
      socket.on("chat", (msg: WireChat) => {
        if (!bound || !this.isLinked(bound)) return;
        void this.onWireChat(bound, msg);
      });
      socket.on("delta", (msg: WireDelta) => {
        if (!bound) return;
        this.onWireDelta(bound, msg);
      });
      socket.on("halt", () => {
        if (!bound) return;
        this.halt(bound, false);
      });
      socket.on("brief", (body: WireBrief) => {
        if (!bound) return;
        this.onWireBrief(bound, body);
      });
      socket.on("resume", (body: WireResume) => {
        if (!bound) return;
        this.onResume(bound, body);
      });
      socket.on("after-me", (body: WireResume) => {
        if (!bound) return;
        this.onAfterMe(bound, body);
      });
      socket.on("aside", (body: { text?: string }) => {
        if (!bound || !body?.text) return;
        this.system(bound, body.text.slice(0, 500), undefined, false);
      });
      socket.on("activity", (body: ActivityPatch) => {
        if (!bound) return;
        this.noteActivity(bound, body);
      });
      socket.on("disconnect", () => {
        if (!bound) return;
        this.onSocketDown(bound, socket);
      });
      this.bindRoom(socket, () => bound);
      this.bindFileTransfer(socket, () => bound);
    });
  }

  private onHello(socket: Socket, hello: HelloPayload): { ack: HelloAck; bound: string | null } {
    const peerId = hello.peerId;
    const host = normalizeIp(socket.handshake.address);
    this.upsertEndpoint(
      peerId,
      {
        name: hello.name,
        host,
        port: hello.port,
        provider: hello.provider,
        viaLocalhost: host === "127.0.0.1",
        discovered: true,
        lastSeen: Date.now(),
      },
      true,
    );
    this.pinHost(peerId, host);
    const trusted = this.store.trusted[peerId];
    const tokenOk = Boolean(hello.token && trusted && trusted.token === hello.token);
    const weInitiated = hello.initiatedBy === this.store.peerId;
    if (tokenOk || this.autoAccept() || weInitiated) {
      const token = trusted?.token || randomBytes(24).toString("hex");
      this.trust(peerId, token, hello.name);
      this.bindInbound(peerId, socket);
      this.markConnected(peerId, hello.name);
      return { ack: { ok: true, token, name: this.store.settings.name }, bound: peerId };
    }
    this.pendingHello.set(peerId, socket);
    this.status.set(peerId, "pending-in");
    this.log(`${hello.name} muốn kết nối`);
    this.pushNow();
    return { ack: { ok: false, pending: true }, bound: peerId };
  }

  private async openClient(peerId: string, endpoint: Endpoint, initiatedBy: string): Promise<void> {
    const existing = this.outbound.get(peerId);
    if (existing?.connected) return;
    existing?.disconnect();
    this.status.set(peerId, "connecting");
    this.pushNow();
    const targetHost = endpoint.host;
    const socket = ioClient(`http://${targetHost}:${endpoint.port}`, {
      reconnection: true,
      timeout: 8000,
      transports: ["websocket", "polling"],
    });
    this.outbound.set(peerId, socket);
    const hello = () => {
      const payload: HelloPayload = {
        peerId: this.store.peerId,
        name: this.store.settings.name,
        provider: this.store.settings.provider,
        token: this.store.trusted[peerId]?.token ?? "",
        port: this.port,
        initiatedBy,
      };
      socket.timeout(8000).emit("hello", payload, (err: unknown, ack?: HelloAck) => {
        if (err || !ack) {
          this.recordError(`lời chào ${endpoint.name} tại ${targetHost}:${endpoint.port}`, err ?? new Error("Không có phản hồi sau 8 giây"), "Không có phản hồi sau 8 giây");
          this.push();
          return;
        }
        if (ack.ok) {
          this.pinHost(peerId, targetHost);
          this.trust(peerId, ack.token, ack.name || endpoint.name);
          this.markConnected(peerId, ack.name || endpoint.name);
          return;
        }
        if (ack.pending) {
          this.status.set(peerId, "pending-out");
          this.log(`Đang chờ ${endpoint.name} chấp nhận`);
          this.pushNow();
          return;
        }
        this.status.set(peerId, "none");
        this.system(peerId, ack.error || "Không nối được.");
      });
    };
    socket.on("connect", hello);
    socket.on("paired", (msg: { token?: string; name?: string }) => {
      if (!msg?.token) return;
      this.trust(peerId, msg.token, msg.name || endpoint.name);
      this.markConnected(peerId, msg.name || endpoint.name);
    });
    socket.on("rejected", () => {
      this.status.set(peerId, "none");
      this.system(peerId, `${endpoint.name} đã từ chối kết nối.`);
      socket.disconnect();
    });
    socket.on("session", (body: { id?: string; title?: string; createdAt?: number }) => this.onRemoteSession(peerId, body));
    socket.on("chat", (msg: WireChat) => void this.onWireChat(peerId, msg));
    socket.on("delta", (msg: WireDelta) => this.onWireDelta(peerId, msg));
    socket.on("halt", () => this.halt(peerId, false));
    socket.on("brief", (body: WireBrief) => this.onWireBrief(peerId, body));
    socket.on("resume", (body: WireResume) => this.onResume(peerId, body));
    socket.on("after-me", (body: WireResume) => this.onAfterMe(peerId, body));
    socket.on("aside", (body: { text?: string }) => {
      if (body?.text) this.system(peerId, body.text.slice(0, 500), undefined, false);
    });
    socket.on("activity", (body: ActivityPatch) => this.noteActivity(peerId, body));
    this.bindRoom(socket, () => peerId);
    this.bindFileTransfer(socket, () => peerId);
    socket.on("disconnect", () => this.onSocketDown(peerId, socket));
    socket.on("connect_error", (err: Error) => {
      this.recordError(`nối ${endpoint.name} tại ${targetHost}:${endpoint.port}`, err, "Không nối được");
      this.push();
    });
  }

  private async knock(peerId: string, endpoint: Endpoint): Promise<void> {
    this.status.set(peerId, "connecting");
    this.pushNow();
    try {
      const res = await fetch(`http://${endpoint.host}:${endpoint.port}/knock`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          peerId: this.store.peerId,
          name: this.store.settings.name,
          port: this.port,
          provider: this.store.settings.provider,
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`Máy kia từ chối knock (HTTP ${res.status}).`);
    } catch (err) {
      this.status.set(peerId, "none");
      const message = friendlyNet(err, "Không gõ được cửa máy kia.");
      this.recordError(`gõ cửa ${endpoint.name} tại ${endpoint.host}:${endpoint.port}`, err, message);
      this.system(peerId, message);
      const wrapped = new Error(message);
      wrapped.cause = err;
      throw wrapped;
    }
    this.status.set(peerId, this.autoAccept() ? "connecting" : "pending-out");
    this.log(`Đã hỏi ${endpoint.name} mở kết nối`);
    this.pushNow();
  }

  private async onHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const urlText = req.url ?? "/";
      if (urlText.startsWith("/socket.io")) return;
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "content-type, authorization, x-file-name",
          "access-control-allow-methods": "GET, POST, OPTIONS",
        });
        res.end();
        return;
      }
      const url = new URL(urlText, "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === "GET" && url.pathname === "/identity") {
        sendJson(res, 200, {
          peerId: this.store.peerId,
          name: this.store.settings.name,
          port: this.port,
          provider: this.store.settings.provider,
          profile: this.profile,
          clis: installedCliList(this.localClis),
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/peers") {
        const peers = this.snapshot().peers.map((peer) => ({
          peerId: peer.peerId,
          name: peer.name,
          host: peer.host,
          port: peer.port,
          provider: peer.provider,
          clis: peer.clis,
          discovered: peer.discovered,
          status: peer.status,
        }));
        sendJson(res, 200, { peers });
        return;
      }
      if (req.method === "POST" && url.pathname === "/knock") {
        await this.onKnock(req, res);
        return;
      }
      if (req.method === "POST" && url.pathname === "/trigger") {
        await this.onTrigger(req, res);
        return;
      }
      if (req.method === "POST" && url.pathname === "/inbox-file") {
        await this.onInboxFile(req, res);
        return;
      }
      const relay = /^\/relay-file\/([^/]+)$/.exec(decodeURIComponent(url.pathname));
      if (req.method === "POST" && relay) {
        await this.onRelayFile(req, res, relay[1]);
        return;
      }
      sendJson(res, 404, { ok: false, error: "Không có route này" });
    } catch (err) {
      this.recordError(`HTTP ${req.url || ""}`, err, "Lỗi máy chủ");
      if (res.headersSent) return;
      sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : "Lỗi" });
    }
  }

  private async onKnock(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readJson(req);
    const peerId = String(body.peerId ?? "").slice(0, 80);
    const name = String(body.name ?? "Máy lạ").slice(0, 40);
    const port = Number(body.port);
    const provider = String(body.provider ?? "echo").slice(0, 20);
    if (!peerId || peerId === this.store.peerId || !port) {
      sendJson(res, 400, { ok: false, error: "knock không hợp lệ" });
      return;
    }
    if (this.store.peerId > peerId) {
      sendJson(res, 200, { ok: true, role: "server" });
      return;
    }
    const host = remoteIp(req);
    const endpoint: Endpoint = {
      name,
      host,
      port,
      provider,
      viaLocalhost: host === "127.0.0.1",
      discovered: true,
      lastSeen: Date.now(),
    };
    this.upsertEndpoint(peerId, endpoint, true);
    if (this.isLinked(peerId)) {
      sendJson(res, 200, { ok: true, already: true });
      return;
    }
    if (this.autoAccept()) {
      void this.openClient(peerId, endpoint, peerId);
    } else {
      this.knockWait.set(peerId, endpoint);
      this.status.set(peerId, "pending-in");
      this.log(`${name} muốn kết nối`);
      this.pushNow();
    }
    sendJson(res, 200, { ok: true });
  }

  async sendFile(peerId: string, filePath: string, allowOutside = false): Promise<void> {
    if (parseGroupKey(peerId)) {
      await this.sendGroupFile(peerId, filePath, allowOutside);
      return;
    }
    const resolved = allowOutside ? path.resolve(filePath) : resolveInside(this.store.settings.workDir, filePath);
    if (!fs.existsSync(resolved)) throw new Error("Không thấy file.");
    const data = await readFileLimited(resolved, MAX_FILE_BYTES);
    const name = safeFileName(path.basename(resolved));
    await this.postFile(peerId, name, data);
    const ref = fileRef(resolved);
    if (ref) allowPreview(resolved);
    this.system(peerId, `Đã gửi file ${name} (${formatBytes(data.length)}) sang máy kia.`, ref ?? undefined);
  }

  private async onRelayFile(req: http.IncomingMessage, res: http.ServerResponse, peerId: string): Promise<void> {
    if (remoteIp(req) !== "127.0.0.1") {
      sendJson(res, 403, { ok: false, error: "Chỉ máy này mới gửi file đi được." });
      return;
    }
    const raw = await readBody(req, 32_000);
    const type = String(req.headers["content-type"] || "");
    let requested = raw.toString("utf8").replace(/^\uFEFF/, "").trim();
    if (type.includes("application/json")) {
      try {
        const parsed = JSON.parse(requested) as { path?: unknown };
        requested = String(parsed.path ?? "").trim();
      } catch {
        sendJson(res, 400, { ok: false, error: "JSON không hợp lệ" });
        return;
      }
    }
    if (!requested) {
      sendJson(res, 400, { ok: false, error: "Thiếu đường dẫn file" });
      return;
    }
    await this.sendFile(peerId, requested, !this.store.settings.confineWorkDir);
    sendJson(res, 200, { ok: true, name: path.basename(requested) });
  }

  private async onInboxFile(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const peerId = this.peerIdForToken(bearer(req));
    if (!peerId) {
      sendJson(res, 401, { ok: false, error: "Sai token ghép nối" });
      return;
    }
    const data = await readBody(req, MAX_FILE_BYTES);
    if (!data.length) {
      sendJson(res, 400, { ok: false, error: "File rỗng" });
      return;
    }
    const name = fileNameFromHeader(req.headers["x-file-name"]);
    const saved = await this.storeInbox(peerId, name, data, req.headers["x-discuss"] === "1", String(req.headers["x-brief-session"] || ""));
    sendJson(res, 200, { ok: true, name: saved, bytes: data.length });
  }

  private async storeInbox(peerId: string, name: string, data: Buffer, discuss: boolean, briefSession: string): Promise<string> {
    if (/^[a-zA-Z0-9_-]{1,80}$/.test(briefSession)) {
      const saved = await saveExact(briefFolder(this.store.settings.workDir, briefSession), name, data);
      if (fileRef(saved)) allowPreview(saved);
      return path.basename(saved);
    }
    const saved = await saveReceivedFile(this.store.settings.workDir, name, data);
    if (!discuss) {
      const from = this.endpoints.get(peerId)?.name || this.store.trusted[peerId]?.name || "Máy kia";
      this.system(peerId, `${from} đã gửi file ${path.basename(saved)} (${formatBytes(data.length)}). Lưu tại ${saved}`, fileRef(saved) ?? undefined);
    } else if (fileRef(saved)) {
      allowPreview(saved);
    }
    return path.basename(saved);
  }

  private async deliverDiscuss(peerId: string, filePath: string): Promise<DiscussFile> {
    const resolved = path.resolve(filePath);
    const kind = discussKind(resolved);
    if (!kind) throw new Error("Chỉ nhận txt, md, ảnh, pdf, docx, xlsx, xls hoặc csv.");
    const data = await readFileLimited(resolved, MAX_FILE_BYTES);
    const root = path.resolve(this.store.settings.workDir);
    const rel = path.relative(root, resolved);
    const localPath = rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? resolved : await saveReceivedFile(root, path.basename(resolved), data);
    const remoteName = await this.postFile(peerId, path.basename(localPath), data, true);
    return {
      name: path.basename(localPath),
      path: localPath,
      kind,
      excerpt: discussExcerpt(localPath, data),
      remoteName,
    };
  }

  private async postFile(peerId: string, name: string, data: Buffer, discuss = false, briefSession = ""): Promise<string> {
    const endpoint = this.endpoints.get(peerId) ?? this.endpointFromTrusted(peerId);
    const token = this.store.trusted[peerId]?.token;
    if (!endpoint?.port || !token) throw new Error("Hãy nối máy kia trước khi gửi file.");
    const hosts = this.fileHosts(peerId);
    if (!hosts.length) throw new Error("Hãy nối máy kia trước khi gửi file.");
    let last: Error | null = null;
    for (const host of hosts) {
      try {
        const saved = await this.postFileHttp(host, endpoint.port, token, name, data, discuss, briefSession);
        this.pinHost(peerId, host);
        return saved;
      } catch (err) {
        const next = err instanceof Error ? err : new Error("Không gửi được file.");
        if (last && !next.cause) next.cause = last;
        last = next;
      }
    }
    if (this.isLinked(peerId)) {
      try {
        return await this.postFileSocket(peerId, name, data, discuss, briefSession);
      } catch (err) {
        const next = err instanceof Error ? err : new Error("Không gửi được file.");
        if (last && !next.cause) next.cause = last;
        last = next;
      }
    }
    const where = hosts.join(" hoặc ");
    const error = new Error(`Không gửi được file tới ${where}. ${last?.message || "Máy kia không nhận file."}`);
    if (last) error.cause = last;
    throw error;
  }

  private fileHosts(peerId: string): string[] {
    const hosts: string[] = [];
    const add = (host?: string) => {
      const clean = normalizeIp((host || "").trim());
      if (!clean || clean === "0.0.0.0" || hosts.includes(clean)) return;
      hosts.push(clean);
    };
    add(this.linkHost.get(peerId));
    add(this.endpoints.get(peerId)?.host);
    add(this.store.trusted[peerId]?.host);
    return hosts;
  }

  private pinHost(peerId: string, host: string): void {
    const clean = normalizeIp(host.trim());
    if (!clean || clean === "0.0.0.0") return;
    this.linkHost.set(peerId, clean);
    const endpoint = this.endpoints.get(peerId);
    if (!endpoint || endpoint.host === clean) return;
    endpoint.host = clean;
    endpoint.viaLocalhost = clean === "127.0.0.1";
    this.rememberReach(peerId, endpoint);
    this.push();
  }

  private async postFileHttp(
    host: string,
    port: number,
    token: string,
    name: string,
    data: Buffer,
    discuss: boolean,
    briefSession: string,
  ): Promise<string> {
    let res: Response;
    try {
      res = await fetch(`http://${host}:${port}/inbox-file`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/octet-stream",
          "x-file-name": encodeURIComponent(name),
          ...(discuss ? { "x-discuss": "1" } : {}),
          ...(briefSession ? { "x-brief-session": briefSession.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80) } : {}),
        },
        body: new Uint8Array(data),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      const wrapped = new Error(`${host}:${port} · ${netCause(err) || "Không gửi được file."}`);
      wrapped.cause = err;
      throw wrapped;
    }
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; name?: string; error?: string };
    if (res.status === 404) throw new Error("Máy kia cần cài bản LAN Agents mới thì mới nhận được file.");
    if (!res.ok || !body.ok) throw new Error(body.error || `Máy kia không nhận file (HTTP ${res.status}).`);
    return body.name || name;
  }

  private liveSocket(peerId: string): LiveSocket | null {
    const outbound = this.outbound.get(peerId);
    if (outbound?.connected) return outbound;
    const inbound = this.inbound.get(peerId);
    if (inbound?.connected) return inbound;
    return null;
  }

  private postFileSocket(peerId: string, name: string, data: Buffer, discuss: boolean, briefSession: string): Promise<string> {
    const socket = this.liveSocket(peerId);
    if (!socket) return Promise.reject(new Error("Kết nối đang mở không còn để gửi file."));
    const id = randomUUID();
    const chunk = 48 * 1024;
    const total = Math.max(1, Math.ceil(data.length / chunk));
    const send = (event: string, body: unknown) =>
      new Promise<string>((resolve, reject) => {
        socket.timeout(20_000).emit(event, body, (err: unknown, ack?: { ok?: boolean; name?: string; error?: string }) => {
          if (err) {
            const detail = err instanceof Error && err.message ? err.message : "";
            const wrapped = new Error(
              detail
                ? `Máy kia không nhận file qua kết nối đang mở (${event}): ${detail}`
                : `Máy kia không nhận file qua kết nối đang mở (${event}).`,
            );
            wrapped.cause = err;
            reject(wrapped);
            return;
          }
          if (!ack?.ok) {
            reject(new Error(ack?.error || "Máy kia không nhận file."));
            return;
          }
          resolve(ack.name || name);
        });
      });
    return (async () => {
      await send("file-begin", {
        id,
        name,
        size: data.length,
        total,
        discuss: discuss ? 1 : 0,
        briefSession: briefSession.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80),
      });
      for (let seq = 0; seq < total; seq += 1) {
        const slice = data.subarray(seq * chunk, (seq + 1) * chunk);
        await send("file-chunk", { id, seq, data: slice.toString("base64") });
      }
      return send("file-end", { id });
    })();
  }

  private bindFileTransfer(socket: LiveSocket, peerId: () => string | null): void {
    const pending = new Map<string, { name: string; total: number; parts: Array<Buffer | undefined>; discuss: boolean; brief: string }>();
    const replyFail = (ack: unknown, error: string) => {
      if (typeof ack === "function") (ack as (body: { ok: boolean; error: string }) => void)({ ok: false, error });
    };
    const fail = (ack: unknown, error: string) => {
      const owner = peerId();
      this.recordError(`nhận file${owner ? ` từ ${this.who(owner)}` : ""}`, new Error(error), error);
      replyFail(ack, error);
    };
    socket.on("disconnect", () => pending.clear());
    socket.on("file-begin", (body: { id?: string; name?: string; size?: number; total?: number; discuss?: number; briefSession?: string }, ack?: (body: { ok: boolean; error?: string }) => void) => {
      const id = String(body?.id || "");
      const owner = peerId();
      const total = Math.round(Number(body?.total) || 0);
      const size = Math.round(Number(body?.size) || 0);
      if (!owner || !this.isLinked(owner) || !id || total < 1 || total > 2000 || size < 1 || size > MAX_FILE_BYTES) {
        fail(ack, "File không hợp lệ.");
        return;
      }
      pending.set(id, {
        name: safeFileName(String(body?.name || "file.bin")),
        total,
        parts: Array.from({ length: total }),
        discuss: body?.discuss === 1,
        brief: String(body?.briefSession || ""),
      });
      if (typeof ack === "function") ack({ ok: true });
    });
    socket.on("file-chunk", (body: { id?: string; seq?: number; data?: string }, ack?: (body: { ok: boolean; error?: string }) => void) => {
      const item = pending.get(String(body?.id || ""));
      const seq = Math.round(Number(body?.seq) || -1);
      const raw = typeof body?.data === "string" ? body.data : "";
      if (!item || seq < 0 || seq >= item.total || !raw || raw.length > 80_000) {
        fail(ack, "Mảnh file không hợp lệ.");
        return;
      }
      const bytes = Buffer.from(raw, "base64");
      if (!bytes.length || bytes.length > 64 * 1024) {
        fail(ack, "Mảnh file không hợp lệ.");
        return;
      }
      item.parts[seq] = bytes;
      if (typeof ack === "function") ack({ ok: true });
    });
    socket.on("file-end", (body: { id?: string }, ack?: (body: { ok: boolean; name?: string; error?: string }) => void) => {
      const id = String(body?.id || "");
      const item = pending.get(id);
      const owner = peerId();
      pending.delete(id);
      if (!item || !owner || item.parts.some((part) => !part)) {
        fail(ack, "File chưa nhận đủ.");
        return;
      }
      const data = Buffer.concat(item.parts as Buffer[]);
      if (!data.length || data.length > MAX_FILE_BYTES) {
        fail(ack, "File không hợp lệ.");
        return;
      }
      void this.storeInbox(owner, item.name, data, item.discuss, item.brief)
        .then((saved) => {
          if (typeof ack === "function") ack({ ok: true, name: saved });
        })
        .catch((err: unknown) => {
          const message = this.recordError(`lưu file từ ${owner ? this.who(owner) : "máy kia"}`, err, "Không lưu được file.");
          replyFail(ack, message);
        });
    });
  }

  private async onTrigger(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const peerId = this.peerIdForToken(bearer(req));
    if (!peerId) {
      sendJson(res, 401, { ok: false, error: "Sai token ghép nối" });
      return;
    }
    const body = await readJson(req);
    const text = String(body.text ?? "").trim().slice(0, LINE_CAP);
    if (!text) {
      sendJson(res, 400, { ok: false, error: "Thiếu text" });
      return;
    }
    const name = this.endpoints.get(peerId)?.name || this.store.trusted[peerId]?.name || "Máy kia";
    const sessionId = this.ensureSession(peerId);
    this.nameSession(peerId, sessionId, text);
    this.appendLine(sessionId, this.makeLine(peerId, peerId, name, "human", text));
    this.arrive(peerId, sessionId, name, text);
    this.sendTo(peerId, "aside", { text: `Lệnh HTTP: ${text.slice(0, 500)}` });
    const reply = await this.enqueueReply(peerId, sessionId);
    if (!reply) {
      sendJson(res, 500, { ok: false, error: this.lastError.get(peerId) || "Agent không trả lời" });
      return;
    }
    sendJson(res, 200, { ok: true, reply });
  }

  private async onWireChat(peerId: string, msg: WireChat): Promise<void> {
    if (!msg?.id || msg.fromPeerId === this.store.peerId || msg.fromPeerId !== peerId) return;
    const text = String(msg.text ?? "").slice(0, 100_000);
    const sessionId = msg.sessionId
      ? this.adoptSession(peerId, msg.sessionId, msg.sessionTitle)
      : this.replySessions.get(peerId) || this.ensureSession(peerId);
    const attachment = this.localDiscuss(msg.attachment);
    this.upsertLine(sessionId, {
      id: msg.id,
      fromPeerId: msg.fromPeerId,
      fromName: msg.fromName || "Máy kia",
      kind: msg.kind === "agent" ? "agent" : "human",
      text,
      pending: false,
      createdAt: msg.createdAt || Date.now(),
      attachment,
      file: attachment ? fileRef(attachment.path) ?? undefined : undefined,
      mentions: Array.isArray(msg.mentions) ? mentionTargets(msg.text, msg.mentions) : undefined,
    });
    if (!this.remember(msg.id)) {
      this.pushNow();
      return;
    }
    this.arrive(peerId, sessionId, msg.fromName || "Máy kia", text);
    if (msg.brief) this.applyBrief(peerId, sessionId, msg.brief);
    const dialogue = msg.dialogue;
    const incomingMentions = Array.isArray(msg.mentions) ? msg.mentions : [];
    const called = incomingMentions.some((item) => item?.peerId === this.store.peerId);
    const shouldReply = !msg.defer && (dialogue ? dialogue.repliesLeft > 0 : called);
    this.pushNow();
    if (!shouldReply) return;
    await this.enqueueReply(peerId, sessionId, Boolean(dialogue && dialogue.repliesLeft > 0));
  }

  private onWireDelta(peerId: string, delta: WireDelta): void {
    if (!delta?.id || delta.fromPeerId === this.store.peerId || delta.fromPeerId !== peerId) return;
    const located = this.locate(peerId, delta.id);
    const known = delta.sessionId
      ? (this.store.sessions[peerId] ?? []).some((session) => session.id === delta.sessionId)
      : false;
    const sessionId = located?.sessionId || (known ? delta.sessionId || "" : delta.sessionId ? this.adoptSession(peerId, delta.sessionId) : "");
    if (!sessionId) return;
    const existing = this.findLine(sessionId, delta.id);
    if (existing && !existing.pending) return;
    this.upsertLine(sessionId, {
      id: delta.id,
      fromPeerId: delta.fromPeerId,
      fromName: delta.fromName || "Máy kia",
      kind: "agent",
      text: String(delta.text ?? ""),
      pending: true,
      createdAt: existing?.createdAt ?? delta.createdAt ?? Date.now(),
    });
    this.push();
  }

  private publishAgentSpeech(peerId: string, sessionId: string, id: string, createdAt: number, text: string, groupId: string, loop: boolean): void {
    const published = this.publishMentions(text, this.mentionPeople(groupId ? groupKey(groupId) : peerId));
    const wire: WireChat = {
      id,
      fromPeerId: this.store.peerId,
      fromName: this.store.settings.name,
      kind: "agent",
      text: published.text,
      mentions: published.mentions,
      createdAt,
      sessionId,
      sessionTitle: this.sessionTitle(sessionId),
    };
    if (groupId) this.finishGroupSpeech(groupId, sessionId, wire, loop);
    else {
      if (loop) this.finishPairBrief(peerId, sessionId, wire);
      this.sendTo(peerId, "chat", wire);
    }
    this.pushNow();
    this.scheduleSave();
  }

  private enqueueReply(peerId: string, sessionId: string, loop = false, groupId = ""): Promise<string> {
    const bound = sessionId;
    const epoch = this.epochs.get(peerId) ?? 0;
    let resolveOut: (text: string) => void = () => undefined;
    const result = new Promise<string>((resolve) => {
      resolveOut = resolve;
    });
    const run = async () => {
      if ((this.epochs.get(peerId) ?? 0) !== epoch) {
        resolveOut("");
        return;
      }
      if (loop && !this.briefContinues(bound)) {
        resolveOut("");
        return;
      }
      const owner = this.selfMentionTurn(bound);
      const blocked = owner ? [] : deniedRoles(latestRequest(this.modelHistory(bound)), this.store.settings.access, "request");
      if (blocked.length) {
        if (loop) {
          const brief = this.store.briefs[bound];
          if (brief) brief.running = false;
        }
        const text = denialText(blocked);
        const id = randomUUID();
        const createdAt = Date.now();
        this.upsertLine(bound, {
          id,
          fromPeerId: this.store.peerId,
          fromName: this.store.settings.name,
          kind: "agent",
          text,
          pending: false,
          createdAt,
        });
        this.publishAgentSpeech(peerId, bound, id, createdAt, text, groupId, loop);
        resolveOut(text);
        return;
      }
      const controller = new AbortController();
      this.aborts.set(peerId, controller);
      const coding = Boolean(this.store.briefs[bound]?.coding);
      this.replySessions.set(peerId, bound);
      const id = randomUUID();
      const createdAt = Date.now();
      this.upsertLine(bound, {
        id,
        fromPeerId: this.store.peerId,
        fromName: this.store.settings.name,
        kind: "agent",
        text: "",
        pending: true,
        createdAt,
      });
      if (coding) this.attachCodingLog(bound, id);
      this.pushNow();
      this.notifyActivity(peerId, { replying: true, sessionId: bound });
      const room = groupId ? this.groupById(groupId) : undefined;
      try {
        const provider = this.store.settings.provider;
        const skillDir = configuredSkillDir(this.store.settings);
        const skillDirs = projectSkillRoots(this.store.settings.workDir, skillDir);
        const selfMember = room?.members.find((member) => member.peerId === this.store.peerId);
        if (coding) {
          const resultPath = path.join(briefFolder(this.store.settings.workDir, bound), CODING_RESULT_FILE);
          let stamp = 0;
          try {
            stamp = fs.statSync(resultPath).mtimeMs;
          } catch {
            stamp = 0;
          }
          this.codingFileStamp.set(bound, stamp);
        }
        const ask = (resume: boolean) => {
          const link = resume ? this.cliLink(bound, provider) : undefined;
          const after = link?.syncedLineId || (resume ? "" : this.contextAfter(bound));
          return this.agents.reply({
            peerId,
            selfName: this.store.settings.name,
            peerName: room
              ? room.members
                  .filter((member) => member.peerId !== this.store.peerId)
                  .map((member) => member.name)
                  .join(", ") || "cả nhóm"
              : this.endpoints.get(peerId)?.name || this.store.trusted[peerId]?.name || "máy kia",
            history: this.modelHistory(bound, after),
            signal: controller.signal,
            fileRelay: room ? undefined : { url: `http://127.0.0.1:${this.port}/relay-file/${peerId}` },
            readings: this.readings(bound),
            brief: this.promptBrief(bound),
            coding,
            codingRole: selfMember?.role,
            resultFile: coding ? path.join(briefFolder(this.store.settings.workDir, bound), CODING_RESULT_FILE) : undefined,
            workDir: this.store.settings.workDir,
            confine: this.store.settings.confineWorkDir,
            skillDir,
            skillDirs,
            skills: skillCatalog(skillDirs),
            access: owner ? null : this.store.settings.access,
            granted: this.store.settings.access,
            announceAccess: this.shouldAnnounceAccess(bound),
            room: room
              ? {
                  title: room.title,
                  members: room.members
                    .map((member) => {
                      const record = this.memberRecord(member);
                      return record.role ? `${record.name} (${codingRoleLabel(record.role)})` : record.name;
                    })
                    .join(", "),
                }
              : undefined,
            together: room ? "cả nhóm" : undefined,
            replyTo: this.tagCall(bound),
            resume: Boolean(link),
            sessionId: link?.id,
            sessionTitle: this.sessionTitle(bound),
            onTool: (info) => {
              if (!coding || !this.store.briefs[bound]?.running || (this.epochs.get(peerId) ?? 0) !== epoch) return;
              const task = info.sessionId || link?.id || "";
              for (const step of info.steps) this.noteCoding(bound, task, step, id);
            },
            onTask: (taskId) => {
              if (!coding || !this.store.briefs[bound]?.running || (this.epochs.get(peerId) ?? 0) !== epoch) return;
              this.codingWatch.noteTask(bound, taskId, provider);
            },
            onDelta: (chunk) => {
              if ((this.epochs.get(peerId) ?? 0) !== epoch) return;
              const line = this.findLine(bound, id);
              if (!line?.pending) return;
              line.text += chunk;
              this.scheduleDelta(peerId, bound, id);
            },
          });
        };
        let resumeEnabled = !owner && this.agents.resumes(provider);
        let result;
        try {
          result = await ask(resumeEnabled);
        } catch (err) {
          if (!resumeEnabled || (!(err instanceof CliSessionLost) && !(err instanceof CliResumeUnsupported))) throw err;
          const line = this.findLine(bound, id);
          if (line?.pending) line.text = "";
          if (err instanceof CliSessionLost) {
            this.clearCli(bound, provider);
            this.tell(bound, peerId, "Phiên trong client không còn. Đã mở phiên mới.");
          } else {
            this.agents.disableResume(provider);
            this.clearCli(bound, provider);
            resumeEnabled = false;
            this.tell(bound, peerId, "Bản CLI này chưa nhận cờ nối lại phiên. Mỗi lượt vẫn mang theo hội thoại.");
          }
          result = await ask(false);
        }
        const text = result.text;
        if ((this.epochs.get(peerId) ?? 0) !== epoch || controller.signal.aborted) {
          this.finishAborted(bound, id);
          resolveOut("");
          return;
        }
        const line = this.findLine(bound, id);
        if (line) {
          line.text = text;
          line.pending = false;
        }
        if (resumeEnabled && result.sessionId) this.rememberCli(bound, peerId, provider, result.sessionId, id);
        this.publishAgentSpeech(peerId, bound, id, createdAt, text, groupId, loop);
        this.lastError.delete(peerId);
        resolveOut(text);
      } catch (err) {
        if (err instanceof AccessDenied && (this.epochs.get(peerId) ?? 0) === epoch) {
          const text = err.message;
          this.recordError(`từ chối quyền ${providerLabel(this.store.settings.provider)} trong ${this.who(peerId)}`, err, text);
          const line = this.findLine(bound, id);
          if (line) {
            line.kind = "agent";
            line.text = text;
            line.pending = false;
          }
          this.publishAgentSpeech(peerId, bound, id, createdAt, text, groupId, loop);
          resolveOut(text);
          return;
        }
        if (isAbort(err) || (this.epochs.get(peerId) ?? 0) !== epoch) {
          this.finishAborted(bound, id);
          resolveOut("");
          return;
        }
        const message = this.recordError(
          `${providerLabel(this.store.settings.provider)} trả lời trong ${this.who(peerId)}`,
          err,
          "Agent lỗi",
        );
        this.lastError.set(peerId, message);
        if (coding) this.pauseCoding(peerId, bound, groupId, message, id, createdAt);
        else {
          this.upsertLine(bound, {
            id,
            fromPeerId: this.store.peerId,
            fromName: this.store.settings.name,
            kind: "system",
            text: message,
            pending: false,
            createdAt,
          });
        }
        this.pushNow();
        this.scheduleSave();
        resolveOut("");
      } finally {
        if (this.replySessions.get(peerId) === bound) this.replySessions.delete(peerId);
        this.notifyActivity(peerId, { replying: false, sessionId: bound });
        if (this.aborts.get(peerId) === controller) this.aborts.delete(peerId);
      }
    };
    const prev = this.tails.get(peerId) ?? Promise.resolve();
    const next = prev.then(run, run);
    this.tails.set(
      peerId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }

  private async scanLocal(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const ports: number[] = [];
      for (let port = DEFAULT_PORT; port < DEFAULT_PORT + PORT_SPAN; port += 1) {
        if (port !== this.port) ports.push(port);
      }
      await Promise.all(
        ports.map(async (port) => {
          try {
            const res = await fetch(`http://127.0.0.1:${port}/identity`, { signal: AbortSignal.timeout(350) });
            if (!res.ok) return;
            const body = (await res.json()) as {
              peerId?: string;
              name?: string;
              provider?: string;
              port?: number;
              clis?: string;
            };
            if (!body.peerId || body.peerId === this.store.peerId) return;
            this.remoteClis.set(body.peerId, parseCliList(body.clis));
            this.upsertEndpoint(body.peerId, {
              name: body.name || "Máy local",
              host: "127.0.0.1",
              port: body.port || port,
              provider: body.provider || "echo",
              viaLocalhost: true,
              discovered: true,
              lastSeen: Date.now(),
            });
          } catch {
            /* cổng đóng */
          }
        }),
      );
    } finally {
      this.scanning = false;
    }
  }

  private async httpTrigger(peerId: string, text: string): Promise<string> {
    const endpoint = this.endpoints.get(peerId);
    const token = this.store.trusted[peerId]?.token;
    if (!endpoint?.host || !endpoint.port || !token) throw new Error("Chưa ghép nối với máy này.");
    try {
      const res = await fetch(`http://${endpoint.host}:${endpoint.port}/trigger`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ text }),
      });
      const body = (await res.json()) as { ok?: boolean; reply?: string; error?: string };
      if (!res.ok || !body.ok || !body.reply) throw new Error(body.error || `HTTP ${res.status}`);
      return body.reply;
    } catch (err) {
      const wrapped = new Error(friendlyNet(err, "Không gọi được HTTP trigger."));
      wrapped.cause = err;
      throw wrapped;
    }
  }

  private cliLink(sessionId: string, provider: ProviderId): { id: string; syncedLineId: string } | undefined {
    if (provider === "echo") return undefined;
    return this.sessionRecord(sessionId)?.cli?.[provider];
  }

  private rememberCli(sessionId: string, peerId: string, provider: ProviderId, cliSessionId: string, syncedLineId: string): void {
    if (provider === "echo" || !cliSessionId) return;
    const session = this.sessionRecord(sessionId);
    if (!session) return;
    const previous = session.cli?.[provider]?.id;
    session.cli = { ...session.cli, [provider]: { id: cliSessionId, syncedLineId } };
    if (previous !== cliSessionId) this.tell(sessionId, peerId, cliIntro(provider));
    this.scheduleSave();
  }

  private clearCli(sessionId: string, provider?: ProviderId): void {
    const session = this.sessionRecord(sessionId);
    if (!session?.cli) return;
    if (!provider || provider === "echo") {
      delete session.cli;
    } else {
      const next = { ...session.cli };
      delete next[provider];
      session.cli = Object.keys(next).length ? next : undefined;
    }
    this.scheduleSave();
  }

  private sessionRecord(sessionId: string): ChatSession | undefined {
    for (const list of Object.values(this.store.sessions)) {
      const session = list.find((item) => item.id === sessionId);
      if (session) return session;
    }
    return undefined;
  }

  private openChatSession(peerId: string): string {
    const groupId = parseGroupKey(peerId);
    if (groupId) {
      const room = this.groupById(groupId);
      return room ? this.viewedGroupSession(room) : "";
    }
    return this.ensureSession(peerId);
  }

  private contextAfter(sessionId: string): string {
    return this.sessionRecord(sessionId)?.contextAfter || "";
  }

  private summaryKey(peerId: string): string {
    return `sum:${peerId}`;
  }

  private abortSummary(peerId: string): void {
    const key = this.summaryKey(peerId);
    this.aborts.get(key)?.abort();
    void this.agents.drop(key);
  }

  private summaryBody(sessionId: string): string {
    const lines = this.store.transcripts[sessionId] ?? [];
    const bits: string[] = [];
    for (const line of lines) {
      if (line.pending || line.aside || line.kind === "system") continue;
      const text = line.text.replace(/\s+/g, " ").trim();
      if (!text) continue;
      const who = line.kind === "agent" ? `${line.fromName} · agent` : line.fromName;
      bits.push(`${who}: ${text.slice(0, 400)}`);
    }
    const body = bits.join("\n");
    const cap = 3200;
    if (body.length <= cap) return body;
    return `Phần đầu phiên đã rút gọn.\n${body.slice(-cap)}`;
  }

  private tell(sessionId: string, peerId: string, text: string): void {
    const clean = text.trim();
    if (!clean) return;
    this.appendLine(sessionId, this.makeLine(peerId, this.store.peerId, this.store.settings.name, "system", clean));
    this.pushNow();
  }

  private selfMentionTurn(sessionId: string): boolean {
    const line = this.latestCaller(sessionId);
    return Boolean(line && line.fromPeerId === this.store.peerId && line.kind === "human" && line.mentions?.some((item) => item.peerId === this.store.peerId));
  }

  private latestCaller(sessionId: string): ChatLine | undefined {
    const self = this.store.peerId;
    const lines = this.store.transcripts[sessionId] ?? [];
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (line.pending || line.kind === "system" || line.aside) continue;
      if (line.fromPeerId === self && line.kind === "agent") continue;
      return line;
    }
    return undefined;
  }

  private tagCall(sessionId: string): { name: string; boss: boolean; called: string[] } | undefined {
    const self = this.store.peerId;
    const lines = this.store.transcripts[sessionId] ?? [];
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (line.pending || line.kind === "system" || line.aside) continue;
      if (line.fromPeerId === self && line.kind === "agent") return undefined;
      const mentions = line.mentions ?? [];
      if (!mentions.some((item) => item.peerId === self)) continue;
      const boss = line.fromPeerId === self && line.kind === "human";
      return { name: voiceName(line.fromName, line.kind === "agent"), boss, called: this.calledAgents(mentions) };
    }
    return undefined;
  }

  private calledAgents(mentions: MentionRef[]): string[] {
    const seen = new Set<string>();
    const names: string[] = [];
    for (const item of mentions) {
      if (!item.peerId || seen.has(item.peerId)) continue;
      seen.add(item.peerId);
      names.push(this.agentVoice(item.peerId, item.name));
    }
    return names;
  }

  private agentVoice(peerId: string, fallback: string): string {
    const known = peerId === this.store.peerId ? this.store.settings.name : this.realName(peerId);
    const base = known.trim() && known.trim().toLowerCase() !== "me" ? known : fallback.trim().toLowerCase() === "me" ? known || "Máy" : fallback;
    return voiceName(base, true);
  }

  private modelHistory(sessionId: string, afterLineId = ""): ModelTurn[] {
    const lines = this.store.transcripts[sessionId] ?? [];
    let skipping = Boolean(afterLineId);
    const picked: ChatLine[] = [];
    for (const line of lines) {
      if (skipping) {
        if (line.id === afterLineId) skipping = false;
        continue;
      }
      picked.push(line);
    }
    const source = afterLineId && skipping ? lines.filter((line) => !line.pending).slice(-1) : picked;
    const items: ModelTurn[] = [];
    for (const line of source) {
      if (line.pending || line.kind === "system" || line.aside) continue;
      const text = this.turnText(line);
      if (!text.trim()) continue;
      if (line.kind === "human" && line.fromPeerId === this.store.peerId) {
        const callsSelf = line.mentions?.some((item) => item.peerId === this.store.peerId);
        if (callsSelf) {
          items.push({ role: "user", text, speaker: voiceName(line.fromName, false) });
          continue;
        }
        if (!line.attachment && !this.roomBySession(sessionId)) continue;
        items.push({ role: "note", text: `${voiceName(line.fromName, false)}: ${text}` });
        continue;
      }
      if (line.kind === "agent" && line.fromPeerId === this.store.peerId) {
        items.push({ role: "assistant", text: line.text, speaker: voiceName(line.fromName, true) });
      } else if (line.fromPeerId !== this.store.peerId) {
        items.push({ role: "user", text, speaker: voiceName(line.fromName, line.kind === "agent") });
      }
    }
    return items;
  }

  private turnText(line: ChatLine): string {
    const note = line.attachment ? this.attachmentNote(line.attachment) : "";
    return `${line.text.trim()}${note}`.trim();
  }

  private attachmentNote(file: DiscussFile): string {
    const body = file.excerpt
      ? `\nNội dung đã đọc:\n${file.excerpt}`
      : "\nHãy mở file tại đường dẫn trên và đọc nội dung trước khi trả lời.";
    return `\n\n[File đính kèm ${file.name}]\nĐường dẫn: ${file.path}${body}`;
  }

  private readings(sessionId: string): { name: string; path: string; kind: string; excerpt?: string }[] {
    const found: { name: string; path: string; kind: string; excerpt?: string }[] = [];
    const brief = this.store.briefs[sessionId];
    if (brief) {
      const folder = briefFolder(this.store.settings.workDir, sessionId);
      for (const file of brief.files) {
        found.push({ name: file.name, path: path.join(folder, file.name), kind: file.kind, excerpt: file.excerpt });
      }
    }
    const lines = this.store.transcripts[sessionId] ?? [];
    for (const line of lines) {
      if (!line.attachment?.path) continue;
      found.push({
        name: line.attachment.name,
        path: line.attachment.path,
        kind: line.attachment.kind,
        excerpt: line.attachment.excerpt,
      });
    }
    const seen = new Set<string>();
    const unique = found.filter((file) => {
      const key = file.path.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return unique.slice(0, 12);
  }

  private localDiscuss(raw: WireChat["attachment"]): DiscussFile | undefined {
    if (!raw || !isDiscussKind(raw.kind)) return;
    const name = safeFileName(String(raw.name || ""));
    const saved = path.join(path.resolve(this.store.settings.workDir), name);
    if (fileRef(saved)) allowPreview(saved);
    return {
      name,
      path: saved,
      kind: raw.kind,
      excerpt: String(raw.excerpt ?? "").slice(0, 12_000),
    };
  }

  private upsertEndpoint(peerId: string, next: Endpoint, preferHost = false): void {
    const prev = this.endpoints.get(peerId);
    if (!prev) {
      this.endpoints.set(peerId, { ...next });
      this.rememberReach(peerId, next);
      this.push();
      return;
    }
    prev.name = next.name || prev.name;
    prev.provider = next.provider || prev.provider;
    if (next.port > 0) prev.port = next.port;
    prev.lastSeen = Math.max(prev.lastSeen, next.lastSeen);
    if (next.discovered) prev.discovered = true;
    if (next.host && (preferHost || (!this.isLinked(peerId) && (next.viaLocalhost || !prev.viaLocalhost)))) {
      prev.host = next.host;
      prev.viaLocalhost = next.viaLocalhost;
    }
    this.rememberReach(peerId, prev);
    this.push();
  }

  private endpointFromTrusted(peerId: string): Endpoint | null {
    const trusted = this.store.trusted[peerId];
    if (!trusted?.host || !trusted.port) return null;
    const endpoint: Endpoint = {
      name: trusted.name,
      host: trusted.host,
      port: trusted.port,
      provider: trusted.provider || "echo",
      viaLocalhost: trusted.host === "127.0.0.1",
      discovered: false,
      lastSeen: 0,
    };
    this.endpoints.set(peerId, endpoint);
    return endpoint;
  }

  private expireEndpoints(): void {
    const now = Date.now();
    let changed = false;
    for (const endpoint of this.endpoints.values()) {
      if (endpoint.discovered && now - endpoint.lastSeen > 10_000) {
        endpoint.discovered = false;
        changed = true;
      }
    }
    if (changed) this.push();
  }

  private rememberReach(peerId: string, endpoint: Endpoint): void {
    const trusted = this.store.trusted[peerId];
    if (!trusted) return;
    if (
      trusted.host === endpoint.host &&
      trusted.port === endpoint.port &&
      trusted.name === endpoint.name &&
      trusted.provider === endpoint.provider
    ) {
      return;
    }
    trusted.host = endpoint.host;
    trusted.port = endpoint.port;
    trusted.name = endpoint.name;
    trusted.provider = endpoint.provider;
    this.scheduleSave();
  }

  private trust(peerId: string, token: string, name: string): void {
    const endpoint = this.endpoints.get(peerId);
    const prev = this.store.trusted[peerId];
    this.store.trusted[peerId] = {
      name: name || prev?.name || endpoint?.name || "Máy",
      token,
      host: endpoint?.host ?? prev?.host,
      port: endpoint?.port ?? prev?.port,
      provider: endpoint?.provider ?? prev?.provider,
    };
    if (endpoint && name) endpoint.name = name;
    this.scheduleSave();
  }

  private peerIdForToken(token: string): string | null {
    if (!token) return null;
    for (const [peerId, trusted] of Object.entries(this.store.trusted)) {
      if (trusted.token === token) return peerId;
    }
    return null;
  }

  private bindInbound(peerId: string, socket: Socket): void {
    const prev = this.inbound.get(peerId);
    if (prev && prev !== socket) prev.disconnect(true);
    this.inbound.set(peerId, socket);
    this.pendingHello.delete(peerId);
  }

  private markConnected(peerId: string, name: string): void {
    const already = this.status.get(peerId) === "connected";
    this.pendingHello.delete(peerId);
    this.knockWait.delete(peerId);
    this.status.set(peerId, "connected");
    if (!this.greeted.has(peerId)) {
      this.greeted.add(peerId);
      this.system(peerId, `Đã nối với ${name}.`);
    }
    if (!already) this.log(`Đã nối với ${name}`);
    this.syncGroupsTo(peerId);
    this.pushNow();
  }

  private onSocketDown(peerId: string, socket: LiveSocket): void {
    if (this.manualClose.has(peerId)) {
      this.manualClose.delete(peerId);
      if (this.inbound.get(peerId) === socket) this.inbound.delete(peerId);
      if (this.outbound.get(peerId) === socket) this.outbound.delete(peerId);
      this.status.set(peerId, "none");
      this.push();
      return;
    }
    if (this.inbound.get(peerId) === socket) this.inbound.delete(peerId);
    if (this.outbound.get(peerId) === socket) {
      const client = socket as ClientSocket;
      if (!client.active) this.outbound.delete(peerId);
    }
    if (this.pendingHello.get(peerId) === socket) this.pendingHello.delete(peerId);
    if (!this.isLinked(peerId)) {
      const reconnecting = Boolean(this.outbound.get(peerId)?.active);
      this.status.set(peerId, reconnecting ? "connecting" : "none");
      this.activity.delete(peerId);
      const timer = this.activityTimers.get(peerId);
      if (timer) clearTimeout(timer);
      this.activityTimers.delete(peerId);
      this.advanceIfSpeakerLeft(peerId);
    }
    this.push();
  }

  private halt(peerId: string, tellPeer: boolean): void {
    this.abortSummary(peerId);
    this.epochs.set(peerId, (this.epochs.get(peerId) ?? 0) + 1);
    this.aborts.get(peerId)?.abort();
    const sessionId = this.replySessions.get(peerId) || this.store.openSessions[peerId];
    const brief = sessionId ? this.store.briefs[sessionId] : undefined;
    if (brief?.running) {
      brief.running = false;
      this.scheduleSave();
      this.pushNow();
    }
    if (tellPeer) this.sendTo(peerId, "halt", {});
  }

  private ensureBrief(sessionId: string): ProjectBrief {
    const current = this.store.briefs[sessionId];
    if (current) return current;
    const created = emptyBrief();
    this.store.briefs[sessionId] = created;
    return created;
  }

  private syncBrief(peerId: string, sessionId: string): void {
    const brief = this.store.briefs[sessionId];
    if (!brief) return;
    const groupId = parseGroupKey(peerId);
    if (groupId) {
      const room = this.groupById(groupId);
      if (!room) return;
      this.relay(room, "group-brief", {
        groupId,
        sessionId,
        sessionTitle: this.sessionTitle(sessionId),
        brief: sanitizeBrief(brief),
      });
      return;
    }
    const payload: WireBrief = {
      sessionId,
      sessionTitle: this.sessionTitle(sessionId),
      brief: sanitizeBrief(brief),
    };
    this.sendTo(peerId, "brief", payload);
  }

  private applyBrief(peerId: string, sessionId: string, incoming: ProjectBrief): void {
    const clean = sanitizeBrief(incoming);
    const current = this.store.briefs[sessionId];
    if (current && this.aborts.has(peerId) && current.turnsUsed > clean.turnsUsed) {
      clean.turnsUsed = current.turnsUsed;
      if (clean.turnLimit < current.turnLimit) clean.turnLimit = current.turnLimit;
    }
    this.store.briefs[sessionId] = clean;
  }

  private onWireBrief(peerId: string, body: WireBrief): void {
    if (!body?.sessionId || body.sessionId.length > 80 || !body.brief) return;
    const sessionId = this.adoptSession(peerId, body.sessionId, body.sessionTitle);
    this.applyBrief(peerId, sessionId, body.brief);
    this.scheduleSave();
    this.pushNow();
  }

  private onAfterMe(peerId: string, body: WireResume): void {
    if (!body?.sessionId || body.sessionId.length > 80 || this.aborts.has(peerId)) return;
    const sessionId = this.adoptSession(peerId, body.sessionId, body.sessionTitle);
    void this.enqueueReply(peerId, sessionId);
  }

  private onResume(peerId: string, body: WireResume): void {
    if (!body?.sessionId || this.aborts.has(peerId)) return;
    const sessionId = this.adoptSession(peerId, body.sessionId, body.sessionTitle);
    if (!this.briefContinues(sessionId)) return;
    void this.enqueueReply(peerId, sessionId, true);
  }

  private briefContinues(sessionId: string): boolean {
    const brief = this.store.briefs[sessionId];
    return Boolean(brief?.running && brief.turnsUsed < brief.turnLimit);
  }

  private shouldAnnounceAccess(sessionId: string): boolean {
    const brief = this.store.briefs[sessionId];
    if (!brief?.running || !brief.topic.trim()) return false;
    const lines = this.store.transcripts[sessionId] ?? [];
    let start = 0;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (lines[index]?.kind !== "human") continue;
      start = index + 1;
      break;
    }
    return !lines.slice(start).some((line) => line.kind === "agent" && line.fromPeerId === this.store.peerId && !line.pending && !line.aside && line.text.trim());
  }

  private promptBrief(sessionId: string): { topic: string; goal: string; turn: number; limit: number; last: boolean } | undefined {
    const brief = this.store.briefs[sessionId];
    if (!brief?.topic) return undefined;
    const turn = brief.running ? brief.turnsUsed + 1 : Math.max(1, brief.turnsUsed);
    return {
      topic: brief.topic,
      goal: brief.goal,
      turn,
      limit: brief.turnLimit,
      last: Boolean(brief.running && turn >= brief.turnLimit),
    };
  }

  private finishBriefTurn(sessionId: string, wire: WireChat): void {
    const brief = this.store.briefs[sessionId];
    if (!brief?.running) return;
    brief.turnsUsed += 1;
    if (brief.turnsUsed >= brief.turnLimit) brief.running = false;
    const left = brief.turnLimit - brief.turnsUsed;
    wire.brief = sanitizeBrief(brief);
    if (left > 0 && brief.running) wire.dialogue = { repliesLeft: left };
  }

  private finishPairBrief(peerId: string, sessionId: string, wire: WireChat): void {
    const brief = this.store.briefs[sessionId];
    const done = Boolean(brief?.coding && resultText(wire.text || ""));
    if (brief?.coding) {
      const last = brief.turnsUsed + 1 >= brief.turnLimit;
      brief.needTurns = done || !last ? 0 : codingNeed(wire.text || "");
    }
    this.finishBriefTurn(sessionId, wire);
    if (!done || !brief) return;
    brief.running = false;
    brief.needTurns = 0;
    wire.dialogue = undefined;
    wire.brief = sanitizeBrief(brief);
    void this.publishPairCodingResult(peerId, sessionId, wire.text || "");
  }

  private noteCoding(chatSessionId: string, taskId: string, step: CodingStep, lineId: string): void {
    const shown = this.presentCoding(step);
    this.queueCoding(chatSessionId, shown);
    const counts = shown.status !== "run" && (shown.added || shown.removed) ? `  +${shown.added} −${shown.removed}` : "";
    const block = shown.status === "run" ? "" : this.codingBlock(shown);
    this.traceCoding(chatSessionId, taskId, `${shown.label}${counts}`, block, lineId);
  }

  private presentCoding(step: CodingStep): CodingStep {
    if (!step.path) return step;
    const nextPath = relativeWorkPath(this.store.settings.workDir, step.path);
    if (!nextPath || nextPath === step.path) return step;
    const label = step.label.includes(step.path) ? step.label.split(step.path).join(nextPath) : step.label;
    return { ...step, path: nextPath, label };
  }

  private codingBlock(step: CodingStep): string {
    const body = step.diff || step.code;
    const extra = step.kind === "shell" || step.status === "error" ? step.output : "";
    return [body, extra].filter(Boolean).join("\n\n").slice(0, 8_000);
  }

  private queueCoding(sessionId: string, step: CodingStep): void {
    const id = `${sessionId}\0${step.key}`;
    const signature = [step.status, step.kind, step.label, step.path, step.command, step.diff, step.code, step.output, String(step.added), String(step.removed)].join("\u0001");
    if (this.codingSent.get(id) === signature) return;
    this.codingSent.set(id, signature);
    this.codingPending.set(id, step);
    if (step.status !== "run") {
      this.flushCoding();
      return;
    }
    if (this.codingFlush) return;
    this.codingFlush = setTimeout(() => this.flushCoding(), 70);
  }

  private flushCoding(): void {
    if (this.codingFlush) clearTimeout(this.codingFlush);
    this.codingFlush = null;
    const batch = [...this.codingPending.entries()];
    this.codingPending.clear();
    for (const [id, step] of batch) {
      const sessionId = id.slice(0, id.indexOf("\0"));
      this.onCodingLive({ sessionId, step });
    }
  }

  private resetCodingView(sessionId: string): void {
    const prefix = `${sessionId}\0`;
    for (const key of [...this.codingPending.keys()]) if (key.startsWith(prefix)) this.codingPending.delete(key);
    for (const key of [...this.codingSent.keys()]) if (key.startsWith(prefix)) this.codingSent.delete(key);
    this.onCodingLive({ sessionId, reset: true });
  }

  private attachCodingLog(sessionId: string, lineId: string): void {
    const filePath = this.codingWatch.open(this.codingTrace(sessionId, ""));
    this.stickCodingLog(sessionId, lineId, filePath);
  }

  private traceCoding(chatSessionId: string, taskId: string, line: string, block: string, lineId: string): void {
    const filePath = this.codingWatch.write({ ...this.codingTrace(chatSessionId, taskId), line, block }).path;
    this.stickCodingLog(chatSessionId, lineId, filePath);
  }

  private codingTrace(sessionId: string, taskId: string): CodingTrace {
    const brief = this.store.briefs[sessionId];
    return {
      chatSessionId: sessionId,
      since: brief?.codingSince || 0,
      taskId,
      provider: this.store.settings.provider,
      title: this.sessionTitle(sessionId),
      workDir: this.store.settings.workDir,
    };
  }

  private stickCodingLog(sessionId: string, lineId: string, filePath: string): void {
    if (!filePath) return;
    allowPreview(filePath);
    const line = this.findLine(sessionId, lineId);
    if (!line || line.codingLog === filePath) return;
    line.codingLog = filePath;
    this.scheduleSave();
    this.pushNow();
  }

  codingReplay(sessionId: string): CodingStep[] {
    const filePath = this.newestCodingLog(sessionId);
    if (!filePath) return [];
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size > 2_000_000) return [];
      return parseCodingLog(fs.readFileSync(filePath, "utf8"));
    } catch {
      return [];
    }
  }

  private newestCodingLog(sessionId: string): string {
    const found = new Map<string, number>();
    const remember = (filePath: string) => {
      const resolved = path.resolve(filePath);
      if (!this.isCodingLogPath(sessionId, resolved)) return;
      try {
        const stat = fs.statSync(resolved);
        if (stat.isFile()) found.set(resolved, stat.mtimeMs);
      } catch {
        /* file log đã bị xóa */
      }
    };
    for (const line of this.store.transcripts[sessionId] ?? []) {
      if (line.codingLog) remember(line.codingLog);
    }
    const folder = briefFolder(this.store.settings.workDir, sessionId);
    try {
      for (const name of fs.readdirSync(folder)) {
        if (/^coding-live-.+\.(md|log)$/i.test(name)) remember(path.join(folder, name));
      }
    } catch {
      /* phiên chưa có thư mục brief */
    }
    let best = "";
    let when = -1;
    for (const [filePath, mtime] of found) {
      if (mtime >= when) {
        best = filePath;
        when = mtime;
      }
    }
    return best;
  }

  private isCodingLogPath(sessionId: string, resolved: string): boolean {
    if (!/^coding-live-.+\.(md|log)$/i.test(path.basename(resolved))) return false;
    const folder = path.resolve(briefFolder(this.store.settings.workDir, sessionId));
    const rel = path.relative(folder, resolved);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return true;
    const root = path.resolve(this.store.settings.workDir);
    const fromWork = path.relative(root, resolved);
    return Boolean(fromWork) && !fromWork.startsWith("..") && !path.isAbsolute(fromWork) && fromWork.split(path.sep).includes("briefs");
  }

  deleteCodingLog(filePath: string): boolean {
    const resolved = path.resolve(filePath);
    if (!/^coding-live-.+\.md$/i.test(path.basename(resolved))) return false;
    const root = path.resolve(this.store.settings.workDir);
    const rel = path.relative(root, resolved);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || !rel.split(path.sep).includes("briefs")) return false;
    this.codingWatch.forget(resolved);
    try {
      fs.rmSync(resolved, { force: true });
    } catch {
      return false;
    }
    let changed = false;
    for (const lines of Object.values(this.store.transcripts)) {
      for (const line of lines) {
        if (!line.codingLog || path.resolve(line.codingLog) !== resolved) continue;
        delete line.codingLog;
        changed = true;
      }
    }
    if (changed) {
      this.scheduleSave();
      this.pushNow();
    }
    return true;
  }

  private async storeBriefFile(
    sessionId: string,
    filePath: string,
  ): Promise<{ name: string; kind: DiscussFile["kind"]; excerpt: string; data: Buffer }> {
    const resolved = path.resolve(filePath);
    const kind = discussKind(resolved);
    if (!kind) throw new Error("Chỉ nhận txt, md, ảnh, pdf, docx, xlsx, xls hoặc csv.");
    const data = await readFileLimited(resolved, MAX_FILE_BYTES);
    const saved = await saveExact(briefFolder(this.store.settings.workDir, sessionId), path.basename(resolved), data);
    if (fileRef(saved)) allowPreview(saved);
    return { name: path.basename(saved), kind, excerpt: discussExcerpt(saved, data), data };
  }

  private async pushBriefFiles(peerId: string, sessionId: string, brief: ProjectBrief): Promise<void> {
    const folder = briefFolder(this.store.settings.workDir, sessionId);
    for (const file of brief.files) {
      const full = path.join(folder, file.name);
      if (!fs.existsSync(full)) throw new Error(`Không thấy file context ${file.name} trên máy này.`);
      const data = await readFileLimited(full, MAX_FILE_BYTES);
      await this.postBriefFile(peerId, sessionId, file.name, data);
    }
  }

  private postBriefFile(peerId: string, sessionId: string, name: string, data: Buffer): Promise<string> {
    return this.postFile(peerId, name, data, false, sessionId);
  }

  setWatch(peerId: string, sessionId: string): void {
    this.watchPeer = peerId.slice(0, 80);
    this.watchSession = sessionId.slice(0, 80);
    if (this.watchSession && this.unread.delete(this.watchSession)) this.pushNow();
  }

  setWindowFocused(focused: boolean): void {
    this.windowFocused = focused;
    if (focused && this.watchSession && this.unread.delete(this.watchSession)) this.pushNow();
  }

  private arrive(peerKey: string, sessionId: string, title: string, text: string): void {
    const looking = this.windowFocused && this.watchPeer === peerKey && this.watchSession === sessionId;
    if (looking) {
      this.unread.delete(sessionId);
      return;
    }
    this.unread.add(sessionId);
    const now = Date.now();
    if (now - (this.noticeAt.get(sessionId) ?? 0) < 2000) return;
    this.noticeAt.set(sessionId, now);
    const body = text.replace(/\s+/g, " ").trim().slice(0, 160) || "Có tin mới";
    this.onNotice({
      peerId: peerKey,
      sessionId,
      title: title.replace(/\s+/g, " ").trim().slice(0, 80) || "LAN Agents",
      body,
    });
  }

  createSession(peerId: string): AppState {
    const groupId = parseGroupKey(peerId);
    if (groupId) return this.createGroupSession(groupId);
    const session = this.addSession(peerId);
    this.store.transcripts[session.id] = [];
    this.store.openSessions[peerId] = session.id;
    this.watchPeer = peerId;
    this.watchSession = session.id;
    this.unread.delete(session.id);
    this.sendTo(peerId, "session", { id: session.id, title: session.title, createdAt: session.createdAt });
    this.scheduleSave();
    this.pushNow();
    return this.snapshot();
  }

  deleteSession(peerId: string, sessionId: string): AppState {
    const groupId = parseGroupKey(peerId);
    if (groupId) return this.deleteGroupSession(groupId, sessionId);
    const list = this.store.sessions[peerId] ?? [];
    if (!list.some((session) => session.id === sessionId)) return this.snapshot();
    this.dropSession(peerId, sessionId);
    if (!(this.store.sessions[peerId] ?? []).length) this.addSession(peerId);
    else if (!this.store.openSessions[peerId]) {
      const latest = [...(this.store.sessions[peerId] ?? [])].sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (latest) this.store.openSessions[peerId] = latest.id;
    }
    this.scheduleSave();
    this.pushNow();
    return this.snapshot();
  }

  setNickname(peerId: string, nickname: string): AppState {
    const id = String(peerId || "").slice(0, 80);
    if (!id || id === this.store.peerId || parseGroupKey(id)) return this.snapshot();
    const clean = nickname.replace(/\s+/g, " ").trim().slice(0, 40);
    if (!clean) {
      delete this.store.nicknames[id];
    } else if (clean.toLowerCase() === "me") {
      throw new Error("Biệt danh me dành cho máy này.");
    } else {
      this.store.nicknames[id] = clean;
    }
    this.scheduleSave();
    this.pushNow();
    return this.snapshot();
  }

  clearGroupTalk(groupId: string): AppState {
    const room = this.groupById(groupId);
    if (!room) return this.snapshot();
    const host = room.hostId === this.store.peerId;
    this.haltGroupLocal(room, false);
    const sessionId = this.viewedGroupSession(room);
    room.turn = null;
    this.store.transcripts[sessionId] = [];
    delete this.store.briefs[sessionId];
    this.forgetRun(sessionId);
    this.clearCli(sessionId);
    if (host) {
      this.relay(room, "group-clear", { groupId: room.id, sessionId });
      this.relay(room, "group-turn", { groupId: room.id, sessionId, turn: null, go: false } satisfies WireGroupTurn);
    }
    this.groupNote(room, host ? "Đã xóa hội thoại nhóm." : "Đã xóa hội thoại nhóm trên máy này.", false);
    this.scheduleSave();
    this.pushNow();
    return this.snapshot();
  }

  openSession(peerId: string, sessionId: string): AppState {
    const known = (this.store.sessions[peerId] ?? []).some((session) => session.id === sessionId);
    if (known) {
      this.store.openSessions[peerId] = sessionId;
      this.watchPeer = peerId;
      this.watchSession = sessionId;
      this.unread.delete(sessionId);
      this.scheduleSave();
      this.pushNow();
    }
    return this.snapshot();
  }

  endAgentSession(peerId: string): AppState {
    const sessionId = this.openChatSession(peerId);
    const session = sessionId ? this.sessionRecord(sessionId) : undefined;
    if (!sessionId || !session) return this.snapshot();
    if (this.aborts.has(peerId) || this.aborts.has(this.summaryKey(peerId))) {
      throw new Error("Agent đang trả lời. Hãy dừng trước khi kết thúc phiên.");
    }
    const lines = this.store.transcripts[sessionId] ?? [];
    const last = lines[lines.length - 1];
    this.clearCli(sessionId);
    if (last) session.contextAfter = last.id;
    else delete session.contextAfter;
    const provider = this.store.settings.provider;
    const name = cliClientLabel(provider) || providerLabel(provider);
    const note = provider === "echo"
      ? "Đã chốt mốc hội thoại. Câu tiếp theo không kèm nội dung phía trên."
      : `Đã kết thúc phiên ${name}. Câu tiếp theo mở phiên mới, không kèm hội thoại phía trên.`;
    this.tell(sessionId, peerId, note);
    this.scheduleSave();
    this.pushNow();
    return this.snapshot();
  }

  async summarizeSession(viewPeerId: string, sourceSessionId: string): Promise<void> {
    const source = this.sessionRecord(sourceSessionId);
    if (!source) throw new Error("Không thấy phiên cần tóm tắt.");
    const viewId = this.openChatSession(viewPeerId);
    if (!viewId) throw new Error("Hãy mở một phiên để nhận bản tóm tắt.");
    if (this.aborts.has(viewPeerId) || this.aborts.has(this.summaryKey(viewPeerId))) {
      throw new Error("Agent đang bận. Hãy đợi hoặc bấm Dừng.");
    }
    const body = this.summaryBody(sourceSessionId);
    if (!body.trim()) throw new Error("Phiên này chưa có nội dung để tóm tắt.");
    const id = randomUUID();
    const createdAt = Date.now();
    this.upsertLine(viewId, {
      id,
      fromPeerId: this.store.peerId,
      fromName: this.store.settings.name,
      kind: "agent",
      text: "",
      pending: true,
      createdAt,
      aside: true,
    });
    this.pushNow();
    const controller = new AbortController();
    const key = this.summaryKey(viewPeerId);
    this.aborts.set(key, controller);
    try {
      const settings = this.store.settings;
      const result = await this.agents.reply({
        peerId: key,
        selfName: settings.name,
        peerName: source.title || "Phiên",
        history: [{ role: "user", text: body, speaker: "Hội thoại" }],
        signal: controller.signal,
        summary: { title: source.title || "Phiên", sessionId: source.id },
        resume: false,
        workDir: settings.workDir,
        confine: settings.confineWorkDir,
        access: [],
        onDelta: (chunk) => {
          if (controller.signal.aborted) return;
          const line = this.findLine(viewId, id);
          if (!line?.pending) return;
          line.text += chunk;
          this.push();
        },
      });
      if (controller.signal.aborted) {
        this.finishAborted(viewId, id, "Đã dừng tóm tắt.");
        this.pushNow();
        return;
      }
      const line = this.findLine(viewId, id);
      if (line) {
        line.text = result.text.trim() || "Không có nội dung tóm tắt.";
        line.pending = false;
      }
      this.scheduleSave();
      this.pushNow();
    } catch (err) {
      if (controller.signal.aborted) {
        this.finishAborted(viewId, id, "Đã dừng tóm tắt.");
        this.pushNow();
        return;
      }
      const line = this.findLine(viewId, id);
      const message = err instanceof Error ? err.message : "Không tóm tắt được phiên.";
      if (line) {
        line.pending = false;
        line.text = line.text.trim() ? `${line.text}\n\n${message}` : message;
      }
      this.scheduleSave();
      this.pushNow();
      throw err instanceof Error ? err : new Error(message);
    } finally {
      if (this.aborts.get(key) === controller) this.aborts.delete(key);
      void this.agents.drop(key);
    }
  }

  renameSession(peerId: string, sessionId: string, title: string): AppState {
    const session = (this.store.sessions[peerId] ?? []).find((item) => item.id === sessionId);
    const clean = title.replace(/\s+/g, " ").trim().slice(0, 42);
    if (!session || !clean) return this.snapshot();
    session.title = clean;
    session.pinned = true;
    session.updatedAt = Date.now();
    const groupId = parseGroupKey(peerId);
    if (groupId) {
      const room = this.groupById(groupId);
      if (room) this.publishGroupSession(room, session, false);
    } else {
      this.sendTo(peerId, "session", { id: session.id, title: session.title, createdAt: session.createdAt });
    }
    this.scheduleSave();
    this.pushNow();
    return this.snapshot();
  }

  private ensureSession(peerId: string): string {
    const open = this.store.openSessions[peerId];
    const list = this.store.sessions[peerId] ?? [];
    if (open && list.some((session) => session.id === open)) return open;
    if (list.length) {
      const latest = [...list].sort((a, b) => b.updatedAt - a.updatedAt)[0];
      this.store.openSessions[peerId] = latest.id;
      return latest.id;
    }
    return this.addSession(peerId).id;
  }

  private addSession(peerId: string, id?: string, title?: string): ChatSession {
    const list = this.store.sessions[peerId] ?? [];
    const session: ChatSession = {
      id: id || randomUUID(),
      peerId,
      title: title || `Phiên ${list.length + 1}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.store.sessions[peerId] = [...list, session];
    this.store.transcripts[session.id] = this.store.transcripts[session.id] ?? [];
    this.store.openSessions[peerId] = session.id;
    return session;
  }

  private adoptSession(peerId: string, sessionId?: string, title?: string): string {
    if (!sessionId) return this.ensureSession(peerId);
    const list = this.store.sessions[peerId] ?? [];
    const found = list.find((session) => session.id === sessionId);
    if (found) {
      if (title && !found.pinned && /^Phiên \d+$/.test(found.title)) found.title = title.slice(0, 42);
      found.updatedAt = Date.now();
      if (!this.store.openSessions[peerId]) this.store.openSessions[peerId] = found.id;
      return found.id;
    }
    this.foldEmptySession(peerId, sessionId);
    const previous = this.store.openSessions[peerId];
    const session = this.addSession(peerId, sessionId, title?.slice(0, 42));
    if (previous && previous !== session.id) this.store.openSessions[peerId] = previous;
    return session.id;
  }

  private onRemoteSession(peerId: string, body: { id?: string; title?: string; createdAt?: number }): void {
    if (!body?.id || body.id.length > 80) return;
    const list = this.store.sessions[peerId] ?? [];
    const existing = list.find((session) => session.id === body.id);
    const nextTitle = body.title?.replace(/\s+/g, " ").trim().slice(0, 42);
    if (existing) {
      if (nextTitle && nextTitle !== existing.title) {
        existing.title = nextTitle;
        existing.pinned = true;
        this.scheduleSave();
        this.pushNow();
      }
      return;
    }
    const previous = this.store.openSessions[peerId];
    const keepOpen = Boolean(previous && previous !== body.id && (previous === this.replySessions.get(peerId) || this.sessionHasChat(previous)));
    if (!keepOpen) this.foldEmptySession(peerId, body.id);
    this.addSession(peerId, body.id, body.title);
    const alive = Boolean(previous && (this.store.sessions[peerId] ?? []).some((session) => session.id === previous));
    if (alive && previous !== body.id) {
      this.store.openSessions[peerId] = previous;
      this.unread.add(body.id);
    }
    this.scheduleSave();
    this.pushNow();
  }

  private sessionHasChat(sessionId: string | undefined): boolean {
    if (!sessionId) return false;
    return (this.store.transcripts[sessionId] ?? []).some((line) => line.pending || line.kind !== "system");
  }

  private foldEmptySession(peerId: string, intoId: string): void {
    const open = this.store.openSessions[peerId];
    if (!open || open === intoId || open === this.replySessions.get(peerId)) return;
    const lines = this.store.transcripts[open] ?? [];
    if (lines.some((line) => line.pending || line.kind !== "system")) return;
    const target = this.store.transcripts[intoId] ?? [];
    this.store.transcripts[intoId] = [...lines, ...target];
    delete this.store.transcripts[open];
    this.store.sessions[peerId] = (this.store.sessions[peerId] ?? []).filter((session) => session.id !== open);
    this.store.openSessions[peerId] = intoId;
  }

  private nameSession(peerId: string, sessionId: string, text: string): void {
    const session = (this.store.sessions[peerId] ?? []).find((item) => item.id === sessionId);
    if (!session) return;
    session.updatedAt = Date.now();
    if (session.pinned || !/^Phiên \d+$/.test(session.title)) return;
    const title = text.replace(/\s+/g, " ").trim().slice(0, 42);
    if (title) session.title = title;
  }

  private busyTurnNote(room: GroupRoom): string {
    const title = (this.sessionTitle(room.sessionId) || "phiên đang chạy").replace(/\s+/g, " ").trim().slice(0, 42);
    return `Đang có lượt ở phiên “${title}”. Bấm Hủy agent để dừng.`;
  }

  private sessionTitle(sessionId: string): string {
    for (const list of Object.values(this.store.sessions)) {
      const session = list.find((item) => item.id === sessionId);
      if (session) return session.title;
    }
    return "";
  }

  private locate(peerId: string, lineId: string): { sessionId: string; line: ChatLine } | undefined {
    for (const session of this.store.sessions[peerId] ?? []) {
      const line = this.store.transcripts[session.id]?.find((item) => item.id === lineId);
      if (line) return { sessionId: session.id, line };
    }
    return undefined;
  }

  private pauseCoding(peerId: string, sessionId: string, groupId: string, message: string, lineId: string, createdAt: number): void {
    const brief = this.store.briefs[sessionId];
    if (brief) brief.running = false;
    const priorLine = this.findLine(sessionId, lineId);
    const prior = priorLine?.text.trim() ?? "";
    const text = prior ? `${prior}\n${message}\nChủ đề coding tạm dừng.` : `${message}\nChủ đề coding tạm dừng.`;
    this.upsertLine(sessionId, {
      id: lineId,
      fromPeerId: this.store.peerId,
      fromName: this.store.settings.name,
      kind: "system",
      text,
      pending: false,
      createdAt,
      codingLog: priorLine?.codingLog,
    });
    const room = groupId ? this.groupById(groupId) : undefined;
    if (!room) {
      this.syncBrief(peerId, sessionId);
      const wire: WireChat = {
        id: lineId,
        fromPeerId: this.store.peerId,
        fromName: this.store.settings.name,
        kind: "agent",
        text,
        createdAt,
        sessionId,
        sessionTitle: this.sessionTitle(sessionId),
        defer: true,
        brief: brief ? sanitizeBrief(brief) : undefined,
      };
      this.sendTo(peerId, "chat", wire);
      return;
    }
    room.turn = null;
    const payload = {
      groupId: room.id,
      sessionId,
      lineId,
      createdAt,
      text,
      fromPeerId: this.store.peerId,
      fromName: this.store.settings.name,
    };
    this.syncBrief(groupKey(room.id), sessionId);
    if (room.hostId === this.store.peerId) this.relay(room, "group-pause", payload);
    else this.sendTo(room.hostId, "group-pause", payload);
  }

  private finishAborted(sessionId: string, id: string, note = "Đã dừng."): void {
    const line = this.findLine(sessionId, id);
    if (!line) return;
    if (!line.text.trim()) {
      const list = this.store.transcripts[sessionId] ?? [];
      this.store.transcripts[sessionId] = list.filter((item) => item.id !== id);
    } else {
      line.pending = false;
      line.text = `${line.text}\n(đã dừng)`;
    }
    this.appendLine(sessionId, this.makeLine(sessionId, this.store.peerId, this.store.settings.name, "system", note));
  }

  notifyActivity(peerId: string, patch: ActivityPatch): void {
    const groupId = parseGroupKey(peerId);
    if (groupId) {
      const room = this.groupById(groupId);
      if (!room) return;
      this.relay(room, "group-activity", {
        ...patch,
        groupId,
        fromPeerId: this.store.peerId,
        fromName: this.store.settings.name,
      });
      return;
    }
    if (!peerId || !this.isLinked(peerId)) return;
    this.sendTo(peerId, "activity", patch);
  }

  private noteActivity(peerId: string, patch: ActivityPatch | undefined): void {
    const current = this.activity.get(peerId) ?? { typing: false, replying: false, typingSessionId: "", replyingSessionId: "" };
    const next: PeerActivity = {
      typing: typeof patch?.typing === "boolean" ? patch.typing : current.typing,
      replying: typeof patch?.replying === "boolean" ? patch.replying : current.replying,
      typingSessionId: current.typingSessionId,
      replyingSessionId: current.replyingSessionId,
    };
    if (patch?.typing && patch.sessionId) next.typingSessionId = patch.sessionId;
    if (patch?.replying && patch.sessionId) next.replyingSessionId = patch.sessionId;
    if (patch?.typing === false) next.typingSessionId = "";
    if (patch?.replying === false) next.replyingSessionId = "";
    const timer = this.activityTimers.get(peerId);
    if (timer) clearTimeout(timer);
    this.activityTimers.delete(peerId);
    if (!next.typing && !next.replying) this.activity.delete(peerId);
    else this.activity.set(peerId, next);
    if (next.typing) {
      const expire = setTimeout(() => {
        const live = this.activity.get(peerId);
        if (!live) return;
        live.typing = false;
        live.typingSessionId = "";
        if (!live.replying) this.activity.delete(peerId);
        this.activityTimers.delete(peerId);
        this.push();
      }, 2500);
      this.activityTimers.set(peerId, expire);
    }
    this.push();
  }

  private sendTo(peerId: string, event: string, payload: unknown): boolean {
    const inbound = this.inbound.get(peerId);
    if (inbound?.connected) {
      inbound.emit(event, payload);
      return true;
    }
    const outbound = this.outbound.get(peerId);
    if (outbound?.connected) {
      outbound.emit(event, payload);
      return true;
    }
    return false;
  }

  private scheduleDelta(peerId: string, sessionId: string, id: string): void {
    this.push();
    const key = `${peerId}:${id}`;
    if (this.deltaTimers.has(key)) return;
    const timer = setTimeout(() => {
      this.deltaTimers.delete(key);
      const line = this.findLine(sessionId, id);
      if (!line) return;
      const published = this.publishMentions(line.text, this.mentionPeople(peerId));
      const delta: WireDelta = {
        id,
        fromPeerId: this.store.peerId,
        fromName: this.store.settings.name,
        text: published.text,
        createdAt: line.createdAt,
        sessionId,
      };
      const groupId = parseGroupKey(peerId);
      if (groupId) {
        const room = this.groupById(groupId);
        if (!room) return;
        this.relay(room, "group-delta", { ...delta, groupId });
        return;
      }
      this.sendTo(peerId, "delta", delta);
    }, 80);
    this.deltaTimers.set(key, timer);
  }

  private makeLine(
    peerId: string,
    fromPeerId: string,
    fromName: string,
    kind: ChatLine["kind"],
    text: string,
  ): ChatLine {
    void peerId;
    return {
      id: randomUUID(),
      fromPeerId,
      fromName,
      kind,
      text,
      pending: false,
      createdAt: Date.now(),
    };
  }

  private appendLine(sessionId: string, line: ChatLine): void {
    this.upsertLine(sessionId, line);
    this.pushNow();
    this.scheduleSave();
  }

  private upsertLine(sessionId: string, line: ChatLine): void {
    const list = this.store.transcripts[sessionId] ?? [];
    const index = list.findIndex((item) => item.id === line.id);
    if (index >= 0) list[index] = line;
    else list.push(line);
    while (list.length > MAX_LINES) list.shift();
    this.store.transcripts[sessionId] = list;
  }

  private findLine(sessionId: string, id: string): ChatLine | undefined {
    return this.store.transcripts[sessionId]?.find((line) => line.id === id);
  }

  private system(peerId: string, text: string, file?: FileRef, journal = true): void {
    if (journal) this.journalProblem(this.who(peerId), text);
    const line = this.makeLine(peerId, this.store.peerId, this.store.settings.name, "system", text);
    if (file) line.file = file;
    this.appendLine(this.ensureSession(peerId), line);
  }

  private toWire(line: ChatLine, sessionId: string): WireChat {
    return {
      id: line.id,
      fromPeerId: line.fromPeerId,
      fromName: line.fromName,
      kind: line.kind === "agent" ? "agent" : "human",
      text: line.text,
      createdAt: line.createdAt,
      sessionId,
      sessionTitle: this.sessionTitle(sessionId),
      attachment: line.attachment
        ? {
            name: line.attachment.remoteName || line.attachment.name,
            kind: line.attachment.kind,
            excerpt: line.attachment.excerpt,
          }
        : undefined,
      mentions: line.mentions,
    };
  }

  private remember(id: string): boolean {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > SEEN_LIMIT) {
      const old = this.seenOrder.shift();
      if (old) this.seen.delete(old);
    }
    return true;
  }

  private isLinked(peerId: string): boolean {
    return Boolean(this.inbound.get(peerId)?.connected || this.outbound.get(peerId)?.connected);
  }

  private statusOf(peerId: string): LinkStatus {
    if (this.isLinked(peerId)) return "connected";
    if (this.pendingHello.has(peerId) || this.knockWait.has(peerId)) return "pending-in";
    return this.status.get(peerId) ?? "none";
  }

  private autoAccept(): boolean {
    return this.sessionAutoAccept || this.store.settings.autoAccept;
  }

  private readHello(payload: Partial<HelloPayload> | undefined): HelloPayload | null {
    if (!payload?.peerId || typeof payload.peerId !== "string") return null;
    if (payload.peerId === this.store.peerId) return null;
    return {
      peerId: payload.peerId.slice(0, 80),
      name: String(payload.name || "Máy lạ").slice(0, 40),
      provider: String(payload.provider || "echo").slice(0, 20),
      token: String(payload.token || ""),
      port: Number(payload.port) || 0,
      initiatedBy: String(payload.initiatedBy || ""),
    };
  }

  createGroup(): AppState {
    const id = randomUUID();
    const key = groupKey(id);
    const session = this.addSession(key, undefined, "Nhóm mới");
    const room: GroupRoom = {
      id,
      title: "Nhóm mới",
      hostId: this.store.peerId,
      members: [{ peerId: this.store.peerId, name: this.store.settings.name }],
      sessionId: session.id,
      turn: null,
    };
    this.store.groups.push(room);
    this.groupNote(room, "Đã tạo nhóm. Mời máy đã nối. Một nhóm chứa tối đa 5 máy.", false);
    this.scheduleSave();
    this.pushNow();
    this.log("Đã tạo nhóm");
    return this.snapshot();
  }

  inviteGroup(groupId: string, peerId: string): AppState {
    const room = this.groupById(groupId);
    if (!room) return this.snapshot();
    if (room.hostId !== this.store.peerId) throw new Error("Chỉ máy tạo nhóm mới mời được.");
    if (peerId === this.store.peerId || room.members.some((member) => member.peerId === peerId)) return this.snapshot();
    if (room.members.length >= GROUP_MAX) throw new Error("Nhóm chỉ chứa tối đa 5 máy.");
    if (!this.isLinked(peerId)) throw new Error("Hãy nối máy đó trước khi mời vào nhóm.");
    const member = this.memberRecord({
      peerId,
      name: this.endpoints.get(peerId)?.name || this.store.trusted[peerId]?.name || "Máy",
    });
    room.members.push(member);
    this.groupNote(room, `Đã mời ${member.name} vào nhóm.`, true);
    this.relay(room, "group", this.wireGroup(room));
    this.scheduleSave();
    this.pushNow();
    this.log(`Đã mời ${member.name} vào nhóm`);
    return this.snapshot();
  }

  leaveGroup(groupId: string, peerId?: string): AppState {
    const room = this.groupById(groupId);
    if (!room) return this.snapshot();
    const target = peerId || this.store.peerId;
    const host = room.hostId === this.store.peerId;
    if (target !== this.store.peerId && !host) throw new Error("Chỉ máy tạo nhóm mới cho máy khác rời.");
    if (target === room.hostId) {
      this.groupNote(room, "Nhóm đã đóng.", false);
      this.relay(room, "group-close", { groupId: room.id, text: "Nhóm đã đóng." });
      this.removeGroup(room);
      return this.snapshot();
    }
    if (!host) {
      this.sendTo(room.hostId, "group-leave", { groupId: room.id, peerId: this.store.peerId });
      this.groupNote(room, "Bạn đã rời nhóm.", false);
      this.removeGroup(room);
      return this.snapshot();
    }
    this.removeMember(room, target);
    return this.snapshot();
  }

  renameGroup(groupId: string, title: string): AppState {
    const room = this.groupById(groupId);
    if (!room || room.hostId !== this.store.peerId) return this.snapshot();
    const clean = title.replace(/\s+/g, " ").trim().slice(0, 42);
    if (!clean) return this.snapshot();
    room.title = clean;
    const session = (this.store.sessions[groupKey(room.id)] ?? []).find((item) => item.id === room.sessionId);
    if (session && !session.pinned) session.title = clean;
    this.relay(room, "group", this.wireGroup(room));
    this.scheduleSave();
    this.pushNow();
    return this.snapshot();
  }

  private async sendGroup(key: string, text: string, attachmentPath?: string): Promise<void> {
    const room = this.roomFromKey(key);
    if (!room) return;
    if (!this.groupReachable(room)) {
      this.groupNote(room, "Cần nối với máy chủ nhóm trước khi gửi.", false);
      return;
    }
    let attachment: DiscussFile | undefined;
    try {
      if (attachmentPath?.trim()) attachment = await this.deliverGroupFile(room, attachmentPath);
    } catch (err) {
      this.groupNote(room, this.recordError(`gửi file đính kèm trong nhóm ${room.title}`, err, "Không gửi được file đính kèm."), false);
      return;
    }
    const spoken = text.trim().slice(0, LINE_CAP) || (attachment ? `Đọc file đính kèm ${attachment.name} và trao đổi nội dung.` : "");
    if (!spoken) return;
    const mentions = mentionTargets(spoken, this.aliasList(room.members.map((member) => this.memberRecord(member))));
    const sessionId = this.viewedGroupSession(room);
    this.nameSession(key, sessionId, spoken);
    const line = this.makeLine(key, this.store.peerId, this.store.settings.name, "human", spoken);
    line.mentions = mentions;
    if (attachment) {
      line.attachment = attachment;
      const preview = fileRef(attachment.path);
      if (preview) {
        line.file = preview;
        allowPreview(attachment.path);
      }
    }
    this.appendLine(sessionId, line);
    const wire = this.toWire(line, sessionId);
    const published = this.publishMentions(spoken, this.aliasList(room.members.map((member) => this.memberRecord(member))));
    wire.text = published.text;
    wire.mentions = published.mentions;
    const busy = Boolean(room.turn && room.turn.left > 0);
    if (!busy && mentions.length) wire.queue = "ping";
    this.dispatchGroup(room, wire);
  }

  private async startGroupBrief(key: string, wanted = ""): Promise<AppState> {
    const room = this.roomFromKey(key);
    if (!room) return this.snapshot();
    const known = Boolean(wanted && (this.store.sessions[key] ?? []).some((session) => session.id === wanted));
    const sessionId = known ? wanted : this.viewedGroupSession(room);
    const brief = this.ensureBrief(sessionId);
    if (!brief.running && !brief.topic.trim()) this.takeQueued(key, sessionId);
    if (!brief.topic.trim()) {
      this.groupNote(room, "Hãy nhập chủ đề trước khi bắt đầu.", false);
      return this.snapshot();
    }
    if (!this.groupReachable(room)) {
      this.groupNote(room, "Cần nối với máy chủ nhóm trước khi bắt đầu chủ đề.", false);
      return this.snapshot();
    }
    if (room.turn && room.turn.left > 0) {
      this.groupNote(room, "Đang có lượt. Bấm Dừng trước khi bắt đầu vòng mới.", false);
      return this.snapshot();
    }
    if (brief.coding && !room.members.some((member) => codingRole(member.role))) {
      this.groupNote(room, "Hãy phân vai cho ít nhất một agent trước khi bắt đầu chế độ coding.", false);
      return this.snapshot();
    }
    this.haltGroupLocal(room, false);
    brief.running = true;
    brief.turnsUsed = 0;
    brief.needTurns = 0;
    if (brief.coding) {
      brief.codingSince = Date.now();
      this.resetCodingView(sessionId);
    }
    brief.turnLimit = clampTurnLimit(brief.turnLimit, brief.coding ? CODING_TURN_MAX : BRIEF_TURN_MAX);
    this.pushNow();
    try {
      if (room.hostId === this.store.peerId) await this.pushBriefFilesGroup(room, sessionId);
      else await this.pushBriefFiles(room.hostId, sessionId, brief);
    } catch (err) {
      brief.running = false;
      this.groupNote(room, this.recordError(`gửi file context trong nhóm ${room.title}`, err, "Không gửi được file context."), false);
      return this.snapshot();
    }
    const mentions = mentionTargets(brief.topic, this.aliasList(room.members.map((member) => this.memberRecord(member))));
    this.nameSession(key, sessionId, brief.topic);
    const line = this.makeLine(key, this.store.peerId, this.store.settings.name, "human", brief.topic);
    line.mentions = mentions;
    this.appendLine(sessionId, line);
    const wire = this.toWire(line, sessionId);
    const published = this.publishMentions(brief.topic, this.aliasList(room.members.map((member) => this.memberRecord(member))));
    wire.text = published.text;
    wire.mentions = published.mentions;
    wire.queue = "topic";
    wire.dialogue = { repliesLeft: brief.turnLimit };
    wire.brief = sanitizeBrief(brief);
    this.dispatchGroup(room, wire);
    this.scheduleSave();
    return this.snapshot();
  }

  private extendGroup(key: string, extra?: number): AppState {
    const room = this.roomFromKey(key);
    if (!room) return this.snapshot();
    const brief = this.ensureBrief(this.viewedGroupSession(room));
    const cap = brief.coding ? CODING_TURN_MAX : BRIEF_TURN_MAX;
    const requested = Math.round(Number(extra));
    const add = Number.isFinite(requested) && requested > 0 ? Math.min(cap, requested) : BRIEF_EXTEND;
    if (!this.groupReachable(room)) {
      this.groupNote(room, "Cần nối với máy chủ nhóm trước khi gia hạn lượt.", false);
      return this.snapshot();
    }
    if (!brief.topic.trim()) {
      this.groupNote(room, "Hãy nhập chủ đề trước khi gia hạn.", false);
      return this.snapshot();
    }
    if (room.hostId !== this.store.peerId) {
      this.sendTo(room.hostId, "group-extend", { groupId: room.id, extra: add, sessionId: this.viewedGroupSession(room) });
      return this.snapshot();
    }
    return this.applyGroupExtend(room, add);
  }

  private applyGroupExtend(room: GroupRoom, add: number, sessionId = this.viewedGroupSession(room)): AppState {
    const brief = this.ensureBrief(sessionId);
    const cap = brief.coding ? CODING_TURN_MAX : BRIEF_TURN_MAX;
    const nextLimit = brief.turnsUsed >= brief.turnLimit ? brief.turnsUsed + add : brief.turnLimit + add;
    brief.turnLimit = clampTurnLimit(nextLimit, cap);
    brief.needTurns = 0;
    if (room.turn && room.turn.left > 0 && sessionId !== room.sessionId) {
      this.groupNote(room, "Đang có lượt ở phiên khác. Bấm Dừng trước khi gia hạn phiên này.", false, sessionId);
      return this.snapshot();
    }
    if (room.turn && room.turn.left > 0 && room.turn.mode === "topic") {
      const last = room.turn.order[room.turn.order.length - 1] || room.turn.speakerId;
      const more = brief.coding ? codingSpeakOrder(room.members, add, last) : speakOrder(room.members, [], add, last, "topic");
      room.turn = { ...room.turn, order: [...room.turn.order, ...more], left: room.turn.left + more.length };
      this.syncBrief(groupKey(room.id), sessionId);
      this.relay(room, "group-turn", { groupId: room.id, sessionId, turn: room.turn, go: false } satisfies WireGroupTurn);
      this.scheduleSave();
      this.pushNow();
      return this.snapshot();
    }
    brief.running = true;
    const mentions = mentionTargets(brief.topic, this.aliasList(room.members.map((member) => this.memberRecord(member))));
    const after = brief.coding ? this.lastAgentId(sessionId) : this.store.peerId;
    const order = brief.coding ? codingSpeakOrder(room.members, add, after) : speakOrder(room.members, mentions, add, this.store.peerId, "topic");
    const ticket = this.skipOffline(room, ticketFrom(order, "topic"));
    room.sessionId = sessionId;
    room.turn = ticket;
    this.syncBrief(groupKey(room.id), sessionId);
    this.relay(room, "group-turn", { groupId: room.id, sessionId, turn: ticket, go: Boolean(ticket) } satisfies WireGroupTurn);
    if (ticket?.speakerId === this.store.peerId) {
      void this.enqueueReply(groupKey(room.id), sessionId, true, room.id);
    }
    this.scheduleSave();
    this.pushNow();
    return this.snapshot();
  }

  private async addGroupFiles(key: string, paths: string[]): Promise<AppState> {
    const room = this.roomFromKey(key);
    if (!room) return this.snapshot();
    const sessionId = this.viewedGroupSession(room);
    const brief = this.ensureBrief(sessionId);
    if (brief.running) return this.snapshot();
    let missed = false;
    for (const filePath of Array.isArray(paths) ? paths : []) {
      if (typeof filePath !== "string" || !filePath.trim()) continue;
      const replacing = brief.files.some((file) => file.name === safeFileName(path.basename(filePath)));
      if (!replacing && brief.files.length >= BRIEF_FILE_MAX) {
        this.groupNote(room, `Hồ sơ chỉ giữ ${BRIEF_FILE_MAX} file.`, false);
        break;
      }
      try {
        const stored = await this.storeBriefFile(sessionId, filePath);
        for (const target of this.fileTargets(room)) {
          if (!this.isLinked(target)) {
            missed = true;
            continue;
          }
          await this.postBriefFile(target, sessionId, stored.name, stored.data);
        }
        const next = { name: stored.name, kind: stored.kind, excerpt: stored.excerpt };
        const index = brief.files.findIndex((file) => file.name === stored.name);
        if (index >= 0) brief.files[index] = next;
        else brief.files.push(next);
      } catch (err) {
        this.groupNote(room, this.recordError(`thêm file context trong nhóm ${room.title}`, err, "Không thêm được file context."), false);
      }
    }
    if (missed) this.groupNote(room, "Có máy trong nhóm chưa nối, file context sẽ gửi khi bắt đầu nếu máy đó đã vào.", false);
    this.syncBrief(key, sessionId);
    this.scheduleSave();
    this.pushNow();
    return this.snapshot();
  }

  private async sendGroupFile(key: string, filePath: string, allowOutside: boolean): Promise<void> {
    const room = this.roomFromKey(key);
    if (!room) return;
    const resolved = allowOutside ? path.resolve(filePath) : resolveInside(this.store.settings.workDir, filePath);
    if (!fs.existsSync(resolved)) throw new Error("Không thấy file.");
    const data = await readFileLimited(resolved, MAX_FILE_BYTES);
    const name = safeFileName(path.basename(resolved));
    const ref = fileRef(resolved);
    if (ref) allowPreview(resolved);
    let sent = 0;
    for (const target of this.fileTargets(room)) {
      if (!this.isLinked(target)) continue;
      await this.postFile(target, name, data);
      sent += 1;
    }
    const note = this.groupNote(
      room,
      sent ? `Đã gửi file ${name} (${formatBytes(data.length)}) cho ${sent} máy trong nhóm.` : `Chưa gửi được ${name} vì chưa nối máy nào trong nhóm.`,
      true,
    );
    if (ref) note.file = ref;
    this.pushNow();
  }

  private bindRoom(socket: LiveSocket, peerId: () => string | null): void {
    socket.on("group", (body: WireGroup) => {
      const id = peerId();
      if (id) this.onGroupSnapshot(id, body);
    });
    socket.on("group-chat", (body: WireChat) => {
      const id = peerId();
      if (id) void this.onGroupChat(id, body);
    });
    socket.on("group-delta", (body: WireDelta) => {
      const id = peerId();
      if (id) this.onGroupDelta(id, body);
    });
    socket.on("group-brief", (body: WireBrief & { groupId?: string }) => {
      const id = peerId();
      if (id) this.onGroupBrief(id, body);
    });
    socket.on("group-turn", (body: WireGroupTurn) => {
      const id = peerId();
      if (id) this.onGroupTurn(id, body);
    });
    socket.on("group-note", (body: { id?: string; groupId?: string; text?: string; sessionId?: string }) => {
      const id = peerId();
      if (id) this.onGroupNote(id, body);
    });
    socket.on("group-halt", (body: { groupId?: string }) => {
      const id = peerId();
      if (id) this.onGroupHalt(id, String(body?.groupId || ""));
    });
    socket.on("group-pause", (body: { groupId?: string; sessionId?: string; lineId?: string; createdAt?: number; text?: string; fromPeerId?: string; fromName?: string }) => {
      const id = peerId();
      if (id) this.onGroupPause(id, body);
    });
    socket.on("group-leave", (body: { groupId?: string; peerId?: string }) => {
      const id = peerId();
      if (id) this.onGroupLeave(id, body);
    });
    socket.on("group-close", (body: { groupId?: string; text?: string }) => {
      const id = peerId();
      if (id) this.onGroupClose(id, body);
    });
    socket.on("group-clear", (body: { groupId?: string; sessionId?: string }) => {
      const id = peerId();
      if (id) this.onGroupClear(id, body);
    });
    socket.on("group-result", (body: { groupId?: string; sessionId?: string; text?: string }) => {
      const id = peerId();
      if (id) void this.onGroupResult(id, body);
    });
    socket.on("group-session-new", (body: { groupId?: string }) => {
      const id = peerId();
      if (id) this.onGroupSessionNew(id, body);
    });
    socket.on("group-session", (body: { groupId?: string; id?: string; title?: string; createdAt?: number; open?: boolean }) => {
      const id = peerId();
      if (id) this.onGroupSession(id, body);
    });
    socket.on("group-session-drop", (body: { groupId?: string; id?: string }) => {
      const id = peerId();
      if (id) this.onGroupSessionDrop(id, body);
    });
    socket.on("group-extend", (body: { groupId?: string; extra?: number; sessionId?: string }) => {
      const id = peerId();
      if (!id || !body?.groupId) return;
      const room = this.groupById(body.groupId);
      if (!room || room.hostId !== this.store.peerId || !room.members.some((member) => member.peerId === id)) return;
      const sessionId = body.sessionId || room.sessionId;
      const brief = this.ensureBrief(sessionId);
      const cap = brief.coding ? CODING_TURN_MAX : BRIEF_TURN_MAX;
      const requested = Math.round(Number(body.extra));
      const add = Number.isFinite(requested) && requested > 0 ? Math.min(cap, requested) : BRIEF_EXTEND;
      this.applyGroupExtend(room, add, sessionId);
    });
    socket.on("group-activity", (body: ActivityPatch) => {
      const id = peerId();
      if (id) this.onGroupActivity(id, body);
    });
  }

  private async onGroupChat(socketPeer: string, msg: WireChat): Promise<void> {
    const room = this.groupById(msg?.groupId || "");
    if (!room || !msg?.id || msg.fromPeerId === this.store.peerId) return;
    if (!this.groupSocketOk(room, socketPeer, msg.fromPeerId)) return;
    const sessionId = this.adoptSession(groupKey(room.id), msg.sessionId || room.sessionId, msg.sessionTitle);
    if (!room.sessionId || (msg.turn && msg.turn.left > 0)) room.sessionId = sessionId;
    const attachment = this.localDiscuss(msg.attachment);
    this.upsertLine(sessionId, {
      id: msg.id,
      fromPeerId: msg.fromPeerId,
      fromName: msg.fromName || "Máy",
      kind: msg.kind === "agent" ? "agent" : "human",
      text: String(msg.text ?? "").slice(0, 100_000),
      pending: false,
      createdAt: msg.createdAt || Date.now(),
      attachment,
      file: attachment ? fileRef(attachment.path) ?? undefined : undefined,
      mentions: Array.isArray(msg.mentions) ? msg.mentions.filter((item) => item?.peerId && item.name).slice(0, 8) : undefined,
    });
    if (msg.brief) this.applyBrief(groupKey(room.id), sessionId, msg.brief);
    if (!this.remember(msg.id)) {
      this.pushNow();
      return;
    }
    this.arrive(groupKey(room.id), sessionId, room.title, `${msg.fromName || "Máy"}: ${String(msg.text ?? "")}`);
    const hostTurn = room.hostId === this.store.peerId && msg.fromPeerId === socketPeer;
    if (hostTurn) {
      if (msg.queue === "topic" && msg.brief) {
        try {
          await this.pushBriefFilesGroup(room, sessionId, msg.fromPeerId);
        } catch (err) {
          this.groupNote(room, this.recordError(`chuyển file context trong nhóm ${room.title}`, err, "Không chuyển được file context."), true);
        }
      }
      if (msg.attachment) {
        try {
          await this.forwardAttachment(room, msg);
        } catch (err) {
          this.groupNote(room, this.recordError(`chuyển file đính kèm trong nhóm ${room.title}`, err, "Không chuyển được file đính kèm."), true);
        }
      }
      this.planIncoming(room, msg);
      this.relay(room, "group-chat", msg, socketPeer);
      this.afterPlan(room, msg, socketPeer);
      return;
    }
    if (msg.turn !== undefined) room.turn = msg.turn ? sanitizeTicket(msg.turn) : null;
    this.pushNow();
    if (msg.cue && room.turn?.speakerId === this.store.peerId) {
      void this.enqueueReply(groupKey(room.id), sessionId, room.turn.mode === "topic", room.id);
    }
  }

  private onGroupDelta(socketPeer: string, delta: WireDelta): void {
    const room = this.groupById(delta?.groupId || "");
    if (!room || !delta?.id || delta.fromPeerId === this.store.peerId) return;
    if (!this.groupSocketOk(room, socketPeer, delta.fromPeerId)) return;
    const sessionId = delta.sessionId || room.sessionId || "";
    if (delta.sessionId) this.adoptSession(groupKey(room.id), delta.sessionId);
    if (!sessionId) return;
    if (room.hostId === this.store.peerId && delta.fromPeerId === socketPeer) {
      this.relay(room, "group-delta", delta, socketPeer);
    }
    const existing = this.findLine(sessionId, delta.id);
    if (existing && !existing.pending) return;
    this.upsertLine(sessionId, {
      id: delta.id,
      fromPeerId: delta.fromPeerId,
      fromName: delta.fromName || "Máy",
      kind: "agent",
      text: String(delta.text ?? ""),
      pending: true,
      createdAt: existing?.createdAt ?? delta.createdAt ?? Date.now(),
    });
    this.push();
  }

  private onGroupBrief(socketPeer: string, body: WireBrief & { groupId?: string }): void {
    const room = this.groupById(body?.groupId || "");
    if (!room || !body?.sessionId || !body.brief) return;
    if (socketPeer !== room.hostId && room.hostId !== this.store.peerId) return;
    if (room.hostId === this.store.peerId && socketPeer === room.hostId) return;
    const sessionId = this.adoptSession(groupKey(room.id), body.sessionId, body.sessionTitle);
    room.sessionId = room.sessionId || sessionId;
    this.applyBrief(groupKey(room.id), sessionId, body.brief);
    if (room.hostId === this.store.peerId) this.relay(room, "group-brief", body, socketPeer);
    this.scheduleSave();
    this.pushNow();
  }

  private onGroupTurn(socketPeer: string, body: WireGroupTurn): void {
    const room = this.groupById(body?.groupId || "");
    if (!room || socketPeer !== room.hostId || room.hostId === this.store.peerId) return;
    room.turn = body.turn ? sanitizeTicket(body.turn) : null;
    const sessionId = body.sessionId || room.sessionId;
    this.pushNow();
    if (!body.go || room.turn?.speakerId !== this.store.peerId || this.aborts.has(groupKey(room.id))) return;
    void this.enqueueReply(groupKey(room.id), sessionId, room.turn.mode === "topic", room.id);
  }

  private onGroupNote(socketPeer: string, body: { id?: string; groupId?: string; text?: string; sessionId?: string }): void {
    const room = this.groupById(body?.groupId || "");
    if (!room || !body?.id || !body.text) return;
    if (socketPeer !== room.hostId && room.hostId !== this.store.peerId) return;
    if (!this.remember(body.id)) return;
    if (room.hostId === this.store.peerId && socketPeer !== this.store.peerId) this.relay(room, "group-note", body, socketPeer);
    const sessionId = this.adoptSession(groupKey(room.id), body.sessionId || room.sessionId);
    this.upsertLine(sessionId, {
      id: body.id,
      fromPeerId: room.hostId,
      fromName: this.memberName(room, room.hostId),
      kind: "system",
      text: body.text.slice(0, 500),
      pending: false,
      createdAt: Date.now(),
    });
    this.scheduleSave();
    this.pushNow();
  }

  private onGroupPause(
    socketPeer: string,
    body: { groupId?: string; sessionId?: string; lineId?: string; createdAt?: number; text?: string; fromPeerId?: string; fromName?: string },
  ): void {
    const room = this.groupById(body?.groupId || "");
    if (!room || !body?.sessionId || !body.lineId || !body.text) return;
    const hostHere = room.hostId === this.store.peerId;
    if (hostHere) {
      if (socketPeer === this.store.peerId || !room.members.some((member) => member.peerId === socketPeer)) return;
      if (room.turn && room.turn.speakerId !== socketPeer) return;
      this.applyCodingPause(room, body);
      this.relay(room, "group-pause", { ...body, groupId: room.id }, socketPeer);
      return;
    }
    if (socketPeer !== room.hostId) return;
    this.applyCodingPause(room, body);
  }

  private applyCodingPause(
    room: GroupRoom,
    body: { sessionId?: string; lineId?: string; createdAt?: number; text?: string; fromPeerId?: string; fromName?: string },
  ): void {
    if (!body.sessionId || !body.lineId || !body.text) return;
    room.turn = null;
    const brief = this.store.briefs[body.sessionId];
    if (brief) brief.running = false;
    const existing = this.findLine(body.sessionId, body.lineId);
    const incoming = body.text.slice(0, 100_000);
    const note = "Chủ đề coding tạm dừng.";
    const text = existing && existing.text.length > incoming.length ? (existing.text.includes(note) ? existing.text : `${existing.text}\n${note}`) : incoming;
    this.upsertLine(body.sessionId, {
      id: body.lineId,
      fromPeerId: body.fromPeerId || room.hostId,
      fromName: body.fromName || this.memberName(room, body.fromPeerId || room.hostId),
      kind: "system",
      text,
      pending: false,
      createdAt: body.createdAt || Date.now(),
    });
    this.scheduleSave();
    this.pushNow();
  }

  private onGroupHalt(socketPeer: string, groupId: string): void {
    const room = this.groupById(groupId);
    if (!room) return;
    if (room.hostId !== this.store.peerId && socketPeer !== room.hostId) return;
    if (room.hostId === this.store.peerId) this.relay(room, "group-halt", { groupId }, socketPeer);
    this.haltGroupLocal(room, false);
    this.groupNote(room, "Đã dừng.", false);
  }

  private onGroupLeave(socketPeer: string, body: { groupId?: string; peerId?: string }): void {
    const room = this.groupById(body?.groupId || "");
    if (!room || room.hostId !== this.store.peerId || !body.peerId || body.peerId !== socketPeer) return;
    this.removeMember(room, body.peerId);
  }

  private onGroupClear(socketPeer: string, body: { groupId?: string; sessionId?: string }): void {
    const room = this.groupById(String(body?.groupId || ""));
    if (!room || socketPeer !== room.hostId || room.hostId === this.store.peerId) return;
    const sessionId = String(body.sessionId || room.sessionId || "");
    if (sessionId) room.sessionId = sessionId;
    room.turn = null;
    if (room.sessionId) {
      this.store.transcripts[room.sessionId] = [];
      delete this.store.briefs[room.sessionId];
      this.forgetRun(room.sessionId);
      this.clearCli(room.sessionId);
    }
    this.groupNote(room, "Máy tạo nhóm đã xóa hội thoại.", false);
    this.scheduleSave();
    this.pushNow();
  }

  private onGroupClose(socketPeer: string, body: { groupId?: string; text?: string }): void {
    const room = this.groupById(body?.groupId || "");
    if (!room || socketPeer !== room.hostId || room.hostId === this.store.peerId) return;
    this.groupNote(room, String(body.text || "Bạn không còn trong nhóm.").slice(0, 200), false);
    this.removeGroup(room);
  }

  private onGroupActivity(socketPeer: string, body: ActivityPatch): void {
    const room = this.groupById(body?.groupId || "");
    if (!room || !body.fromPeerId) return;
    if (!this.groupSocketOk(room, socketPeer, body.fromPeerId)) return;
    if (room.hostId === this.store.peerId && body.fromPeerId === socketPeer) this.relay(room, "group-activity", body, socketPeer);
    this.noteActivity(body.fromPeerId, body);
  }

  private onGroupSnapshot(socketPeer: string, body: WireGroup): void {
    if (!body?.id || !/^[a-zA-Z0-9_-]{1,80}$/.test(body.id) || socketPeer !== body.hostId) return;
    if (body.hostId === this.store.peerId) return;
    const members = sanitizeMembers(body.members);
    if (!members.some((member) => member.peerId === this.store.peerId) || !members.some((member) => member.peerId === body.hostId)) return;
    let room = this.groupById(body.id);
    if (room && room.hostId !== body.hostId) return;
    const title = String(body.title || "Nhóm").replace(/\s+/g, " ").trim().slice(0, 42) || "Nhóm";
    if (!room) {
      room = { id: body.id, title, hostId: body.hostId, members, sessionId: "", turn: null };
      this.store.groups.push(room);
    } else {
      room.title = title;
      room.members = members;
    }
    const key = groupKey(room.id);
    const previous = this.store.openSessions[key];
    for (const item of body.sessions ?? []) {
      if (!item?.id || item.id.length > 80) continue;
      this.adoptSession(key, item.id, item.title);
      this.ingestGroupHistory(room, item.id, item.history ?? []);
    }
    const sessionId = this.adoptSession(key, body.sessionId, body.sessionTitle || title);
    room.sessionId = sessionId;
    const stillOpen = previous && (this.store.sessions[key] ?? []).some((session) => session.id === previous);
    this.store.openSessions[key] = stillOpen ? previous : sessionId;
    this.ingestGroupHistory(room, sessionId, body.history ?? []);
    this.scheduleSave();
    this.pushNow();
  }

  private ingestGroupHistory(room: GroupRoom, sessionId: string, lines: WireChat[]): void {
    void room;
    for (const line of lines) {
      if (!line?.id || (line.fromPeerId === this.store.peerId && this.findLine(sessionId, line.id))) continue;
      const attachment = this.localDiscuss(line.attachment);
      this.upsertLine(sessionId, {
        id: line.id,
        fromPeerId: line.fromPeerId,
        fromName: line.fromName || "Máy",
        kind: line.kind === "agent" ? "agent" : "human",
        text: String(line.text ?? "").slice(0, 100_000),
        pending: false,
        createdAt: line.createdAt || Date.now(),
        attachment,
        file: attachment ? fileRef(attachment.path) ?? undefined : undefined,
        mentions: line.mentions,
      });
      this.remember(line.id);
    }
  }

  private onGroupSessionNew(socketPeer: string, body: { groupId?: string }): void {
    const room = this.groupById(body?.groupId || "");
    if (!room || room.hostId !== this.store.peerId || socketPeer === this.store.peerId) return;
    if (!room.members.some((member) => member.peerId === socketPeer)) return;
    if (room.turn && room.turn.left > 0) {
      this.groupNote(room, this.busyTurnNote(room), true);
      return;
    }
    this.openFreshGroupSession(room);
  }

  private onGroupSession(socketPeer: string, body: { groupId?: string; id?: string; title?: string; createdAt?: number; open?: boolean }): void {
    const room = this.groupById(body?.groupId || "");
    if (!room || !body?.id || body.id.length > 80) return;
    const hostHere = room.hostId === this.store.peerId;
    if (hostHere) {
      if (socketPeer === this.store.peerId || !room.members.some((member) => member.peerId === socketPeer)) return;
      this.applyGroupSession(room, body);
      this.relay(room, "group-session", body, socketPeer);
      this.scheduleSave();
      this.pushNow();
      return;
    }
    if (socketPeer !== room.hostId) return;
    this.applyGroupSession(room, body);
    this.scheduleSave();
    this.pushNow();
  }

  private applyGroupSession(room: GroupRoom, body: { id?: string; title?: string; open?: boolean }): void {
    if (!body.id) return;
    const key = groupKey(room.id);
    const previous = this.store.openSessions[key];
    const title = body.title?.replace(/\s+/g, " ").trim().slice(0, 42);
    this.adoptSession(key, body.id, title);
    const session = (this.store.sessions[key] ?? []).find((item) => item.id === body.id);
    if (session && title) {
      session.title = title;
      if (!body.open) session.pinned = true;
    }
    if (body.open) {
      this.store.openSessions[key] = body.id;
      room.sessionId = body.id;
      this.watchPeer = key;
      this.watchSession = body.id;
      this.unread.delete(body.id);
      return;
    }
    if (previous && (this.store.sessions[key] ?? []).some((item) => item.id === previous)) this.store.openSessions[key] = previous;
    if (previous !== body.id) this.unread.add(body.id);
  }

  private onGroupSessionDrop(socketPeer: string, body: { groupId?: string; id?: string }): void {
    const room = this.groupById(body?.groupId || "");
    if (!room || !body?.id) return;
    const hostHere = room.hostId === this.store.peerId;
    if (hostHere) {
      if (socketPeer === this.store.peerId || !room.members.some((member) => member.peerId === socketPeer)) return;
      this.removeGroupSession(room, body.id);
      this.relay(room, "group-session-drop", body, socketPeer);
      this.scheduleSave();
      this.pushNow();
      return;
    }
    if (socketPeer !== room.hostId) return;
    this.removeGroupSession(room, body.id);
    this.scheduleSave();
    this.pushNow();
  }

  private dispatchGroup(room: GroupRoom, wire: WireChat): void {
    wire.groupId = room.id;
    if (room.hostId !== this.store.peerId) {
      this.relay(room, "group-chat", wire);
      return;
    }
    this.remember(wire.id);
    this.planIncoming(room, wire);
    this.relay(room, "group-chat", wire);
    this.afterPlan(room, wire, "");
  }

  private planIncoming(room: GroupRoom, msg: WireChat): void {
    const sessionId = msg.sessionId
      ? this.adoptSession(groupKey(room.id), msg.sessionId, msg.sessionTitle)
      : this.roomSession(room);
    msg.sessionId = sessionId;
    const turnLive = Boolean(room.turn && room.turn.left > 0 && room.sessionId);
    if (turnLive && sessionId !== room.sessionId) {
      msg.cue = false;
      msg.queue = undefined;
      msg.turn = room.turn;
      return;
    }
    if (!turnLive) room.sessionId = sessionId;
    if (msg.kind === "agent") {
      const settled = this.skipOffline(room, sanitizeTicket(msg.turn));
      msg.turn = settled;
      msg.cue = Boolean(settled);
      msg.queue = undefined;
      room.turn = settled;
      return;
    }
    const mentions = Array.isArray(msg.mentions) ? msg.mentions : [];
    const busy = Boolean(room.turn && room.turn.left > 0);
    if (msg.queue === "topic") {
      msg.queue = undefined;
      if (busy) {
        msg.cue = false;
        this.groupNote(room, "Đang có lượt. Đợi các agent nói xong, hoặc bấm Dừng.", true, sessionId);
        return;
      }
      const stored = this.store.briefs[sessionId];
      const coding = Boolean(msg.brief?.coding ?? stored?.coding);
      const turns = msg.dialogue?.repliesLeft || stored?.turnLimit || (coding ? CODING_TURN_DEFAULT : 6);
      const order = coding
        ? codingSpeakOrder(room.members, turns)
        : speakOrder(room.members, mentions, turns, msg.fromPeerId, "topic");
      const ticket = this.skipOffline(room, ticketFrom(order, "topic"));
      room.turn = ticket;
      msg.turn = ticket;
      msg.cue = Boolean(ticket);
      if (!ticket) {
        const brief = this.store.briefs[sessionId];
        if (brief) brief.running = false;
        this.groupNote(room, coding ? "Không có agent đã phân vai đang nối." : "Không có agent nào đang nối để xếp lượt.", true, sessionId);
      }
      return;
    }
    if (!busy && mentions.length) {
      const ticket = this.skipOffline(room, ticketFrom(speakOrder(room.members, mentions, mentions.length, msg.fromPeerId, "ping"), "ping"));
      room.turn = ticket;
      msg.turn = ticket;
      msg.cue = Boolean(ticket);
      msg.queue = undefined;
      return;
    }
    if (busy && mentions.length && room.turn) {
      const brief = this.ensureBrief(sessionId);
      const live = room.turn;
      if (brief.coding && live.mode === "topic") {
        msg.turn = live;
        msg.cue = false;
        msg.queue = undefined;
        return;
      }
      const extra = mentions.map((item) => item.peerId).filter((id) => id && !this.queuedFrom(live, id, live.index + 1));
      if (extra.length) room.turn = injectSpeakers(live, extra);
      msg.turn = room.turn;
      msg.cue = false;
      msg.queue = undefined;
      if (room.turn.mode === "topic") {
        brief.turnLimit = clampTurnLimit(Math.max(brief.turnLimit, brief.turnsUsed + room.turn.left), BRIEF_TURN_MAX);
        this.syncBrief(groupKey(room.id), sessionId);
      }
    }
  }

  private afterPlan(room: GroupRoom, wire: WireChat, origin: string): void {
    const speaker = room.turn?.speakerId || "";
    if (origin && wire.turn !== undefined) {
      this.sendTo(origin, "group-turn", {
        groupId: room.id,
        sessionId: wire.sessionId || room.sessionId,
        turn: room.turn,
        go: Boolean(wire.cue && speaker === origin),
      } satisfies WireGroupTurn);
    }
    if (wire.cue && speaker === this.store.peerId) {
      void this.enqueueReply(groupKey(room.id), wire.sessionId || room.sessionId, room.turn?.mode === "topic", room.id);
    }
    this.pushNow();
  }

  private finishGroupSpeech(groupId: string, sessionId: string, wire: WireChat, loop: boolean): void {
    const room = this.groupById(groupId);
    if (!room) return;
    const live = room.turn;
    const speaking = Boolean(live && live.speakerId === this.store.peerId);
    let upcoming: TurnTicket | null = speaking && live ? nextTicket(live) : live;
    if (speaking && live?.mode === "topic") {
      const brief = this.ensureBrief(sessionId);
      const text = wire.text || "";
      const done = Boolean(brief.coding && resultText(text));
      if (done) upcoming = null;
      if (brief.coding) brief.needTurns = done || upcoming ? 0 : codingNeed(text);
      const cap = brief.coding ? CODING_TURN_MAX : BRIEF_TURN_MAX;
      brief.turnLimit = clampTurnLimit(Math.max(brief.turnLimit, brief.turnsUsed + 1 + (upcoming ? upcoming.left : 0)), cap);
      this.finishBriefTurn(sessionId, wire);
      if (!upcoming) {
        brief.running = false;
        wire.dialogue = undefined;
        wire.brief = sanitizeBrief(brief);
      }
      if (done) void this.publishCodingResult(room, sessionId, text);
    }
    if (!speaking) upcoming = room.turn;
    if (speaking) upcoming = this.callsAfterSpeech(room, sessionId, wire.mentions, upcoming, live);
    if (speaking && room.hostId === this.store.peerId) upcoming = this.skipOffline(room, upcoming);
    if (speaking) room.turn = upcoming;
    wire.groupId = room.id;
    wire.sessionId = sessionId;
    wire.turn = speaking ? upcoming : room.turn;
    wire.cue = Boolean(speaking && upcoming);
    this.relay(room, "group-chat", wire);
    if (speaking && room.hostId === this.store.peerId && upcoming?.speakerId === this.store.peerId) {
      void this.enqueueReply(groupKey(room.id), sessionId, upcoming.mode === "topic", room.id);
    }
    this.pushNow();
  }

  private callsAfterSpeech(
    room: GroupRoom,
    sessionId: string,
    mentions: MentionRef[] | undefined,
    upcoming: TurnTicket | null,
    live: TurnTicket | null,
  ): TurnTicket | null {
    const codingTopic = Boolean(this.store.briefs[sessionId]?.coding && live?.mode === "topic");
    if (codingTopic) return upcoming;
    const seen = new Set<string>();
    const refs = (mentions ?? []).filter((item) => {
      if (!item.peerId || item.peerId === this.store.peerId || seen.has(item.peerId)) return false;
      if (this.queuedFrom(upcoming, item.peerId, upcoming?.index ?? 0)) return false;
      seen.add(item.peerId);
      return true;
    });
    if (!refs.length) return upcoming;
    if (upcoming) {
      const next = injectSpeakers(upcoming, refs.map((item) => item.peerId));
      const brief = this.store.briefs[sessionId];
      if (brief?.running && next.mode === "topic") {
        const cap = brief.coding ? CODING_TURN_MAX : BRIEF_TURN_MAX;
        brief.turnLimit = clampTurnLimit(Math.max(brief.turnLimit, brief.turnsUsed + next.left), cap);
      }
      return next;
    }
    return ticketFrom(speakOrder(room.members, refs, refs.length, this.store.peerId, "ping"), "ping");
  }

  private queuedFrom(ticket: TurnTicket | null, id: string, fromIndex: number): boolean {
    if (!ticket || !id) return false;
    for (let index = Math.max(0, fromIndex); index < ticket.order.length; index += 1) {
      if (ticket.order[index] === id) return true;
    }
    return false;
  }

  private haltGroupLocal(room: GroupRoom, tell: boolean): void {
    const key = groupKey(room.id);
    this.abortSummary(key);
    this.epochs.set(key, (this.epochs.get(key) ?? 0) + 1);
    this.aborts.get(key)?.abort();
    room.turn = null;
    const brief = room.sessionId ? this.store.briefs[room.sessionId] : undefined;
    if (brief?.running) brief.running = false;
    if (tell) this.relay(room, "group-halt", { groupId: room.id });
    this.scheduleSave();
    this.pushNow();
  }

  private removeMember(room: GroupRoom, peerId: string): void {
    const name = this.memberName(room, peerId);
    room.members = room.members.filter((member) => member.peerId !== peerId);
    if (room.turn?.speakerId === peerId) {
      const upcoming = this.skipOffline(room, nextTicket(room.turn));
      room.turn = upcoming;
      this.relay(room, "group-turn", {
        groupId: room.id,
        sessionId: room.sessionId,
        turn: upcoming,
        go: Boolean(upcoming),
      } satisfies WireGroupTurn);
      if (upcoming?.speakerId === this.store.peerId) {
        void this.enqueueReply(groupKey(room.id), room.sessionId, upcoming.mode === "topic", room.id);
      }
    }
    this.groupNote(room, `${name} đã rời nhóm.`, true);
    this.relay(room, "group", this.wireGroup(room));
    this.sendTo(peerId, "group-close", { groupId: room.id, text: "Bạn đã rời nhóm." });
    this.scheduleSave();
    this.pushNow();
  }

  private removeGroup(room: GroupRoom): void {
    this.haltGroupLocal(room, false);
    const key = groupKey(room.id);
    for (const session of this.store.sessions[key] ?? []) this.dropSession(key, session.id);
    delete this.store.sessions[key];
    delete this.store.openSessions[key];
    this.store.groups = this.store.groups.filter((item) => item.id !== room.id);
    this.scheduleSave();
    this.pushNow();
  }

  private dropSession(peerId: string, sessionId: string): void {
    this.store.sessions[peerId] = (this.store.sessions[peerId] ?? []).filter((session) => session.id !== sessionId);
    delete this.store.transcripts[sessionId];
    delete this.store.briefs[sessionId];
    this.forgetRun(sessionId);
    this.unread.delete(sessionId);
    if (this.store.openSessions[peerId] === sessionId) delete this.store.openSessions[peerId];
  }

  private aliasList(people: GroupMember[]): GroupMember[] {
    const aliases = Object.entries(this.store.nicknames).map(([peerId, name]) => ({ peerId, name }));
    return withSelfAlias(withAliases(people, aliases), this.store.peerId);
  }

  private publishMentions(text: string, people: GroupMember[]): { text: string; mentions: MentionRef[] } {
    return rewriteMentionLabels(text, people, (hit) => this.publicMentionLabel(hit.peerId, hit.name));
  }

  private publicMentionLabel(peerId: string, matched: string): string {
    if (peerId === this.store.peerId && matched.trim().toLowerCase() === "me") return "me";
    return this.realName(peerId) || matched;
  }

  private realName(peerId: string): string {
    if (peerId === this.store.peerId) return this.store.settings.name;
    const live = this.endpoints.get(peerId)?.name || this.store.trusted[peerId]?.name || "";
    if (live) return live;
    for (const room of this.store.groups) {
      const member = room.members.find((item) => item.peerId === peerId);
      if (member?.name) return member.name;
    }
    return "";
  }

  private advanceIfSpeakerLeft(peerId: string): void {
    if (this.isLinked(peerId)) return;
    for (const room of this.store.groups) {
      if (room.hostId !== this.store.peerId || room.turn?.speakerId !== peerId) continue;
      const upcoming = this.skipOffline(room, nextTicket(room.turn));
      room.turn = upcoming;
      this.relay(room, "group-turn", {
        groupId: room.id,
        sessionId: room.sessionId,
        turn: upcoming,
        go: Boolean(upcoming),
      } satisfies WireGroupTurn);
      if (upcoming?.speakerId === this.store.peerId) {
        void this.enqueueReply(groupKey(room.id), room.sessionId, upcoming.mode === "topic", room.id);
      }
    }
  }

  private syncGroupsTo(peerId: string): void {
    for (const room of this.store.groups) {
      if (room.hostId !== this.store.peerId || !room.members.some((member) => member.peerId === peerId)) continue;
      this.sendTo(peerId, "group", this.wireGroup(room));
      if (room.turn?.speakerId === peerId) {
        this.sendTo(peerId, "group-turn", {
          groupId: room.id,
          sessionId: room.sessionId,
          turn: room.turn,
          go: true,
        } satisfies WireGroupTurn);
      }
    }
  }

  private skipOffline(room: GroupRoom, ticket: TurnTicket | null): TurnTicket | null {
    let current = ticket;
    let hops = 0;
    while (current && !this.canHear(room, current.speakerId)) {
      this.groupNote(room, `${this.memberName(room, current.speakerId)} không nối, chuyển lượt.`, true);
      current = nextTicket(current);
      hops += 1;
      if (hops > CODING_TURN_MAX) return null;
    }
    return current;
  }

  private canHear(room: GroupRoom, peerId: string): boolean {
    void room;
    return peerId === this.store.peerId || this.isLinked(peerId);
  }

  private groupReachable(room: GroupRoom): boolean {
    return room.hostId === this.store.peerId || this.isLinked(room.hostId);
  }

  private fileTargets(room: GroupRoom): string[] {
    if (room.hostId === this.store.peerId) {
      return room.members.map((member) => member.peerId).filter((id) => id !== this.store.peerId);
    }
    return [room.hostId];
  }

  private async deliverGroupFile(room: GroupRoom, filePath: string): Promise<DiscussFile> {
    const resolved = path.resolve(filePath);
    const kind = discussKind(resolved);
    if (!kind) throw new Error("Chỉ nhận txt, md, ảnh, pdf, docx, xlsx, xls hoặc csv.");
    const data = await readFileLimited(resolved, MAX_FILE_BYTES);
    const root = path.resolve(this.store.settings.workDir);
    const rel = path.relative(root, resolved);
    const localPath = rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? resolved : await saveReceivedFile(root, path.basename(resolved), data);
    let remoteName = path.basename(localPath);
    for (const target of this.fileTargets(room)) {
      if (!this.isLinked(target)) continue;
      remoteName = await this.postFile(target, path.basename(localPath), data, true);
    }
    return {
      name: path.basename(localPath),
      path: localPath,
      kind,
      excerpt: discussExcerpt(localPath, data),
      remoteName,
    };
  }

  private async forwardAttachment(room: GroupRoom, msg: WireChat): Promise<void> {
    const name = safeFileName(String(msg.attachment?.name || ""));
    if (!name) return;
    const saved = path.join(path.resolve(this.store.settings.workDir), name);
    if (!fs.existsSync(saved)) return;
    const data = await readFileLimited(saved, MAX_FILE_BYTES);
    for (const member of room.members) {
      if (member.peerId === this.store.peerId || member.peerId === msg.fromPeerId || !this.isLinked(member.peerId)) continue;
      try {
        await this.postFile(member.peerId, name, data, true);
      } catch (err) {
        this.groupNote(room, this.recordError(`chuyển file đính kèm cho ${this.who(member.peerId)}`, err, "Không chuyển được file đính kèm."), false);
      }
    }
  }

  private async pushBriefFilesGroup(room: GroupRoom, sessionId: string, except = ""): Promise<void> {
    const brief = this.store.briefs[sessionId];
    if (!brief?.files.length) return;
    for (const member of room.members) {
      if (member.peerId === this.store.peerId || member.peerId === except || !this.isLinked(member.peerId)) continue;
      await this.pushBriefFiles(member.peerId, sessionId, brief);
    }
  }

  private wireGroup(room: GroupRoom): WireGroup {
    const sessions = (this.store.sessions[groupKey(room.id)] ?? []).map((session) => ({
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      history: this.wireHistory(room, session.id),
    }));
    return {
      id: room.id,
      title: room.title,
      hostId: room.hostId,
      members: room.members.map((member) => this.memberRecord(member)),
      sessionId: room.sessionId,
      sessionTitle: this.sessionTitle(room.sessionId),
      history: this.wireHistory(room, room.sessionId),
      sessions,
    };
  }

  private wireHistory(room: GroupRoom, sessionId: string): WireChat[] {
    const people = this.aliasList(room.members.map((member) => this.memberRecord(member)));
    return (this.store.transcripts[sessionId] ?? [])
      .filter((line) => line.kind !== "system" && !line.aside)
      .slice(-40)
      .map((line) => {
        const wire = this.toWire(line, sessionId);
        const published = this.publishMentions(line.text, people);
        wire.text = published.text;
        wire.mentions = published.mentions.length ? published.mentions : line.mentions;
        return wire;
      });
  }

  private groupNote(room: GroupRoom, text: string, tell: boolean, sessionId = this.viewedGroupSession(room)): ChatLine {
    this.journalProblem(`nhóm ${room.title}`, text);
    const line = this.makeLine(groupKey(room.id), this.store.peerId, this.store.settings.name, "system", text);
    this.appendLine(sessionId, line);
    if (tell) this.relay(room, "group-note", { id: line.id, groupId: room.id, sessionId, text });
    return line;
  }

  private relay(room: GroupRoom, event: string, payload: unknown, except?: string): void {
    if (room.hostId !== this.store.peerId) {
      if (except === room.hostId) return;
      this.sendTo(room.hostId, event, payload);
      return;
    }
    for (const member of room.members) {
      if (member.peerId === this.store.peerId || member.peerId === except) continue;
      this.sendTo(member.peerId, event, payload);
    }
  }

  private roomSession(room: GroupRoom): string {
    const key = groupKey(room.id);
    const known = room.sessionId && (this.store.sessions[key] ?? []).some((session) => session.id === room.sessionId);
    if (known) return room.sessionId;
    const sessionId = this.ensureSession(key);
    room.sessionId = sessionId;
    return sessionId;
  }

  private viewedGroupSession(room: GroupRoom): string {
    const key = groupKey(room.id);
    const open = this.store.openSessions[key];
    if (open && (this.store.sessions[key] ?? []).some((session) => session.id === open)) return open;
    const sessionId = this.roomSession(room);
    this.store.openSessions[key] = sessionId;
    return sessionId;
  }

  private createGroupSession(groupId: string): AppState {
    const room = this.groupById(groupId);
    if (!room) return this.snapshot();
    if (room.turn && room.turn.left > 0) {
      this.groupNote(room, this.busyTurnNote(room), false);
      return this.snapshot();
    }
    if (room.hostId !== this.store.peerId) {
      if (!this.groupReachable(room)) {
        this.groupNote(room, "Cần nối với máy chủ nhóm trước khi mở phiên mới.", false);
        return this.snapshot();
      }
      this.sendTo(room.hostId, "group-session-new", { groupId: room.id });
      return this.snapshot();
    }
    return this.openFreshGroupSession(room);
  }

  private openFreshGroupSession(room: GroupRoom): AppState {
    const key = groupKey(room.id);
    const session = this.addSession(key);
    this.store.transcripts[session.id] = [];
    this.store.openSessions[key] = session.id;
    room.sessionId = session.id;
    this.watchPeer = key;
    this.watchSession = session.id;
    this.unread.delete(session.id);
    this.publishGroupSession(room, session, true);
    this.scheduleSave();
    this.pushNow();
    return this.snapshot();
  }

  private publishGroupSession(room: GroupRoom, session: ChatSession, open: boolean): void {
    const payload = {
      groupId: room.id,
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      open,
    };
    if (room.hostId === this.store.peerId) this.relay(room, "group-session", payload);
    else this.sendTo(room.hostId, "group-session", payload);
  }

  private deleteGroupSession(groupId: string, sessionId: string): AppState {
    const room = this.groupById(groupId);
    if (!room) return this.snapshot();
    const key = groupKey(room.id);
    const list = this.store.sessions[key] ?? [];
    if (!list.some((session) => session.id === sessionId)) return this.snapshot();
    if (list.length <= 1) return this.clearGroupTalk(groupId);
    if (room.turn && room.turn.left > 0 && room.sessionId === sessionId) {
      this.groupNote(room, "Đang có lượt. Bấm Dừng trước khi xóa phiên này.", false);
      return this.snapshot();
    }
    this.removeGroupSession(room, sessionId);
    const payload = { groupId: room.id, id: sessionId };
    if (room.hostId === this.store.peerId) this.relay(room, "group-session-drop", payload);
    else this.sendTo(room.hostId, "group-session-drop", payload);
    this.scheduleSave();
    this.pushNow();
    return this.snapshot();
  }

  private removeGroupSession(room: GroupRoom, sessionId: string): void {
    const key = groupKey(room.id);
    const list = this.store.sessions[key] ?? [];
    if (!list.some((session) => session.id === sessionId) || list.length <= 1) return;
    this.dropSession(key, sessionId);
    if (room.sessionId === sessionId || !this.store.openSessions[key]) {
      const latest = [...(this.store.sessions[key] ?? [])].sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (latest) {
        room.sessionId = latest.id;
        this.store.openSessions[key] = latest.id;
      }
    }
  }

  private groupById(id: string): GroupRoom | undefined {
    return this.store.groups.find((room) => room.id === id);
  }

  private roomBySession(sessionId: string): GroupRoom | undefined {
    return this.store.groups.find((room) => (this.store.sessions[groupKey(room.id)] ?? []).some((session) => session.id === sessionId));
  }

  private roomFromKey(key: string): GroupRoom | undefined {
    const id = parseGroupKey(key);
    return id ? this.groupById(id) : undefined;
  }

  private groupSocketOk(room: GroupRoom, socketPeer: string, fromPeerId: string): boolean {
    if (!room.members.some((member) => member.peerId === fromPeerId)) return false;
    if (fromPeerId === socketPeer) return true;
    return socketPeer === room.hostId && room.hostId !== this.store.peerId;
  }

  private memberRecord(member: GroupMember): GroupMember {
    const role = codingRole(member.role);
    const name = member.peerId === this.store.peerId
      ? this.store.settings.name
      : this.endpoints.get(member.peerId)?.name || this.store.trusted[member.peerId]?.name || member.name || "Máy";
    return role ? { peerId: member.peerId, name, role } : { peerId: member.peerId, name };
  }

  private lastAgentId(sessionId: string): string {
    const lines = this.store.transcripts[sessionId] ?? [];
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (line?.kind === "agent" && line.fromPeerId && !line.aside) return line.fromPeerId;
    }
    return "";
  }

  queueTopic(peerKey: string, topic: string, goal: string): AppState {
    const sessionId = this.queueSession(peerKey);
    const clean = topic.trim().slice(0, BRIEF_TOPIC_CAP);
    if (!sessionId || !clean) return this.snapshot();
    const queue = this.store.topicQueues[sessionId] ?? { peerKey, items: [] };
    if (queue.items.length >= TOPIC_QUEUE_MAX) {
      this.runNote(peerKey, sessionId, `Hàng đợi chỉ giữ ${TOPIC_QUEUE_MAX} chủ đề.`);
      return this.snapshot();
    }
    queue.peerKey = peerKey;
    queue.items.push({ id: randomUUID(), topic: clean, goal: goal.trim().slice(0, BRIEF_GOAL_CAP) });
    this.store.topicQueues[sessionId] = queue;
    this.scheduleSave();
    this.pushNow();
    return this.snapshot();
  }

  dropTopic(peerKey: string, id: string): AppState {
    const sessionId = this.queueSession(peerKey);
    const queue = sessionId ? this.store.topicQueues[sessionId] : undefined;
    if (!queue) return this.snapshot();
    queue.items = queue.items.filter((item) => item.id !== id);
    if (!queue.items.length) delete this.store.topicQueues[sessionId];
    this.scheduleSave();
    this.pushNow();
    return this.snapshot();
  }

  private queueSession(peerKey: string): string {
    if (parseGroupKey(peerKey)) {
      const room = this.roomFromKey(peerKey);
      return room ? this.viewedGroupSession(room) : "";
    }
    return this.ensureSession(peerKey);
  }

  private takeQueued(peerKey: string, sessionId: string): boolean {
    const queue = this.store.topicQueues[sessionId];
    const next = queue?.items.shift();
    if (!queue || !next) return false;
    if (!queue.items.length) delete this.store.topicQueues[sessionId];
    const brief = this.ensureBrief(sessionId);
    brief.topic = next.topic;
    brief.goal = next.goal;
    this.runNote(peerKey, sessionId, `Lấy chủ đề kế tiếp trong hàng đợi: ${next.topic}`);
    this.scheduleSave();
    return true;
  }

  private forgetRun(sessionId: string): void {
    this.runs.delete(sessionId);
    delete this.store.topicQueues[sessionId];
  }

  // Theo dõi mọi chủ đề đang chạy. Khi một chủ đề dừng (xong, hết lượt hoặc bị dừng),
  // chờ một nhịp cho dòng cuối và ket-qua.md về tới máy, rồi ghi báo cáo lần chạy.
  private watchRuns(): void {
    for (const [sessionId, brief] of Object.entries(this.store.briefs)) {
      const run = this.runs.get(sessionId);
      if (brief.running && brief.topic.trim()) {
        if (!run) {
          this.runs.set(sessionId, {
            sessionId,
            startedAt: Date.now(),
            before: new Set((this.store.transcripts[sessionId] ?? []).map((line) => line.id)),
            topic: brief.topic,
            goal: brief.goal,
            coding: brief.coding,
            baseLimit: brief.turnLimit,
          });
        }
        continue;
      }
      if (!run) continue;
      this.runs.delete(sessionId);
      setTimeout(() => {
        this.closeRun(run).catch((err: unknown) => this.noteError("ghi báo cáo lần chạy chủ đề", err));
      }, RUN_SETTLE_MS);
    }
    for (const sessionId of this.runs.keys()) {
      if (!this.store.briefs[sessionId]) this.runs.delete(sessionId);
    }
  }

  private async closeRun(run: BriefRun): Promise<void> {
    const brief = this.store.briefs[run.sessionId];
    if (!brief) return;
    if (brief.running) {
      if (!this.runs.has(run.sessionId)) this.runs.set(run.sessionId, run);
      return;
    }
    const peerKey = this.sessionOwner(run.sessionId);
    const lines = (this.store.transcripts[run.sessionId] ?? []).filter((line) => !run.before.has(line.id));
    const replies = lines.filter((line) => line.kind === "agent" && !line.pending && line.text.trim());
    if (!peerKey || !replies.length) return;
    const final = [...replies].reverse().find((line) => resultText(line.text));
    const status: RunStatus = final ? "done" : brief.turnsUsed >= brief.turnLimit ? "limit" : "stopped";
    const room = this.roomFromKey(peerKey);
    const roleOf = (peerId: string) => {
      const role = codingRole(room?.members.find((member) => member.peerId === peerId)?.role);
      return role ? codingRoleLabel(role) : "";
    };
    const folder = briefFolder(this.store.settings.workDir, run.sessionId);
    const result = final ? await this.runResult(folder, run, final.text) : "";
    const decisions = run.coding && !hasDecisionSection(result) ? decisionSection(this.collectDecisions(replies, roleOf)) : "";
    const agents = [...new Set(replies.map((line) => {
      const role = roleOf(line.fromPeerId);
      return role ? `${line.fromName} (${role})` : line.fromName;
    }))].join(", ");
    const waiting = this.store.topicQueues[run.sessionId]?.items ?? [];
    const next = !waiting.length
      ? ""
      : status === "done"
        ? `tự chạy tiếp chủ đề "${waiting[0].topic}", còn ${waiting.length} chủ đề chờ`
        : `tạm dừng, còn ${waiting.length} chủ đề chờ`;
    await fs.promises.mkdir(folder, { recursive: true });
    const number = Math.max(0, ...fs.readdirSync(folder).map(reportNumber)) + 1;
    const name = reportFileName(number);
    const endedAt = Date.now() - RUN_SETTLE_MS;
    const markdown = runReportMarkdown({
      number,
      topic: run.topic,
      goal: run.goal,
      coding: run.coding,
      status,
      needTurns: brief.needTurns,
      turnsUsed: brief.turnsUsed,
      turnLimit: brief.turnLimit,
      startedAt: new Date(run.startedAt).toLocaleString("vi-VN"),
      endedAt: new Date(endedAt).toLocaleString("vi-VN"),
      minutes: Math.round((endedAt - run.startedAt) / 60_000),
      agents,
      result,
      lastReply: final ? "" : clipLog(replies[replies.length - 1]?.text ?? "", 6000),
      decisions,
      next,
    });
    const full = await saveExact(folder, name, Buffer.from(markdown, "utf8"));
    const preview = fileRef(full);
    if (preview) allowPreview(full);
    this.runNote(peerKey, run.sessionId, `Đã ghi báo cáo lần chạy ${String(number).padStart(2, "0")} (${runStatusText(status, brief.needTurns)}): ${name}`, preview);
    if (!waiting.length) return;
    if (status !== "done") {
      this.runNote(peerKey, run.sessionId, `Hàng đợi tạm dừng vì chủ đề này chưa có KẾT QUẢ. Bấm Gia hạn để làm tiếp, hoặc bấm Chạy chủ đề kế tiếp để bỏ qua.`);
      return;
    }
    setTimeout(() => {
      this.advanceQueue(peerKey, run).catch((err: unknown) => this.noteError("chạy chủ đề kế tiếp", err));
    }, 1000);
  }

  private async runResult(folder: string, run: BriefRun, finalText: string): Promise<string> {
    const full = path.join(folder, CODING_RESULT_FILE);
    try {
      const stat = await fs.promises.stat(full);
      if (stat.size > 0 && stat.mtimeMs >= run.startedAt - 1000) {
        return (await readFileLimited(full, 200_000)).toString("utf8");
      }
    } catch {
      // Chưa có ket-qua.md trên máy này: dùng khối KẾT QUẢ trong hội thoại.
    }
    return resultText(finalText);
  }

  private async advanceQueue(peerKey: string, run: BriefRun): Promise<void> {
    const brief = this.store.briefs[run.sessionId];
    if (!brief || brief.running || !this.store.topicQueues[run.sessionId]?.items.length) return;
    brief.turnLimit = run.baseLimit;
    brief.coding = run.coding;
    this.takeQueued(peerKey, run.sessionId);
    await this.startBrief(peerKey, run.sessionId);
    if (!this.store.briefs[run.sessionId]?.running) {
      this.runNote(peerKey, run.sessionId, "Chưa tự chạy được chủ đề kế tiếp. Kiểm tra kết nối rồi bấm Bắt đầu.");
    }
  }

  private sessionOwner(sessionId: string): string {
    for (const [key, list] of Object.entries(this.store.sessions)) {
      if (list.some((session) => session.id === sessionId)) return key;
    }
    return this.store.topicQueues[sessionId]?.peerKey ?? "";
  }

  private runNote(peerKey: string, sessionId: string, text: string, file?: ChatLine["file"] | null): void {
    const room = this.roomFromKey(peerKey);
    if (room) {
      const line = this.groupNote(room, text, false, sessionId);
      if (file) line.file = file;
    } else {
      const line = this.makeLine(peerKey, this.store.peerId, this.store.settings.name, "system", text);
      if (file) line.file = file;
      this.appendLine(sessionId, line);
    }
    this.pushNow();
  }

  private collectDecisions(lines: ChatLine[], roleOf?: (peerId: string) => string, extra?: { who: string; text: string }): DecisionEntry[] {
    const seen = new Set<string>();
    const entries: DecisionEntry[] = [];
    const label = (peerId: string, name: string) => {
      const role = roleOf?.(peerId) ?? "";
      return role ? `${name} · ${role}` : name;
    };
    const collect = (who: string, text: string) => {
      for (const block of decisionBlocks(text)) {
        const key = block.replace(/\s+/g, " ").toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push({ who, text: block });
      }
    };
    for (const line of lines) {
      if (line.kind !== "agent" || line.pending) continue;
      collect(label(line.fromPeerId, line.fromName || "Agent"), line.text);
    }
    if (extra) collect(label(this.store.peerId, extra.who), extra.text);
    return entries;
  }

  private withDecisions(sessionId: string, data: Buffer, finalText: string, roleOf?: (peerId: string) => string): Buffer {
    const markdown = data.toString("utf8");
    if (hasDecisionSection(markdown)) return data;
    const section = decisionSection(this.decisionEntries(sessionId, finalText, roleOf));
    return Buffer.from(`${markdown.trimEnd()}\n\n${section}\n`, "utf8");
  }

  private decisionEntries(sessionId: string, finalText: string, roleOf?: (peerId: string) => string): DecisionEntry[] {
    const since = this.store.briefs[sessionId]?.codingSince || 0;
    const lines = (this.store.transcripts[sessionId] ?? []).filter((line) => line.createdAt >= since);
    return this.collectDecisions(lines, roleOf, { who: this.store.settings.name, text: finalText });
  }

  private async publishPairCodingResult(peerId: string, sessionId: string, text: string): Promise<void> {
    const body = resultText(text);
    if (!body) return;
    try {
      const brief = this.ensureBrief(sessionId);
      const folder = briefFolder(this.store.settings.workDir, sessionId);
      const full = path.join(folder, CODING_RESULT_FILE);
      let data: Buffer | null = null;
      if (fs.existsSync(full)) {
        const stat = fs.statSync(full);
        const since = this.codingFileStamp.get(sessionId) ?? brief.codingSince ?? 0;
        if (stat.size > 0 && stat.mtimeMs > since) data = await readFileLimited(full, MAX_FILE_BYTES);
      }
      this.codingFileStamp.delete(sessionId);
      data = this.withDecisions(sessionId, data ?? Buffer.from(body, "utf8"), text);
      await saveExact(folder, CODING_RESULT_FILE, data);
      if (fileRef(full)) allowPreview(full);
      const entry = { name: CODING_RESULT_FILE, kind: "markdown" as const, excerpt: discussExcerpt(CODING_RESULT_FILE, data) };
      brief.files = brief.files.filter((file) => file.name !== CODING_RESULT_FILE);
      if (brief.files.length >= BRIEF_FILE_MAX) brief.files.pop();
      brief.files.push(entry);
      const sent = this.isLinked(peerId);
      if (sent) await this.postBriefFile(peerId, sessionId, CODING_RESULT_FILE, data);
      this.tell(sessionId, peerId, sent ? `Đã chuyển file ${CODING_RESULT_FILE} cho máy kia.` : `Đã ghi ${CODING_RESULT_FILE} trên máy này.`);
      this.syncBrief(peerId, sessionId);
      this.scheduleSave();
      this.pushNow();
    } catch (err) {
      this.system(peerId, this.recordError(`chuyển file kết quả cho ${this.who(peerId)}`, err, "Không chuyển được file kết quả."));
    }
  }

  private async publishCodingResult(room: GroupRoom, sessionId: string, text: string): Promise<void> {
    const body = resultText(text);
    if (!body) return;
    try {
      const brief = this.ensureBrief(sessionId);
      const folder = briefFolder(this.store.settings.workDir, sessionId);
      const full = path.join(folder, CODING_RESULT_FILE);
      let data: Buffer | null = null;
      if (fs.existsSync(full)) {
        const stat = fs.statSync(full);
        const since = this.codingFileStamp.get(sessionId) ?? brief.codingSince ?? 0;
        if (stat.size > 0 && stat.mtimeMs > since) data = await readFileLimited(full, MAX_FILE_BYTES);
      }
      this.codingFileStamp.delete(sessionId);
      data = this.withDecisions(sessionId, data ?? Buffer.from(body, "utf8"), text, (peerId) => {
        const role = codingRole(room.members.find((member) => member.peerId === peerId)?.role);
        return role ? codingRoleLabel(role) : "";
      });
      await saveExact(folder, CODING_RESULT_FILE, data);
      if (fileRef(full)) allowPreview(full);
      const entry = { name: CODING_RESULT_FILE, kind: "markdown" as const, excerpt: discussExcerpt(CODING_RESULT_FILE, data) };
      brief.files = brief.files.filter((file) => file.name !== CODING_RESULT_FILE);
      if (brief.files.length >= BRIEF_FILE_MAX) brief.files.pop();
      brief.files.push(entry);
      let sent = 0;
      for (const target of this.fileTargets(room)) {
        if (!this.isLinked(target)) continue;
        await this.postBriefFile(target, sessionId, CODING_RESULT_FILE, data);
        sent += 1;
      }
      if (room.hostId !== this.store.peerId) {
        this.sendTo(room.hostId, "group-result", {
          groupId: room.id,
          sessionId,
          text: data.toString("utf8").slice(0, 200_000),
        });
      }
      const others = room.members.some((member) => member.peerId !== this.store.peerId);
      this.groupNote(
        room,
        !others || sent > 0
          ? `Đã chuyển file ${CODING_RESULT_FILE} cho nhóm.`
          : `Chưa chuyển được ${CODING_RESULT_FILE} vì chưa nối máy nào trong nhóm.`,
        true,
      );
      this.syncBrief(groupKey(room.id), sessionId);
      this.scheduleSave();
      this.pushNow();
    } catch (err) {
      this.groupNote(room, this.recordError(`chuyển file kết quả trong nhóm ${room.title}`, err, "Không chuyển được file kết quả."), true);
    }
  }

  private async onGroupResult(socketPeer: string, body: { groupId?: string; sessionId?: string; text?: string }): Promise<void> {
    const room = this.groupById(String(body?.groupId || ""));
    if (!room || room.hostId !== this.store.peerId || socketPeer === room.hostId) return;
    if (!room.members.some((member) => member.peerId === socketPeer)) return;
    const sessionId = String(body?.sessionId || room.sessionId || "");
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(sessionId)) return;
    const folder = briefFolder(this.store.settings.workDir, sessionId);
    const full = path.join(folder, CODING_RESULT_FILE);
    if (!fs.existsSync(full)) {
      const text = String(body?.text || "").trim();
      if (!text) return;
      await saveExact(folder, CODING_RESULT_FILE, Buffer.from(text, "utf8"));
    }
    if (!fs.existsSync(full)) return;
    const data = await readFileLimited(full, MAX_FILE_BYTES);
    for (const member of room.members) {
      if (member.peerId === this.store.peerId || member.peerId === socketPeer || !this.isLinked(member.peerId)) continue;
      try {
        await this.postBriefFile(member.peerId, sessionId, CODING_RESULT_FILE, data);
      } catch (err) {
        this.groupNote(room, this.recordError(`chuyển file kết quả cho ${this.who(member.peerId)}`, err, "Không chuyển được file kết quả."), false);
      }
    }
  }

  private memberName(room: GroupRoom, peerId: string): string {
    const member = room.members.find((item) => item.peerId === peerId);
    return this.memberRecord(member || { peerId, name: "Máy" }).name;
  }

  private mentionPeople(peerId: string): GroupMember[] {
    const room = this.roomFromKey(peerId);
    if (room) return this.aliasList(room.members.map((member) => this.memberRecord(member)));
    const people: GroupMember[] = [{ peerId: this.store.peerId, name: this.store.settings.name }];
    const name = this.endpoints.get(peerId)?.name || this.store.trusted[peerId]?.name || "";
    if (name) people.push({ peerId, name });
    return this.aliasList(people);
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flushSave(), 400);
  }

  private flushSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.store.save();
  }

  private noteClis(report: CliReport, forceLog: boolean): void {
    this.localClis = report;
    const signature = [
      report.claude.installed,
      report.claude.path ?? "",
      report.claude.loggedIn,
      report.cursor.installed,
      report.cursor.path ?? "",
      report.cursor.loggedIn,
      report.codex.installed,
      report.codex.path ?? "",
      report.codex.loggedIn,
      report.gemini.installed,
      report.gemini.path ?? "",
      report.gemini.loggedIn,
    ].join("|");
    const changed = signature !== this.cliSignature;
    this.cliSignature = signature;
    if (changed || forceLog) this.log(cliLine(report));
    if (changed) this.pushNow();
  }

  private push(): void {
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      this.watchRuns();
      this.onChange();
    }, 50);
  }

  private pushNow(): void {
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }
    this.watchRuns();
    this.onChange();
  }

  noteError(scope: string, err: unknown): void {
    try {
      this.recordError(scope, err, "Có lỗi");
    } catch (crash) {
      console.error("[lan]", scope, err, crash);
    }
  }

  private who(peerId: string): string {
    const groupId = parseGroupKey(peerId);
    if (groupId) {
      const room = this.groupById(groupId);
      return room ? `nhóm ${room.title}` : "nhóm";
    }
    const name = this.endpoints.get(peerId)?.name || this.store.trusted[peerId]?.name || "máy kia";
    const endpoint = this.endpoints.get(peerId) ?? this.endpointFromTrusted(peerId);
    const host = this.linkHost.get(peerId) || endpoint?.host || "";
    const port = endpoint?.port || 0;
    return host && port ? `${name} (${host}:${port})` : name;
  }

  private recordError(scope: string, err: unknown, fallback = "Lỗi"): string {
    const friendly = err instanceof Error && err.message.trim() ? err.message.trim() : fallback;
    const parts = errorParts(err, fallback);
    const head = clipLog(parts[0] || fallback, 500);
    const probe = head.slice(0, 160);
    if (probe && this.logs.slice(-8).some((line) => line.includes(probe))) return friendly;
    this.log(`Lỗi · ${scope} · ${head}`);
    for (const extra of parts.slice(1, 6)) this.log(`Chi tiết · ${clipLog(extra, 500)}`);
    this.push();
    return friendly;
  }

  private journalProblem(scope: string, text: string): void {
    if (!isProblem(text)) return;
    const clean = clipLog(text.replace(/\s+/g, " ").trim(), 500);
    if (!clean) return;
    const probe = clean.slice(0, 160);
    if (this.logs.slice(-8).some((line) => line.includes(probe))) return;
    this.log(`Lỗi · ${scope} · ${clean}`);
  }

  private log(line: string): void {
    const stamp = new Date().toLocaleTimeString("vi-VN", { hour12: false });
    this.logs.push(`${stamp}  ${line}`);
    if (this.logs.length > 200) this.logs.splice(0, this.logs.length - 200);
    console.log(`[lan] ${line}`);
  }
}

function voiceName(name: string, agent: boolean): string {
  const clean = name.replace(/\s+/g, " ").trim() || "Máy";
  return agent ? `${clean} · agent` : clean;
}

function clipLog(text: string, max: number): string {
  const clean = text.replace(/\s+$/g, "");
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function isProblem(text: string): boolean {
  return /không |chưa |lỗi|từ chối|cần nối|cần kết nối|hãy |quá lâu|không còn|econn|eaddr|enotfound|etimedout|eacces|eperm|timeout|http \d{3}/i.test(text);
}

function errorParts(err: unknown, fallback: string): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  const meta: string[] = [];
  let exit = "";
  const push = (text: string) => {
    for (const raw of text.split(/\r?\n/)) {
      const clean = raw.replace(/\s+/g, " ").trim();
      if (!clean || clean === "fetch failed" || seen.has(clean)) continue;
      if (/^Mã thoát /.test(clean) || /CLI dừng trước khi trả mã thoát/.test(clean)) {
        exit = clean;
        seen.add(clean);
        continue;
      }
      seen.add(clean);
      if (lines.length < 4) lines.push(clean);
    }
  };
  let current: unknown = err;
  let depth = 0;
  while (current && depth < 5) {
    if (!(current instanceof Error)) {
      push(String(current));
      break;
    }
    const node = current as NodeJS.ErrnoException & { address?: string; port?: number };
    if (node.message) push(node.message);
    if (typeof node.code === "string" && node.code) meta.push(`mã ${node.code}`);
    if (node.syscall) meta.push(String(node.syscall));
    if (node.address) meta.push(node.port ? `${node.address}:${node.port}` : String(node.address));
    current = node.cause;
    depth += 1;
  }
  if (exit) lines.push(exit);
  if (meta.length) {
    const blob = lines.join(" ");
    const fresh = meta.filter((item) => !blob.includes(item.replace(/^mã /, "")));
    if (fresh.length) lines.push(fresh.join(" · "));
  }
  return lines.length ? lines.slice(0, 6) : [fallback];
}

function cliIntro(provider: ProviderId): string {
  if (provider === "claude-cli") return "Phiên này nằm trong Claude Code. Mở claude và chọn Resume để xem cùng hội thoại. Các lượt sau nối tiếp phiên đó.";
  if (provider === "cursor-cli") return "Phiên này nằm trong Cursor CLI. Chạy agent ls hoặc agent resume để mở lại. Khung chat trong Cursor IDE là kho riêng, chưa hiện phiên CLI.";
  if (provider === "codex-cli") return "Phiên này nằm trong Codex. Chạy codex resume để mở lại cùng hội thoại.";
  if (provider === "gemini-cli") return "Phiên này nằm trong Gemini CLI. Chạy gemini --resume trong cùng thư mục làm việc để mở lại. Các lượt sau nối tiếp phiên đó.";
  return "";
}

function basePort(profile: string): number {
  if (profile.toLowerCase() === "b") return DEFAULT_PORT + 10;
  return DEFAULT_PORT;
}

function cliLine(report: CliReport): string {
  const claude = toolLine(report.claude);
  const cursor = toolLine(report.cursor);
  const codex = toolLine(report.codex);
  const gemini = toolLine(report.gemini);
  return `CLI trên máy này — ${claude} · ${cursor} · ${codex} · ${gemini}`;
}

function toolLine(tool: CliReport["claude"]): string {
  if (!tool.installed) return `${tool.label} chưa có`;
  const login = tool.loggedIn === true ? ", đã đăng nhập" : tool.loggedIn === false ? ", chưa đăng nhập" : "";
  return `${tool.label} đã cài${login}`;
}

function rankStatus(status: LinkStatus): number {
  if (status === "connected") return 0;
  if (status === "pending-in") return 1;
  if (status === "pending-out" || status === "connecting") return 2;
  return 3;
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.message === "aborted");
}

function friendlyNet(err: unknown, fallback: string): string {
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return "Máy kia không trả lời kịp.";
  }
  return netCause(err) || fallback;
}

function netCause(err: unknown): string {
  if (err instanceof Error && "cause" in err && err.cause instanceof Error && err.cause.message) return err.cause.message;
  if (err instanceof Error && err.message && err.message !== "fetch failed") return err.message;
  if (err instanceof Error && "cause" in err && err.cause instanceof Error) return err.cause.message;
  return err instanceof Error ? err.message : "";
}

function relativeWorkPath(workDir: string, filePath: string): string {
  const raw = filePath.trim();
  const root = workDir.trim();
  if (!raw || !root) return raw;
  const base = path.resolve(root);
  const full = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(base, raw);
  const rel = path.relative(base, full);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return raw;
  return rel;
}
