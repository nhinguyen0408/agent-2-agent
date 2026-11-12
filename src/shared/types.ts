import type { DiscussFile } from "./discuss";
import type { FileRef, WorkFile } from "./preview";

export type { DiscussFile, DiscussKind } from "./discuss";
export type { FileRef, WorkFile } from "./preview";

export const DEFAULT_PORT = 3940;
export const PORT_SPAN = 30;
export const DISCOVERY_PORT = 41234;
export const MULTICAST_ADDR = "239.255.77.77";

export const IPC = {
  state: "lan:state",
  getState: "lan:get-state",
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
} as const;

export type ActivityPatch = {
  typing?: boolean;
  replying?: boolean;
};

export type PeerActivity = {
  typing: boolean;
  replying: boolean;
};

export type ProviderId = "echo" | "claude-cli" | "cursor-cli";

export type Settings = {
  name: string;
  provider: ProviderId;
  workDir: string;
  claudeCommand: string;
  cursorCommand: string;
  autoAccept: boolean;
};

export type LinkStatus =
  | "none"
  | "connecting"
  | "pending-in"
  | "pending-out"
  | "connected";

export type CliToolState = {
  id: "claude" | "cursor";
  label: string;
  installed: boolean;
  path: string | null;
  loggedIn: boolean | null;
};

export type CliReport = {
  claude: CliToolState;
  cursor: CliToolState;
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
  transcripts: Record<string, ChatLine[]>;
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
  attachment?: { name: string; kind: DiscussFile["kind"]; excerpt: string };
};

export type WireDelta = {
  id: string;
  fromPeerId: string;
  fromName: string;
  text: string;
  createdAt: number;
};

export type HelloPayload = {
  peerId: string;
  name: string;
  provider: string;
  token: string;
  port: number;
  initiatedBy: string;
};

export type HelloAck =
  | { ok: true; token: string; name: string }
  | { ok: false; pending?: boolean; error?: string };

export type LanApi = {
  getState: () => Promise<AppState>;
  saveSettings: (settings: Settings) => Promise<AppState>;
  connect: (peerId: string) => Promise<void>;
  connectAddress: (host: string, port: number) => Promise<void>;
  disconnect: (peerId: string) => Promise<void>;
  accept: (peerId: string) => Promise<void>;
  reject: (peerId: string) => Promise<void>;
  send: (peerId: string, text: string, attachmentPath?: string) => Promise<void>;
  pickDiscuss: () => Promise<string | null>;
  dialogue: (peerId: string, topic: string, replies: number) => Promise<void>;
  stop: (peerId: string) => Promise<void>;
  pickCwd: () => Promise<string | null>;
  rescanClis: () => Promise<AppState>;
  activity: (peerId: string, patch: ActivityPatch) => Promise<void>;
  sendFile: (peerId: string) => Promise<string | null>;
  openPreview: () => Promise<FileRef | null>;
  showPreview: (file: FileRef) => Promise<boolean>;
  listWorkFiles: (dir: string) => Promise<{ found: boolean; files: WorkFile[] }>;
  onState: (listener: (state: AppState) => void) => () => void;
  onPreviewFile: (listener: (file: FileRef) => void) => () => void;
};

export function normalizeProvider(value: string): ProviderId {
  if (value === "claude" || value === "claude-cli") return "claude-cli";
  if (value === "cursor" || value === "cursor-cli") return "cursor-cli";
  return "echo";
}

export function isProviderId(value: string): value is ProviderId {
  return value === "echo" || value === "claude-cli" || value === "cursor-cli";
}

export function providerLabel(provider: string): string {
  if (provider === "echo") return "Echo";
  if (provider === "claude" || provider === "claude-cli") return "Claude terminal";
  if (provider === "cursor" || provider === "cursor-cli") return "Cursor terminal";
  return provider || "Agent";
}
