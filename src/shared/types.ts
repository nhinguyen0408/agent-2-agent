import type { ProjectBrief } from "./brief";
import type { DiscussFile } from "./discuss";
import type { GroupRoom, MentionRef, TurnTicket } from "./group";
import type { FileRef, WorkFile } from "./preview";

export type { BriefFile, ProjectBrief } from "./brief";
export type { DiscussFile, DiscussKind } from "./discuss";
export type { GroupMember, GroupRoom, MentionRef, TurnTicket } from "./group";
export type { FileRef, WorkFile } from "./preview";

export const DEFAULT_PORT = 3940;
export const PORT_SPAN = 30;
export const DISCOVERY_PORT = 41234;
export const MULTICAST_ADDR = "239.255.77.77";

export const IPC = {
  state: "lan:state",
  notice: "lan:notice",
  getState: "lan:get-state",
  watch: "lan:watch",
  saveSettings: "lan:save-settings",
  connect: "lan:connect",
  connectAddress: "lan:connect-address",
  disconnect: "lan:disconnect",
  accept: "lan:accept",
  reject: "lan:reject",
  send: "lan:send",
  pickDiscuss: "lan:pick-discuss",
  dialogue: "lan:dialogue",
  stop: "lan:stop",
  pickCwd: "lan:pick-cwd",
  rescanClis: "lan:rescan-clis",
  activity: "lan:activity",
  sendFile: "lan:send-file",
  openPreview: "lan:open-preview",
  showPreview: "lan:show-preview",
  previewFile: "lan:preview-file",
  listWorkFiles: "lan:list-work-files",
  createSession: "lan:create-session",
  openSession: "lan:open-session",
  renameSession: "lan:rename-session",
  saveBrief: "lan:save-brief",
  pickBriefFiles: "lan:pick-brief-files",
  addBriefFiles: "lan:add-brief-files",
  removeBriefFile: "lan:remove-brief-file",
  openBriefFile: "lan:open-brief-file",
  startBrief: "lan:start-brief",
  extendBrief: "lan:extend-brief",
  createGroup: "lan:create-group",
  inviteGroup: "lan:invite-group",
  leaveGroup: "lan:leave-group",
  renameGroup: "lan:rename-group",
  setNickname: "lan:set-nickname",
  deleteSession: "lan:delete-session",
} as const;

export type ActivityPatch = {
  typing?: boolean;
  replying?: boolean;
  sessionId?: string;
  fromPeerId?: string;
  fromName?: string;
  groupId?: string;
};

export type PeerActivity = {
  typing: boolean;
  replying: boolean;
  typingSessionId: string;
  replyingSessionId: string;
};

export type ProviderId = "echo" | "claude-cli" | "cursor-cli" | "codex-cli";

export type Settings = {
  name: string;
  provider: ProviderId;
  workDir: string;
  claudeCommand: string;
  cursorCommand: string;
  codexCommand: string;
  autoAccept: boolean;
};

export type LinkStatus =
  | "none"
  | "connecting"
  | "pending-in"
  | "pending-out"
  | "connected";

export type CliToolState = {
  id: "claude" | "cursor" | "codex";
  label: string;
  installed: boolean;
  path: string | null;
  loggedIn: boolean | null;
};

export type CliReport = {
  claude: CliToolState;
  cursor: CliToolState;
  codex: CliToolState;
};

export type PeerView = {
  peerId: string;
  name: string;
  host: string;
  port: number;
  provider: string;
  clis: string;
  discovered: boolean;
  viaLocalhost: boolean;
  status: LinkStatus;
  token: string | null;
};

export type ChatSession = {
  id: string;
  peerId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  pinned?: boolean;
};

export type ChatLine = {
  id: string;
  fromPeerId: string;
  fromName: string;
  kind: "human" | "agent" | "system";
  text: string;
  pending: boolean;
  createdAt: number;
  file?: FileRef;
  attachment?: DiscussFile;
  mentions?: MentionRef[];
};

export type AppState = {
  self: {
    peerId: string;
    name: string;
    profile: string;
    provider: ProviderId;
    host: string;
    port: number;
  };
  settings: Settings;
  localClis: CliReport;
  activity: Record<string, PeerActivity>;
  peers: PeerView[];
  sessions: ChatSession[];
  openSession: Record<string, string>;
  unreadSessions: string[];
  transcripts: Record<string, ChatLine[]>;
  briefs: Record<string, ProjectBrief>;
  groups: GroupRoom[];
  nicknames: Record<string, string>;
  logs: string[];
};

export type WireChat = {
  id: string;
  fromPeerId: string;
  fromName: string;
  kind: "human" | "agent";
  text: string;
  createdAt: number;
  dialogue?: { repliesLeft: number };
  sessionId?: string;
  sessionTitle?: string;
  brief?: ProjectBrief;
  attachment?: { name: string; kind: DiscussFile["kind"]; excerpt: string };
  groupId?: string;
  mentions?: MentionRef[];
  defer?: boolean;
  turn?: TurnTicket | null;
  cue?: boolean;
  queue?: "topic" | "ping";
};

