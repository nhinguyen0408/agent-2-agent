import { CODING_TURN_MAX } from "./brief";

export const GROUP_MAX = 5;

export const CODING_ROLES = ["po", "pm", "ba", "ux", "sa", "be", "fe", "fullstack", "mobile", "data", "devops", "security", "tester"] as const;

export type CodingRole = (typeof CODING_ROLES)[number];

const CODING_ROLE_TEXT: Record<CodingRole, { label: string; duty: string }> = {
  po: {
    label: "PO",
    duty: "Vai của bạn: PO. Chỉ quyết định ưu tiên, phạm vi sản phẩm và việc nhận hay không nhận. Không viết đặc tả chi tiết, không thiết kế màn hình, không viết code, không viết test case.",
  },
  pm: {
    label: "PM",
    duty: "Vai của bạn: PM. Chỉ lập kế hoạch, tiến độ, rủi ro và phụ thuộc giữa các vai. Không viết đặc tả, không thiết kế, không viết code, không viết test case.",
  },
  ba: {
    label: "BA",
    duty: "Vai của bạn: BA. Chỉ viết và làm rõ yêu cầu nghiệp vụ, phạm vi và tiêu chí chấp nhận. Không thiết kế giao diện, không viết code, không viết test case.",
  },
  ux: {
    label: "UX",
    duty: "Vai của bạn: UX. Chỉ mô tả luồng, bố cục và nội dung màn hình. Không viết code giao diện, không viết API, không viết test case.",
  },
  sa: {
    label: "SA",
    duty: "Vai của bạn: SA. Chỉ chốt kiến trúc, ranh giới hệ thống và hợp đồng giữa các phần. Không viết code tính năng, không viết test case.",
  },
  be: {
    label: "BE",
    duty: "Vai của bạn: BE. Chỉ viết code backend và mô tả API cùng ảnh hưởng bằng Markdown. Không viết giao diện, không viết app mobile, không viết tài liệu nghiệp vụ, không viết test case.",
  },
  fe: {
    label: "FE",
    duty: "Vai của bạn: FE. Chỉ viết giao diện web và mô tả màn hình cùng ảnh hưởng bằng Markdown. Không viết API backend, không viết app mobile, không viết tài liệu nghiệp vụ, không viết test case.",
  },
  fullstack: {
    label: "Full stack",
    duty: "Vai của bạn: Full stack. Chỉ viết code backend, API và giao diện web, rồi mô tả ảnh hưởng của cả hai phần bằng Markdown. Không viết app mobile, không viết tài liệu nghiệp vụ, không làm hạ tầng, không viết test case.",
  },
  mobile: {
    label: "Mobile",
    duty: "Vai của bạn: Mobile. Chỉ viết ứng dụng mobile và mô tả màn hình cùng ảnh hưởng bằng Markdown. Không viết web, không viết API backend, không viết test case.",
  },
  data: {
    label: "Data",
    duty: "Vai của bạn: Data. Chỉ làm mô hình dữ liệu, pipeline và báo cáo. Không viết API sản phẩm, không viết giao diện, không viết test case.",
  },
  devops: {
    label: "DevOps",
    duty: "Vai của bạn: DevOps. Chỉ làm hạ tầng, CI/CD, triển khai và cấu hình môi trường. Không viết tính năng sản phẩm, không viết test case.",
  },
  security: {
    label: "Security",
    duty: "Vai của bạn: Security. Chỉ xem quyền, xác thực, mối đe dọa và lỗ hổng. Không sửa code tính năng, không viết test case chức năng.",
  },
  tester: {
    label: "Tester",
    duty: "Vai của bạn: Tester. Chỉ viết test case từ tài liệu và phần ảnh hưởng đã có. Không sửa code, không viết lại tài liệu nghiệp vụ.",
  },
};

const GROUP_PREFIX = "group:";

export type GroupMember = {
  peerId: string;
  name: string;
  role?: CodingRole;
};

export function codingRole(value: unknown): CodingRole | undefined {
  return typeof value === "string" && (CODING_ROLES as readonly string[]).includes(value) ? (value as CodingRole) : undefined;
}

export function codingRoleLabel(role: CodingRole): string {
  return CODING_ROLE_TEXT[role].label;
}

export function codingRoleDuty(role: CodingRole | undefined): string {
  if (!role) return "Bạn chưa được phân vai. Không làm việc của các vai khác trong nhóm.";
  return CODING_ROLE_TEXT[role].duty;
}

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

export function withAliases(people: GroupMember[], aliases: GroupMember[]): GroupMember[] {
  const known = new Set(people.map((person) => person.peerId));
  const extra: GroupMember[] = [];
  for (const alias of aliases) {
    const name = alias.name.replace(/\s+/g, " ").trim().slice(0, 40);
    if (!name || !known.has(alias.peerId)) continue;
    const same = (person: GroupMember) => person.peerId === alias.peerId && person.name.toLowerCase() === name.toLowerCase();
    if (people.some(same) || extra.some(same)) continue;
    extra.push({ peerId: alias.peerId, name });
  }
  return [...extra, ...people];
}

export function withSelfAlias(people: GroupMember[], selfId: string): GroupMember[] {
  if (!selfId) return people;
  if (people.some((person) => person.peerId === selfId && person.name.trim().toLowerCase() === "me")) return people;
  return [{ peerId: selfId, name: "me" }, ...people];
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

export function rewriteMentionLabels(
  text: string,
  people: GroupMember[],
  labelFor: (hit: MentionHit) => string,
): { text: string; mentions: MentionRef[] } {
  const hits = mentionRanges(text, people);
  if (!hits.length) return { text, mentions: [] };
  let next = "";
  let cursor = 0;
  const mentions: MentionRef[] = [];
  for (const hit of hits) {
    const label = labelFor(hit).replace(/\s+/g, " ").trim() || hit.name;
    next += text.slice(cursor, hit.start + 1) + label;
    cursor = hit.end;
    if (!mentions.some((item) => item.peerId === hit.peerId)) mentions.push({ peerId: hit.peerId, name: label });
  }
  return { text: next + text.slice(cursor), mentions };
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

export function codingSpeakOrder(members: GroupMember[], turns: number, afterId = ""): string[] {
  const pool: string[] = [];
  for (const role of CODING_ROLES) {
    for (const member of members) {
      if (member.role !== role || pool.includes(member.peerId)) continue;
      pool.push(member.peerId);
    }
  }
  if (!pool.length || turns <= 0) return [];
  const found = afterId ? pool.indexOf(afterId) : -1;
  const start = found < 0 ? 0 : (found + 1) % pool.length;
  const count = Math.min(CODING_TURN_MAX, Math.max(0, Math.round(turns)));
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
    ? raw.order.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 80).slice(0, CODING_TURN_MAX)
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
    const role = codingRole(raw.role);
    members.push(role ? { peerId, name, role } : { peerId, name });
    if (members.length >= GROUP_MAX) break;
  }
  return members;
}

function nameFits(rest: string, name: string): boolean {
  if (!rest.toLowerCase().startsWith(name.toLowerCase())) return false;
  const after = rest[name.length] ?? "";
  return after === "" || /[\s,.;:!?)\]】]/.test(after);
}
