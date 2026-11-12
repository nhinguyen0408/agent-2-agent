import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import type { ChatLine, Settings } from "../shared/types";
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
  transcripts: Record<string, ChatLine[]>;
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
  transcripts: Record<string, ChatLine[]>;

  constructor(profile: string) {
    this.file = path.join(app.getPath("userData"), "config.json");
    const fresh = defaultSettings(profile);
    const disk = readDisk(this.file);
    this.peerId = disk?.peerId || randomUUID();
    this.settings = sanitizeSettings(disk?.settings ?? fresh, fresh.name);
    this.trusted = disk?.trusted ?? {};
    this.transcripts = disk?.transcripts ?? {};
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
      transcripts: this.transcripts,
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

function readDisk(file: string): Disk | null {
  try {
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw) as Disk;
  } catch {
    return null;
  }
}
