import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import { sanitizeBrief, type ProjectBrief } from "../shared/brief";
import { sanitizeMembers, type GroupRoom } from "../shared/group";
import type { ChatLine, ChatSession, Settings } from "../shared/types";
import { normalizeProvider } from "../shared/types";

export type TrustedPeer = {
  name: string;
  token: string;
  host?: string;
  port?: number;
  provider?: string;
};

type Disk = {
  peerId: string;
  settings: Settings;
  trusted: Record<string, TrustedPeer>;
  sessions?: Record<string, ChatSession[]>;
  openSessions?: Record<string, string>;
  transcripts: Record<string, ChatLine[]>;
  briefs?: Record<string, ProjectBrief>;
  groups?: GroupRoom[];
  nicknames?: Record<string, string>;
};

export function defaultSettings(profile: string): Settings {
  const name = profile === "default" ? os.hostname() : `Agent ${profile}`;
  return {
    name,
    provider: "echo",
    workDir: os.homedir(),
    claudeCommand: "claude",
    cursorCommand: "agent",
    autoAccept: false,
  };
}

export class Store {
  readonly file: string;
  peerId: string;
  settings: Settings;
  trusted: Record<string, TrustedPeer>;
  sessions: Record<string, ChatSession[]>;
  openSessions: Record<string, string>;
  transcripts: Record<string, ChatLine[]>;
  briefs: Record<string, ProjectBrief>;
  groups: GroupRoom[];
  nicknames: Record<string, string>;

  constructor(profile: string) {
    this.file = path.join(app.getPath("userData"), "config.json");
    const fresh = defaultSettings(profile);
    const disk = readDisk(this.file);
    this.peerId = disk?.peerId || randomUUID();
    this.settings = sanitizeSettings(disk?.settings ?? fresh, fresh.name);
    this.trusted = disk?.trusted ?? {};
    const history = migrateHistory(disk);
    this.sessions = history.sessions;
    this.openSessions = history.openSessions;
    this.transcripts = history.transcripts;
    this.briefs = sanitizeBriefs(disk?.briefs);
    this.groups = sanitizeGroups(disk?.groups);
    this.nicknames = sanitizeNicknames(disk?.nicknames);
    for (const lines of Object.values(this.transcripts)) {
      for (const line of lines) {
        if (line.pending) {
          line.pending = false;
          if (!line.text.trim()) line.text = "(dở dang)";
        }
      }
    }
  }

  save(): void {
    const disk: Disk = {
      peerId: this.peerId,
      settings: this.settings,
      trusted: this.trusted,
      sessions: this.sessions,
      openSessions: this.openSessions,
      transcripts: this.transcripts,
      briefs: this.briefs,
      groups: this.groups,
      nicknames: this.nicknames,
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(disk, null, 2), "utf8");
    try {
      fs.renameSync(tmp, this.file);
    } catch {
      fs.copyFileSync(tmp, this.file);
      fs.rmSync(tmp, { force: true });
    }
  }
}

export function sanitizeSettings(input: Partial<Settings> & { cursorCwd?: string }, fallbackName: string): Settings {
  const name = (input.name || fallbackName).trim().slice(0, 40) || fallbackName;
  const workDir = (input.workDir || input.cursorCwd || os.homedir()).trim() || os.homedir();
  return {
    name,
    provider: normalizeProvider(String(input.provider ?? "echo")),
    workDir,
    claudeCommand: (input.claudeCommand || "claude").trim() || "claude",
    cursorCommand: (input.cursorCommand || "agent").trim() || "agent",
    autoAccept: Boolean(input.autoAccept),
  };
}

function sanitizeNicknames(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object") return {};
  const nicknames: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(key) || typeof value !== "string") continue;
    const name = value.replace(/\s+/g, " ").trim().slice(0, 40);
    if (!name || name.toLowerCase() === "me") continue;
    nicknames[key] = name;
    if (Object.keys(nicknames).length >= 200) break;
  }
  return nicknames;
}

function readDisk(file: string): Disk | null {
  try {
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw) as Disk;
  } catch {
    return null;
  }
}

function migrateHistory(disk: Disk | null): {
  sessions: Record<string, ChatSession[]>;
  openSessions: Record<string, string>;
  transcripts: Record<string, ChatLine[]>;
} {
  const raw = disk?.transcripts ?? {};
  if (disk?.sessions) {
    return {
      sessions: disk.sessions,
      openSessions: disk.openSessions ?? {},
      transcripts: raw,
    };
  }
  const sessions: Record<string, ChatSession[]> = {};
  const transcripts: Record<string, ChatLine[]> = {};
  const openSessions: Record<string, string> = {};
  for (const [peerId, lines] of Object.entries(raw)) {
    if (!Array.isArray(lines)) continue;
    const id = `legacy-${peerId}`;
    const createdAt = lines[0]?.createdAt || Date.now();
    const updatedAt = lines[lines.length - 1]?.createdAt || createdAt;
    const first = lines.find((line) => line.kind === "human" && line.text.trim());
    const title = first ? first.text.replace(/\s+/g, " ").trim().slice(0, 42) : "Phiên 1";
    sessions[peerId] = [{ id, peerId, title, createdAt, updatedAt }];
    transcripts[id] = lines;
    openSessions[peerId] = id;
  }
  return { sessions, openSessions, transcripts };
}

function sanitizeGroups(raw: GroupRoom[] | undefined): GroupRoom[] {
  if (!Array.isArray(raw)) return [];
  const groups: GroupRoom[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const id = typeof item.id === "string" ? item.id : "";
    const hostId = typeof item.hostId === "string" ? item.hostId : "";
    const sessionId = typeof item.sessionId === "string" ? item.sessionId : "";
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || !hostId || !sessionId || sessionId.length > 80) continue;
    const members = sanitizeMembers(item.members);
    if (!members.some((member) => member.peerId === hostId)) continue;
    const title = String(item.title || "Nhóm").replace(/\s+/g, " ").trim().slice(0, 42) || "Nhóm";
    groups.push({ id, title, hostId, members, sessionId, turn: null });
  }
  return groups;
}

function sanitizeBriefs(raw: Record<string, ProjectBrief> | undefined): Record<string, ProjectBrief> {
  const briefs: Record<string, ProjectBrief> = {};
  if (!raw || typeof raw !== "object") return briefs;
  for (const [id, brief] of Object.entries(raw)) {
    if (!id || id.length > 80) continue;
    briefs[id] = sanitizeBrief(brief);
  }
  return briefs;
}
