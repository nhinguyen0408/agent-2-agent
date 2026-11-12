import dgram from "node:dgram";
import os from "node:os";
import { DISCOVERY_PORT, MULTICAST_ADDR } from "../shared/types";

export type Announce = {
  v: 1;
  kind: "announce";
  peerId: string;
  name: string;
  port: number;
  provider: string;
  host?: string;
  clis?: string;
};

export type Sighting = {
  peerId: string;
  name: string;
  host: string;
  port: number;
  provider: string;
  clis: string;
  lastSeen: number;
};

export function lanIPv4(): string {
  const ips = lanInterfaces();
  return ips[0]?.address ?? "127.0.0.1";
}

export function normalizeIp(address: string): string {
  if (address.startsWith("::ffff:")) return address.slice("::ffff:".length);
  if (address === "::1") return "127.0.0.1";
  return address;
}

type Iface = { address: string; broadcast: string; name: string };

function lanInterfaces(): Iface[] {
  const out: Iface[] = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const net of list ?? []) {
      const family = net.family as string | number;
      const v4 = family === "IPv4" || family === 4;
      if (!v4 || net.internal) continue;
      out.push({
        name,
        address: net.address,
        broadcast: broadcastFrom(net.address, net.netmask),
      });
    }
  }
  return out.sort((a, b) => rankInterface(a) - rankInterface(b));
}

function rankInterface(iface: Iface): number {
  const name = iface.name.toLowerCase();
  const virtual = /warp|wsl|hyper-v|vethernet|virtual|vmware|vbox|bluetooth|tailscale|zerotier|tap|tun|vpn|loopback/.test(name);
  if (virtual) return 50;
  if (iface.address.startsWith("192.168.")) return 0;
  if (iface.address.startsWith("10.")) return 1;
  return 2;
}

function chooseHost(announced: string | undefined, observed: string): string {
  const declared = (announced ?? "").trim();
  if (!isIPv4(declared)) return observed;
  if (isDirectLan(observed)) return observed;
  return declared;
}

function isIPv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const n = Number(part);
    return n >= 0 && n <= 255;
  });
}

function isDirectLan(value: string): boolean {
  return value.startsWith("192.168.") || value.startsWith("10.");
}

function broadcastFrom(address: string, netmask: string): string {
  const ip = address.split(".").map((part) => Number(part));
  const mask = netmask.split(".").map((part) => Number(part));
  if (ip.length !== 4 || mask.length !== 4 || ip.some(Number.isNaN) || mask.some(Number.isNaN)) {
    return "255.255.255.255";
  }
  return ip.map((octet, i) => ((octet | (~mask[i] & 255)) & 255).toString()).join(".");
}

export class Discovery {
  private socket: dgram.Socket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly peers = new Map<string, Sighting>();
  private readonly selfId: string;
  onPeer: (peer: Sighting) => void = () => {};
  onLost: (peerId: string) => void = () => {};
  onLog: (line: string) => void = () => {};

  constructor(selfId: string) {
    this.selfId = selfId;
  }

  start(getAnnounce: () => Omit<Announce, "v" | "kind">): void {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    this.socket = socket;
    socket.on("error", (err) => {
      this.onLog(`Discovery UDP lỗi: ${err.message}`);
    });
    socket.on("message", (msg, rinfo) => {
      this.ingest(msg, normalizeIp(rinfo.address));
    });
    socket.bind({ port: DISCOVERY_PORT, exclusive: false }, () => {
      try {
        socket.setBroadcast(true);
        socket.setMulticastTTL(1);
        socket.setMulticastLoopback(true);
        socket.addMembership(MULTICAST_ADDR);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.onLog(`Multicast không bật được (${message}). Vẫn gửi broadcast.`);
      }
      this.timer = setInterval(() => this.broadcast(getAnnounce()), 2000);
      this.broadcast(getAnnounce());
    });
  }

  snapshot(): Sighting[] {
    return [...this.peers.values()];
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.socket?.close();
    this.socket = null;
  }

  private broadcast(body: Omit<Announce, "v" | "kind">): void {
    const socket = this.socket;
    if (!socket) return;
    const packet: Announce = { v: 1, kind: "announce", ...body };
    const buf = Buffer.from(JSON.stringify(packet));
    const targets = new Set<string>([MULTICAST_ADDR, "255.255.255.255"]);
    for (const iface of lanInterfaces()) targets.add(iface.broadcast);
    for (const target of targets) {
      socket.send(buf, DISCOVERY_PORT, target, () => {
        /* unreachable broadcasts are normal */
      });
    }
  }

  private ingest(msg: Buffer, host: string): void {
    let packet: Announce;
    try {
      packet = JSON.parse(msg.toString("utf8")) as Announce;
    } catch {
      return;
    }
    if (packet.v !== 1 || packet.kind !== "announce") return;
    if (!packet.peerId || packet.peerId === this.selfId) return;
    if (!packet.port || packet.port < 1 || packet.port > 65535) return;
    const sighting: Sighting = {
      peerId: packet.peerId,
      name: (packet.name || "Máy lạ").slice(0, 40),
      host: chooseHost(packet.host, host),
      port: packet.port,
      provider: packet.provider || "echo",
      clis: typeof packet.clis === "string" ? packet.clis.slice(0, 40) : "",
      lastSeen: Date.now(),
    };
    this.peers.set(packet.peerId, sighting);
    this.onPeer(sighting);
  }

  sweep(maxAgeMs: number): void {
    const now = Date.now();
    for (const [peerId, sighting] of this.peers) {
      if (now - sighting.lastSeen > maxAgeMs) {
        this.peers.delete(peerId);
        this.onLost(peerId);
      }
    }
  }
}
