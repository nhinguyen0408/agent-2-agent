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
  clampTurnLimit,
  emptyBrief,
  sanitizeBrief,
  type ProjectBrief,
} from "../shared/brief";
import {
  GROUP_MAX,
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
  Settings,
  WireBrief,
  WireChat,
  WireDelta,
  WireGroup,
  WireGroupTurn,
  WireResume,
} from "../shared/types";
import { DEFAULT_PORT, PORT_SPAN } from "../shared/types";
import { AgentHost, type ModelTurn } from "./agents";
import { detectLocalClis, installedCliList, parseCliList } from "./cliDetect";
import { Discovery, lanIPv4, normalizeIp } from "./discovery";
import { briefFolder, fileNameFromHeader, formatBytes, MAX_FILE_BYTES, readFileLimited, resolveInside, safeFileName, saveExact, saveReceivedFile } from "./files";
import { allowPreview } from "./preview";
import { discussExcerpt, discussKind, isDiscussKind } from "../shared/discuss";
import { fileRef, type FileRef } from "../shared/preview";
import { bearer, listen, readBody, readJson, remoteIp, sendJson } from "./httpUtil";
import { Store, sanitizeSettings } from "./store";

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
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private readonly greeted = new Set<string>();
  private readonly manualClose = new Set<string>();
  private readonly lastError = new Map<string, string>();
  private readonly deltaTimers = new Map<string, NodeJS.Timeout>();
  private logs: string[] = [];
  private localClis: CliReport = {
    claude: { id: "claude", label: "Claude CLI", installed: false, path: null, loggedIn: null },
    cursor: { id: "cursor", label: "Cursor CLI", installed: false, path: null, loggedIn: null },
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

  constructor(profile: string, sessionAutoAccept: boolean) {
    this.profile = profile;
    this.sessionAutoAccept = sessionAutoAccept;
    this.store = new Store(profile);
    this.agents = new AgentHost(() => this.store.settings);
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
      prev.cursorCommand !== next.cursorCommand;
    if (runtimeChanged) void this.agents.dispose();
    if (prev.claudeCommand !== next.claudeCommand || prev.cursorCommand !== next.cursorCommand) {
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
      throw new Error(err instanceof Error ? err.message : "Không gọi được /identity.");
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
      this.system(peerId, err instanceof Error ? err.message : "Không gửi được file đính kèm.");
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
    const callsPeer = !line.mentions?.length || Boolean(line.mentions.some((item) => item.peerId === peerId));
    const briefRunning = Boolean(this.store.briefs[sessionId]?.running);
    if (callsSelf && !briefRunning) {
      wire.defer = true;
      const sent = this.sendTo(peerId, "chat", wire);
      const epoch = this.epochs.get(peerId) ?? 0;
      await this.enqueueReply(peerId, sessionId);
      if ((this.epochs.get(peerId) ?? 0) !== epoch) return;
      if (sent) {
        this.sendTo(peerId, "after-me", { sessionId, sessionTitle: this.sessionTitle(sessionId) } satisfies WireResume);
        return;
      }
      if (!callsPeer) return;
    } else {
      if (callsSelf) void this.enqueueReply(peerId, sessionId);
      if (this.sendTo(peerId, "chat", wire)) return;
      if (!callsPeer) return;
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
      this.system(peerId, err instanceof Error ? err.message : "Không gửi được.");
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

  saveBrief(peerId: string, patch: { topic?: string; goal?: string; turnLimit?: number }): AppState {
    const sessionId = this.ensureSession(peerId);
    const brief = this.ensureBrief(sessionId);
    if (!brief.running) {
      brief.topic = String(patch.topic ?? brief.topic).trim().slice(0, BRIEF_TOPIC_CAP);
      brief.goal = String(patch.goal ?? brief.goal).trim().slice(0, BRIEF_GOAL_CAP);
      brief.turnLimit = clampTurnLimit(Number(patch.turnLimit ?? brief.turnLimit), BRIEF_TURN_MAX);
      this.syncBrief(peerId, sessionId);
      this.scheduleSave();
      this.pushNow();
    }
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
        this.system(peerId, err instanceof Error ? err.message : "Không thêm được file context.");
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

  async startBrief(peerId: string): Promise<AppState> {
    if (parseGroupKey(peerId)) return this.startGroupBrief(peerId);
    const sessionId = this.ensureSession(peerId);
    const brief = this.ensureBrief(sessionId);
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
    brief.turnLimit = clampTurnLimit(brief.turnLimit, BRIEF_TURN_MAX);
    this.pushNow();
    try {
      await this.pushBriefFiles(peerId, sessionId, brief);
    } catch (err) {
      brief.running = false;
      this.system(peerId, err instanceof Error ? err.message : "Không gửi được file context.");
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
    const requested = Math.round(Number(extra));
    const add = Number.isFinite(requested) && requested > 0 ? Math.min(BRIEF_TURN_MAX, requested) : BRIEF_EXTEND;
    if (!this.isLinked(peerId)) {
      this.system(peerId, "Cần nối socket trước khi gia hạn lượt.");
      return this.snapshot();
    }
    const sessionId = this.ensureSession(peerId);
    const brief = this.ensureBrief(sessionId);
    if (!brief.topic.trim()) {
      this.system(peerId, "Hãy nhập chủ đề trước khi gia hạn.");
      return this.snapshot();
    }
    const nextLimit = brief.turnsUsed >= brief.turnLimit ? brief.turnsUsed + add : brief.turnLimit + add;
    brief.turnLimit = clampTurnLimit(nextLimit, BRIEF_TURN_MAX);
    if (brief.running) {
      this.syncBrief(peerId, sessionId);
      this.scheduleSave();
      this.pushNow();
      return this.snapshot();
    }
    brief.running = true;
    this.syncBrief(peerId, sessionId);
    const lines = this.store.transcripts[sessionId] ?? [];
    const lastAgent = [...lines].reverse().find((line) => line.kind === "agent" && !line.pending);
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
      this.haltGroupLocal(room, true);
      if (!running) this.groupNote(room, "Đã dừng.", false);
      return;
    }
    const running = this.aborts.has(peerId);
    this.halt(peerId, true);
    if (!running) this.system(peerId, "Đã dừng.");
  }

  private async openPort(start: number): Promise<void> {
    let last = "hết dải cổng";
    for (let port = start; port < start + PORT_SPAN; port += 1) {
      const server = http.createServer((req, res) => {
        void this.onHttp(req, res);
      });
      const io = new Server(server, {
        cors: { origin: true },
        maxHttpBufferSize: 1_000_000,
        pingInterval: 5000,
        pingTimeout: 4000,
      });
      this.bindIo(io);
      try {
        await listen(server, port);
        server.on("error", (err) => this.log(`HTTP: ${err.message}`));
        this.server = server;
        this.io = io;
        this.port = port;
        return;
      } catch (err) {
        io.close();
        server.close();
        const code = (err as NodeJS.ErrnoException).code;
        last = err instanceof Error ? err.message : String(err);
        if (code !== "EADDRINUSE") throw err;
      }
    }
    throw new Error(`Không mở được cổng từ ${start}: ${last}`);
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
        this.system(bound, body.text.slice(0, 500));
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
    });
  }

  private onHello(socket: Socket, hello: HelloPayload): { ack: HelloAck; bound: string | null } {
    const peerId = hello.peerId;
    const host = normalizeIp(socket.handshake.address);
    this.upsertEndpoint(peerId, {
      name: hello.name,
      host,
      port: hello.port,
      provider: hello.provider,
      viaLocalhost: host === "127.0.0.1",
      discovered: true,
      lastSeen: Date.now(),
    });
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
    const socket = ioClient(`http://${endpoint.host}:${endpoint.port}`, {
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
          this.log(`${endpoint.name} chưa trả lời lời chào`);
          this.push();
          return;
        }
        if (ack.ok) {
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
      if (body?.text) this.system(peerId, body.text.slice(0, 500));
    });
    socket.on("activity", (body: ActivityPatch) => this.noteActivity(peerId, body));
    this.bindRoom(socket, () => peerId);
    socket.on("disconnect", () => this.onSocketDown(peerId, socket));
    socket.on("connect_error", (err: Error) => {
      this.log(`Lỗi nối ${endpoint.name}: ${err.message}`);
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
      this.system(peerId, message);
      throw new Error(message);
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
    await this.sendFile(peerId, requested, false);
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
    const briefSession = String(req.headers["x-brief-session"] || "");
    if (/^[a-zA-Z0-9_-]{1,80}$/.test(briefSession)) {
      const saved = await saveExact(briefFolder(this.store.settings.workDir, briefSession), name, data);
      if (fileRef(saved)) allowPreview(saved);
      sendJson(res, 200, { ok: true, name: path.basename(saved), bytes: data.length });
      return;
    }
    const saved = await saveReceivedFile(this.store.settings.workDir, name, data);
    const discuss = req.headers["x-discuss"] === "1";
    if (!discuss) {
      const from = this.endpoints.get(peerId)?.name || this.store.trusted[peerId]?.name || "Máy kia";
      this.system(peerId, `${from} đã gửi file ${path.basename(saved)} (${formatBytes(data.length)}). Lưu tại ${saved}`, fileRef(saved) ?? undefined);
    } else if (fileRef(saved)) {
      allowPreview(saved);
    }
    sendJson(res, 200, { ok: true, name: path.basename(saved), bytes: data.length });
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
    if (!endpoint?.host || !endpoint.port || !token) throw new Error("Hãy nối máy kia trước khi gửi file.");
    let res: Response;
    try {
      res = await fetch(`http://${endpoint.host}:${endpoint.port}/inbox-file`, {
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
      throw new Error(err instanceof Error ? err.message : "Không gửi được file qua LAN.");
    }
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; name?: string; error?: string };
    if (res.status === 404) throw new Error("Máy kia cần cài bản LAN Agents mới thì mới nhận được file.");
    if (!res.ok || !body.ok) throw new Error(body.error || `Máy kia không nhận file (HTTP ${res.status}).`);
    return body.name || name;
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
    const called = incomingMentions.length === 0 || incomingMentions.some((item) => item?.peerId === this.store.peerId);
    const shouldReply = !msg.defer && (dialogue ? dialogue.repliesLeft > 0 : msg.kind === "human" && called);
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
      const controller = new AbortController();
      this.aborts.set(peerId, controller);
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
      this.pushNow();
      this.notifyActivity(peerId, { replying: true, sessionId: bound });
      const room = groupId ? this.groupById(groupId) : undefined;
      try {
        const text = await this.agents.reply({
          peerId,
          selfName: this.store.settings.name,
          peerName: room
            ? room.members
                .filter((member) => member.peerId !== this.store.peerId)
                .map((member) => member.name)
                .join(", ") || "cả nhóm"
            : this.endpoints.get(peerId)?.name || this.store.trusted[peerId]?.name || "máy kia",
          history: this.modelHistory(bound),
          signal: controller.signal,
          fileRelay: room ? undefined : { url: `http://127.0.0.1:${this.port}/relay-file/${peerId}` },
          readings: this.readings(bound),
          brief: this.promptBrief(bound),
          room: room
            ? { title: room.title, members: room.members.map((member) => this.memberRecord(member).name).join(", ") }
            : undefined,
          together: room ? "cả nhóm" : undefined,
          onDelta: (chunk) => {
            if ((this.epochs.get(peerId) ?? 0) !== epoch) return;
            const line = this.findLine(bound, id);
            if (!line?.pending) return;
            line.text += chunk;
            this.scheduleDelta(peerId, bound, id);
          },
        });
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
        const published = this.publishMentions(text, this.mentionPeople(groupId ? groupKey(groupId) : peerId));
        const wire: WireChat = {
          id,
          fromPeerId: this.store.peerId,
          fromName: this.store.settings.name,
          kind: "agent",
          text: published.text,
          mentions: published.mentions,
          createdAt,
          sessionId: bound,
          sessionTitle: this.sessionTitle(bound),
        };
        if (groupId) this.finishGroupSpeech(groupId, bound, wire, loop);
        else {
          if (loop) this.finishBriefTurn(bound, wire);
          this.sendTo(peerId, "chat", wire);
        }
        this.lastError.delete(peerId);
        this.pushNow();
        this.scheduleSave();
        resolveOut(text);
      } catch (err) {
        if (isAbort(err) || (this.epochs.get(peerId) ?? 0) !== epoch) {
          this.finishAborted(bound, id);
          resolveOut("");
          return;
        }
        const message = err instanceof Error ? err.message : "Agent lỗi";
        this.lastError.set(peerId, message);
        this.upsertLine(bound, {
          id,
          fromPeerId: this.store.peerId,
          fromName: this.store.settings.name,
          kind: "system",
          text: message,
          pending: false,
          createdAt,
        });
        this.log(message);
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
        signal: AbortSignal.timeout(180_000),
      });
      const body = (await res.json()) as { ok?: boolean; reply?: string; error?: string };
      if (!res.ok || !body.ok || !body.reply) throw new Error(body.error || `HTTP ${res.status}`);
      return body.reply;
    } catch (err) {
      throw new Error(friendlyNet(err, "Không gọi được HTTP trigger."));
    }
  }

  private modelHistory(sessionId: string): ModelTurn[] {
    const lines = this.store.transcripts[sessionId] ?? [];
    const items: ModelTurn[] = [];
    for (const line of lines) {
      if (line.pending || line.kind === "system") continue;
      const text = this.turnText(line);
      if (!text.trim()) continue;
      if (line.kind === "human" && line.fromPeerId === this.store.peerId) {
        const callsSelf = line.mentions?.some((item) => item.peerId === this.store.peerId);
        if (callsSelf) {
          items.push({ role: "user", text, speaker: line.fromName });
          continue;
        }
        if (!line.attachment && !this.roomBySession(sessionId)) continue;
        items.push({ role: "note", text: `${line.fromName}: ${text}` });
        continue;
      }
      if (line.kind === "agent" && line.fromPeerId === this.store.peerId) {
        items.push({ role: "assistant", text: line.text, speaker: line.fromName });
      } else if (line.fromPeerId !== this.store.peerId) {
        items.push({ role: "user", text, speaker: line.fromName });
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
    if (preferHost || next.viaLocalhost || !prev.viaLocalhost) {
      if (next.host) prev.host = next.host;
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
    if (groupId) {
      const room = this.groupById(groupId);
      if (room) this.groupNote(room, "Nhóm dùng một phiên chung.", false);
      return this.snapshot();
    }
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
    if (groupId) {
      const room = this.groupById(groupId);
      if (room && (room.sessionId === sessionId || this.store.openSessions[peerId] === sessionId)) return this.clearGroupTalk(groupId);
      this.dropSession(peerId, sessionId);
      this.scheduleSave();
      this.pushNow();
      return this.snapshot();
    }
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
    const sessionId = this.roomSession(room);
    room.turn = null;
    this.store.transcripts[sessionId] = [];
    delete this.store.briefs[sessionId];
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

  renameSession(peerId: string, sessionId: string, title: string): AppState {
    const session = (this.store.sessions[peerId] ?? []).find((item) => item.id === sessionId);
    const clean = title.replace(/\s+/g, " ").trim().slice(0, 42);
    if (!session || !clean) return this.snapshot();
    session.title = clean;
    session.pinned = true;
    session.updatedAt = Date.now();
    this.sendTo(peerId, "session", { id: session.id, title: session.title, createdAt: session.createdAt });
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

  private finishAborted(sessionId: string, id: string): void {
    const line = this.findLine(sessionId, id);
    if (!line) return;
    if (!line.text.trim()) {
      const list = this.store.transcripts[sessionId] ?? [];
      this.store.transcripts[sessionId] = list.filter((item) => item.id !== id);
    } else {
      line.pending = false;
      line.text = `${line.text}\n(đã dừng)`;
    }
    const note = this.makeLine(sessionId, this.store.peerId, this.store.settings.name, "system", "Đã dừng.");
    this.appendLine(sessionId, note);
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

  private system(peerId: string, text: string, file?: FileRef): void {
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
      this.groupNote(room, err instanceof Error ? err.message : "Không gửi được file đính kèm.", false);
      return;
    }
    const spoken = text.trim().slice(0, LINE_CAP) || (attachment ? `Đọc file đính kèm ${attachment.name} và trao đổi nội dung.` : "");
    if (!spoken) return;
    const mentions = mentionTargets(spoken, this.aliasList(room.members.map((member) => this.memberRecord(member))));
    const sessionId = this.roomSession(room);
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

  private async startGroupBrief(key: string): Promise<AppState> {
    const room = this.roomFromKey(key);
    if (!room) return this.snapshot();
    const sessionId = this.roomSession(room);
    const brief = this.ensureBrief(sessionId);
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
    this.haltGroupLocal(room, false);
    brief.running = true;
    brief.turnsUsed = 0;
    brief.turnLimit = clampTurnLimit(brief.turnLimit, BRIEF_TURN_MAX);
    this.pushNow();
    try {
      if (room.hostId === this.store.peerId) await this.pushBriefFilesGroup(room, sessionId);
      else await this.pushBriefFiles(room.hostId, sessionId, brief);
    } catch (err) {
      brief.running = false;
      this.groupNote(room, err instanceof Error ? err.message : "Không gửi được file context.", false);
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
    const requested = Math.round(Number(extra));
    const add = Number.isFinite(requested) && requested > 0 ? Math.min(BRIEF_TURN_MAX, requested) : BRIEF_EXTEND;
    if (!this.groupReachable(room)) {
      this.groupNote(room, "Cần nối với máy chủ nhóm trước khi gia hạn lượt.", false);
      return this.snapshot();
    }
    const brief = this.ensureBrief(this.roomSession(room));
    if (!brief.topic.trim()) {
      this.groupNote(room, "Hãy nhập chủ đề trước khi gia hạn.", false);
      return this.snapshot();
    }
    if (room.hostId !== this.store.peerId) {
      this.sendTo(room.hostId, "group-extend", { groupId: room.id, extra: add });
      return this.snapshot();
    }
    return this.applyGroupExtend(room, add);
  }

  private applyGroupExtend(room: GroupRoom, add: number): AppState {
    const sessionId = this.roomSession(room);
    const brief = this.ensureBrief(sessionId);
    const nextLimit = brief.turnsUsed >= brief.turnLimit ? brief.turnsUsed + add : brief.turnLimit + add;
    brief.turnLimit = clampTurnLimit(nextLimit, BRIEF_TURN_MAX);
    if (room.turn && room.turn.left > 0 && room.turn.mode === "topic") {
      const more = speakOrder(room.members, [], add, room.turn.speakerId, "topic");
      room.turn = { ...room.turn, order: [...room.turn.order, ...more], left: room.turn.left + more.length };
      this.syncBrief(groupKey(room.id), sessionId);
      this.relay(room, "group-turn", { groupId: room.id, sessionId, turn: room.turn, go: false } satisfies WireGroupTurn);
      this.scheduleSave();
      this.pushNow();
      return this.snapshot();
    }
    brief.running = true;
    const mentions = mentionTargets(brief.topic, this.aliasList(room.members.map((member) => this.memberRecord(member))));
    const ticket = this.skipOffline(room, ticketFrom(speakOrder(room.members, mentions, add, this.store.peerId, "topic"), "topic"));
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
    const sessionId = this.roomSession(room);
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
        this.groupNote(room, err instanceof Error ? err.message : "Không thêm được file context.", false);
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
    socket.on("group-extend", (body: { groupId?: string; extra?: number }) => {
      const id = peerId();
      if (!id || !body?.groupId) return;
      const room = this.groupById(body.groupId);
      if (!room || room.hostId !== this.store.peerId || !room.members.some((member) => member.peerId === id)) return;
      const requested = Math.round(Number(body.extra));
      const add = Number.isFinite(requested) && requested > 0 ? Math.min(BRIEF_TURN_MAX, requested) : BRIEF_EXTEND;
      this.applyGroupExtend(room, add);
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
    room.sessionId = room.sessionId || sessionId;
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
          this.groupNote(room, err instanceof Error ? err.message : "Không chuyển được file context.", true);
        }
      }
      if (msg.attachment) {
        try {
          await this.forwardAttachment(room, msg);
        } catch (err) {
          this.groupNote(room, err instanceof Error ? err.message : "Không chuyển được file đính kèm.", true);
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
    const sessionId = room.sessionId || delta.sessionId || "";
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
    const sessionId = this.adoptSession(groupKey(room.id), body.sessionId, body.sessionTitle || title);
    room.sessionId = sessionId;
    this.store.openSessions[groupKey(room.id)] = sessionId;
    for (const line of body.history ?? []) {
      if (!line?.id || line.fromPeerId === this.store.peerId && this.findLine(sessionId, line.id)) continue;
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
        this.groupNote(room, "Đang có lượt. Đợi các agent nói xong, hoặc bấm Dừng.", true);
        return;
      }
      const turns = msg.dialogue?.repliesLeft || this.store.briefs[room.sessionId]?.turnLimit || 6;
      const ticket = this.skipOffline(room, ticketFrom(speakOrder(room.members, mentions, turns, msg.fromPeerId, "topic"), "topic"));
      room.turn = ticket;
      msg.turn = ticket;
      msg.cue = Boolean(ticket);
      if (!ticket) {
        const brief = this.store.briefs[room.sessionId];
        if (brief) brief.running = false;
        this.groupNote(room, "Không có agent nào đang nối để xếp lượt.", true);
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
      room.turn = injectSpeakers(room.turn, mentions.map((item) => item.peerId));
      msg.turn = room.turn;
      msg.cue = false;
      msg.queue = undefined;
      if (room.turn.mode === "topic") {
        const brief = this.ensureBrief(room.sessionId);
        brief.turnLimit = clampTurnLimit(Math.max(brief.turnLimit, brief.turnsUsed + room.turn.left), BRIEF_TURN_MAX);
        this.syncBrief(groupKey(room.id), room.sessionId);
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
      brief.turnLimit = clampTurnLimit(Math.max(brief.turnLimit, brief.turnsUsed + 1 + (upcoming ? upcoming.left : 0)), BRIEF_TURN_MAX);
      this.finishBriefTurn(sessionId, wire);
      if (!upcoming) {
        brief.running = false;
        wire.dialogue = undefined;
        wire.brief = sanitizeBrief(brief);
      }
    }
    if (!speaking) upcoming = room.turn;
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

  private haltGroupLocal(room: GroupRoom, tell: boolean): void {
    const key = groupKey(room.id);
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
      if (hops > 55) return null;
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
        this.groupNote(room, err instanceof Error ? err.message : "Không chuyển được file đính kèm.", false);
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
    const history = (this.store.transcripts[room.sessionId] ?? [])
      .filter((line) => line.kind !== "system")
      .slice(-40)
      .map((line) => {
        const wire = this.toWire(line, room.sessionId);
        const published = this.publishMentions(line.text, this.aliasList(room.members.map((member) => this.memberRecord(member))));
        wire.text = published.text;
        wire.mentions = published.mentions.length ? published.mentions : line.mentions;
        return wire;
      });
    return {
      id: room.id,
      title: room.title,
      hostId: room.hostId,
      members: room.members.map((member) => this.memberRecord(member)),
      sessionId: room.sessionId,
      sessionTitle: this.sessionTitle(room.sessionId),
      history,
    };
  }

  private groupNote(room: GroupRoom, text: string, tell: boolean): ChatLine {
    const sessionId = this.roomSession(room);
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
    if (known) {
      this.store.openSessions[key] = room.sessionId;
      return room.sessionId;
    }
    const sessionId = this.ensureSession(key);
    room.sessionId = sessionId;
    return sessionId;
  }

  private groupById(id: string): GroupRoom | undefined {
    return this.store.groups.find((room) => room.id === id);
  }

  private roomBySession(sessionId: string): GroupRoom | undefined {
    return this.store.groups.find((room) => room.sessionId === sessionId);
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
    if (member.peerId === this.store.peerId) return { peerId: member.peerId, name: this.store.settings.name };
    const name = this.endpoints.get(member.peerId)?.name || this.store.trusted[member.peerId]?.name || member.name;
    return { peerId: member.peerId, name: name || "Máy" };
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
      this.onChange();
    }, 50);
  }

  private pushNow(): void {
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }
    this.onChange();
  }

  private log(line: string): void {
    const stamp = new Date().toLocaleTimeString("vi-VN", { hour12: false });
    this.logs.push(`${stamp}  ${line}`);
    if (this.logs.length > 80) this.logs.splice(0, this.logs.length - 80);
    console.log(`[lan] ${line}`);
  }
}

function basePort(profile: string): number {
  if (profile.toLowerCase() === "b") return DEFAULT_PORT + 10;
  return DEFAULT_PORT;
}

function cliLine(report: CliReport): string {
  const claude = toolLine(report.claude);
  const cursor = toolLine(report.cursor);
  return `CLI trên máy này — ${claude} · ${cursor}`;
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
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