export type WireGroup = {
  id: string;
  title: string;
  hostId: string;
  members: GroupRoom["members"];
  sessionId: string;
  sessionTitle?: string;
  history?: WireChat[];
};

export type WireGroupTurn = {
  groupId: string;
  sessionId?: string;
  turn: TurnTicket | null;
  go?: boolean;
};

export type WireBrief = {
  sessionId: string;
  sessionTitle?: string;
  brief: ProjectBrief;
};

export type WireResume = {
  sessionId: string;
  sessionTitle?: string;
};

export type WireDelta = {
  id: string;
  fromPeerId: string;
  fromName: string;
  text: string;
  createdAt: number;
  sessionId?: string;
  groupId?: string;
};

export type HelloPayload = {
  peerId: string;
  name: string;
  provider: string;
  token: string;
  port: number;
  initiatedBy: string;
};

export type ChatNotice = {
  peerId: string;
  sessionId: string;
  title: string;
  body: string;
  open?: boolean;
};

export type HelloAck =
  | { ok: true; token: string; name: string }
  | { ok: false; pending?: boolean; error?: string };

export type LanApi = {
  getState: () => Promise<AppState>;
  watch: (peerId: string, sessionId: string) => Promise<void>;
  saveSettings: (settings: Settings) => Promise<AppState>;
  connect: (peerId: string) => Promise<void>;
  connectAddress: (host: string, port: number) => Promise<void>;
  disconnect: (peerId: string) => Promise<void>;
  accept: (peerId: string) => Promise<void>;
  reject: (peerId: string) => Promise<void>;
  send: (peerId: string, text: string, attachmentPath?: string) => Promise<void>;
  pickDiscuss: () => Promise<string | null>;
  dialogue: (peerId: string, topic: string, replies: number) => Promise<void>;
  saveBrief: (peerId: string, patch: { topic: string; goal: string; turnLimit: number }) => Promise<AppState>;
  pickBriefFiles: () => Promise<string[]>;
  addBriefFiles: (peerId: string, paths: string[]) => Promise<AppState>;
  removeBriefFile: (peerId: string, name: string) => Promise<AppState>;
  openBriefFile: (sessionId: string, name: string) => Promise<FileRef | null>;
  startBrief: (peerId: string) => Promise<AppState>;
  extendBrief: (peerId: string, extra?: number) => Promise<AppState>;
  createGroup: () => Promise<AppState>;
  inviteGroup: (groupId: string, peerId: string) => Promise<AppState>;
  leaveGroup: (groupId: string, peerId?: string) => Promise<AppState>;
  renameGroup: (groupId: string, title: string) => Promise<AppState>;
  setNickname: (peerId: string, nickname: string) => Promise<AppState>;
  deleteSession: (peerId: string, sessionId: string) => Promise<AppState>;
  stop: (peerId: string) => Promise<void>;
  pickCwd: () => Promise<string | null>;
  rescanClis: () => Promise<AppState>;
  activity: (peerId: string, patch: ActivityPatch) => Promise<void>;
  sendFile: (peerId: string) => Promise<string | null>;
  openPreview: () => Promise<FileRef | null>;
  showPreview: (file: FileRef) => Promise<boolean>;
  listWorkFiles: (dir: string) => Promise<{ found: boolean; files: WorkFile[] }>;
  createSession: (peerId: string) => Promise<AppState>;
  openSession: (peerId: string, sessionId: string) => Promise<AppState>;
  renameSession: (peerId: string, sessionId: string, title: string) => Promise<AppState>;
  onState: (listener: (state: AppState) => void) => () => void;
  onNotice: (listener: (notice: ChatNotice) => void) => () => void;
  onPreviewFile: (listener: (file: FileRef) => void) => () => void;
};

export function normalizeProvider(value: string): ProviderId {
  if (value === "claude" || value === "claude-cli") return "claude-cli";
  if (value === "cursor" || value === "cursor-cli") return "cursor-cli";
  if (value === "codex" || value === "codex-cli") return "codex-cli";
  return "echo";
}

export function isProviderId(value: string): value is ProviderId {
  return value === "echo" || value === "claude-cli" || value === "cursor-cli" || value === "codex-cli";
}

export function providerLabel(provider: string): string {
  if (provider === "echo") return "Echo";
  if (provider === "claude" || provider === "claude-cli") return "Claude terminal";
  if (provider === "cursor" || provider === "cursor-cli") return "Cursor terminal";
  if (provider === "codex" || provider === "codex-cli") return "Codex terminal";
  return provider || "Agent";
}
