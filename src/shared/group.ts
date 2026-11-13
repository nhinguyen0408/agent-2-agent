export const GROUP_MAX = 5;

const GROUP_PREFIX = "group:";

export type GroupMember = {
  peerId: string;
  name: string;
};

export type MentionRef = {
  peerId: string;
  name: string;
};

export type MentionHit = MentionRef & {
  start: number;
  end: number;
};

export type TurnMode = "topic" | "ping";

export type TurnTicket = {
  speakerId: string;
  order: string[];
  index: number;
  left: number;
  mode: TurnMode;
};

export type GroupRoom = {
  id: string;
  title: string;
  hostId: string;
  members: GroupMember[];
  sessionId: string;
  turn: TurnTicket | null;
};

export function groupKey(id: string): string {
  return `${GROUP_PREFIX}${id}`;
}

export function parseGroupKey(key: string): string | null {
  if (!key.startsWith(GROUP_PREFIX)) return null;
  const id = key.slice(GROUP_PREFIX.length);
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) return null;
  return id;
}

export function mentionRanges(text: string, people: GroupMember[]): MentionHit[] {
  const ranked = people
    .map((person) => ({ peerId: person.peerId, name: person.name.trim() }))
    .filter((person) => person.name.length > 0)
    .sort((a, b) => b.name.length - a.name.length);
  const hits: MentionHit[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const at = text.indexOf("@", cursor);
    if (at < 0) break;
    const boundary = at === 0 || /\s/.test(text[at - 1] || "");
    const rest = text.slice(at + 1);
    const hit = boundary ? ranked.find((person) => nameFits(rest, person.name)) : undefined;
    if (!hit) {
      cursor = at + 1;
      continue;
    }
    const end = at + 1 + hit.name.length;
    hits.push({ peerId: hit.peerId, name: hit.name, start: at, end });
    cursor = end;
  }
  return hits;
}

export function mentionTargets(text: string, people: GroupMember[]): MentionRef[] {
  const seen = new Set<string>();
  const list: MentionRef[] = [];
  for (const hit of mentionRanges(text, people)) {
    if (seen.has(hit.peerId)) continue;
    seen.add(hit.peerId);
    list.push({ peerId: hit.peerId, name: hit.name });
  }
  return list;
}

export function speakOrder(
  members: GroupMember[],
  mentions: MentionRef[],
  turns: number,
  senderId: string,
  mode: TurnMode,
): string[] {
  const known = new Set(members.map((member) => member.peerId));
  const mentioned: string[] = [];
  for (const mention of mentions) {
    if (!known.has(mention.peerId) || mentioned.includes(mention.peerId)) continue;
    mentioned.push(mention.peerId);
  }
  if (mode === "ping") return mentioned;
  const pool = mentioned.length ? mentioned : members.map((member) => member.peerId);
  if (!pool.length || turns <= 0) return [];
  const found = pool.indexOf(senderId);
  const start = found < 0 ? 0 : (found + 1) % pool.length;
  const count = Math.min(50, Math.max(0, Math.round(turns)));
  const order: string[] = [];
  for (let index = 0; index < count; index += 1) order.push(pool[(start + index) % pool.length]);
  return order;
}

export function ticketFrom(order: string[], mode: TurnMode): TurnTicket | null {
  const speakerId = order[0];
  if (!speakerId) return null;
  return { speakerId, order: order.slice(), index: 0, left: order.length, mode };
}

export function nextTicket(ticket: TurnTicket): TurnTicket | null {
  const index = ticket.index + 1;
  const left = ticket.left - 1;
  if (left <= 0 || index >= ticket.order.length) return null;
  const speakerId = ticket.order[index];
  if (!speakerId) return null;
  return { speakerId, order: ticket.order.slice(), index, left, mode: ticket.mode };
}

export function injectSpeakers(ticket: TurnTicket, ids: string[]): TurnTicket {
  const order = ticket.order.slice();
  let at = Math.min(order.length, ticket.index + 1);
  let left = ticket.left;
  for (const id of ids) {
    if (!id || id === ticket.speakerId) continue;
    order.splice(at, 0, id);
    at += 1;
    left += 1;
  }
  return { ...ticket, order, left };
}

export function sanitizeTicket(input: unknown): TurnTicket | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Partial<TurnTicket>;
  const mode: TurnMode | null = raw.mode === "ping" ? "ping" : raw.mode === "topic" ? "topic" : null;
  if (!mode) return null;
  const order = Array.isArray(raw.order)
    ? raw.order.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 80).slice(0, 50)
    : [];
  const index = Math.max(0, Math.round(Number(raw.index) || 0));
  const left = Math.max(0, Math.round(Number(raw.left) || 0));
  const speakerId = typeof raw.speakerId === "string" ? raw.speakerId.slice(0, 80) : "";
  if (!order.length || !speakerId || index >= order.length || left <= 0) return null;
  return { speakerId, order, index, left, mode };
}

export function sanitizeMembers(input: unknown): GroupMember[] {
  if (!Array.isArray(input)) return [];
  const members: GroupMember[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Partial<GroupMember>;
    const peerId = typeof raw.peerId === "string" ? raw.peerId.slice(0, 80) : "";
    const name = typeof raw.name === "string" ? raw.name.replace(/\s+/g, " ").trim().slice(0, 40) : "";
    if (!peerId || !name || members.some((member) => member.peerId === peerId)) continue;
    members.push({ peerId, name });
    if (members.length >= GROUP_MAX) break;
  }
  return members;
}

function nameFits(rest: string, name: string): boolean {
  if (!rest.toLowerCase().startsWith(name.toLowerCase())) return false;
  const after = rest[name.length] ?? "";
  return after === "" || /[\s,.;:!?)\]】]/.test(after);
}
