import catalog from "./access.json";

export type AccessLevel = 1 | 2 | 3 | 4;

export type AccessRole = {
  id: string;
  level: AccessLevel;
  title: string;
  detail: string;
};

export const ACCESS_LEVELS: { level: AccessLevel; title: string }[] = [
  { level: 1, title: "Mức 1 · Rủi ro thấp" },
  { level: 2, title: "Mức 2 · Rủi ro trung bình" },
  { level: 3, title: "Mức 3 · Rủi ro cao" },
  { level: 4, title: "Mức 4 · Rủi ro nghiêm trọng" },
];

export const ACCESS_ROLES: AccessRole[] = catalog.map((role) => ({
  id: role.id,
  level: role.level === 2 || role.level === 3 || role.level === 4 ? role.level : 1,
  title: role.title,
  detail: role.detail,
}));

const RULES: Record<string, { request: RegExp[]; tools: RegExp[]; shell: RegExp[] }> = {
  "read-search": {
    request: [/đọc (file|mã|nguồn|thư mục)/i, /tìm (kiếm )?(trong|sâu|mã|file)/i, /\b(grep|ripgrep|findstr)\b/i],
    tools: [/"name"\s*:\s*"(Read|Grep|Glob|SemanticSearch|read_file)"/i],
    shell: [/\b(Get-Content|Select-String|findstr|ripgrep)\b/i, /(^|[\s;&|`])(rg|grep|cat)\s/i],
  },
  "disk-scan": {
    request: [/file (rác|trùng)/i, /dung lượng lớn/i, /quét (ổ|đĩa|dữ liệu)/i],
    tools: [],
    shell: [/\b(du|ncdu|fdupes|rdfind)\b/i, /Get-ChildItem[\s\S]{0,80}-Recurse/i],
  },
  "system-monitor": {
    request: [/(mức sử dụng )?(cpu|ram|gpu)|nhiệt độ|tình trạng pin|tiến trình chạy/i],
    tools: [],
    shell: [/\b(systeminfo|tasklist|Get-Process|nvidia-smi|Get-CimInstance|Get-Counter)\b/i],
  },
  "network-info": {
    request: [/địa chỉ ip|tốc độ mạng|cổng nào đang/i, /\b(ipconfig|netstat|tracert)\b/i, /\bping\b/i],
    tools: [],
    shell: [/\b(ipconfig|ifconfig|netstat|Get-NetTCPConnection|nslookup|tracert|pathping|speedtest)\b/i, /\bping(\.exe)?\s/i],
  },
  "screen-capture": {
    request: [/chụp (ảnh )?màn hình|quay màn hình|screenshot/i],
    tools: [],
    shell: [/\b(screenshot|screencapture|snippingtool|CopyFromScreen|PrintWindow)\b/i],
  },
  "db-read": {
    request: [/truy vấn|git diff|\bselect\b|\bsqlite\b|\bmysql\b|postgres/i],
    tools: [],
    shell: [/\b(sqlite3|mysql|psql)\b/i, /\bgit\s+(diff|status|log|show|blame)\b/i],
  },
  "file-arrange": {
    request: [/đổi tên (file|hàng)|tạo (file|thư mục)|sao chép file|di chuyển file|giải nén|nén (file|thư mục)|\.(zip|rar|7z)\b/i],
    tools: [],
    shell: [/\b(mkdir|Compress-Archive|Expand-Archive|Rename-Item|Copy-Item|Move-Item|New-Item|unzip)\b/i, /(^|[\s;&|`])(cp|mv)\s/i],
  },
  "media-convert": {
    request: [/ffmpeg|pandoc|chuyển (sang|đổi) (pdf|excel|word)|nén (ảnh|video)|cắt (ghép )?video|tách âm thanh/i],
    tools: [],
    shell: [/\b(ffmpeg|ffprobe|magick|pandoc|soffice)\b/i],
  },
  "open-app": {
    request: [/mở (ứng dụng|word|excel|vscode|visual studio code|spotify|zalo|docker)|mở file bằng/i],
    tools: [],
    shell: [/\b(Start-Process|Invoke-Item|explorer\.exe|winword|excel\.exe)\b/i],
  },
  "browser-basic": {
    request: [/mở (trình duyệt|chrome|edge|safari)|mở (sẵn )?(một nhóm )?tab|trang tìm kiếm/i],
    tools: [],
    shell: [/\b(chrome\.exe|msedge\.exe|firefox\.exe)\b/i, /start\s+https?:\/\//i],
  },
  clipboard: {
    request: [/clipboard|bộ nhớ tạm|ctrl\+c|vừa copy/i],
    tools: [],
    shell: [/\b(Get-Clipboard|Set-Clipboard|clip\.exe|pbcopy|pbpaste)\b/i],
  },
  "light-settings": {
    request: [/dark mode|chế độ (sáng|tối)|âm lượng|độ sáng|khóa màn hình|hẹn giờ ngủ/i],
    tools: [],
    shell: [/\b(AppsUseLightTheme|setvolume|Set-DisplayBrightness|tsdiscon)\b/i, /LockWorkStation/i],
  },
  "code-git": {
    request: [/npm test|pytest|git commit|tạo nhánh|viết code|sửa lỗi|nâng cấp thư viện|\bdebug\b/i],
    tools: [/"name"\s*:\s*"(Edit|Write|ApplyPatch|StrReplace|search_replace|edit_file|write)"/i, /file_change|apply_patch/i],
    shell: [/\bgit\s+(commit|add|checkout|switch|branch|merge|rebase|stash|restore)\b/i, /\b(npm\s+test|pnpm\s+test|pytest|vitest)\b/i],
  },
  notify: {
    request: [/thông báo (pop-up|popup)|gửi thông báo|\btoast\b/i],
    tools: [],
    shell: [/\b(BurntToast|New-BurntToastNotification|notify-send|msg\.exe)\b/i],
  },
  "delete-data": {
    request: [/xóa (vĩnh viễn|file|trùng|rác)|dọn (dẹp )?file|\brm\b|Remove-Item/i],
    tools: [],
    shell: [/\b(Remove-Item|rmdir|Clear-RecycleBin|shred)\b/i, /(^|[\s;&|`])rm\s+/, /(^|[\s;&|`])del\s+\/f/i],
  },
  "db-write": {
    request: [/insert into|delete from|drop table|xóa bảng|sửa bảng|cập nhật (bảng|cơ sở dữ liệu)|truncate/i],
    tools: [],
    shell: [/\b(INSERT\s+INTO|DELETE\s+FROM|DROP\s+(TABLE|DATABASE)|ALTER\s+TABLE|TRUNCATE\s+TABLE)\b/i, /\bUPDATE\s+[A-Za-z0-9_."]+\s+SET\b/i],
  },
  download: {
    request: [/tải (về|file|xuống)|download|\bwget\b|invoke-webrequest/i],
    tools: [],
    shell: [/\b(wget|Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer|curl(?:\.exe)?)\b/i],
  },
  "install-software": {
    request: [/\b(winget|brew\s+install|apt(-get)?\s+install|npm\s+install|pip\s+install)\b|cài (đặt|lại) (phần mềm|thư viện)|gỡ (cài đặt|phần mềm)/i],
    tools: [],
    shell: [/\b(winget|choco|apt-get)\b/i, /\bapt\s+install\b/i, /\b(npm|pnpm|yarn)\s+(install|i|uninstall|remove|add)\b/i, /\bpip\s+install\b/i, /\bbrew\s+(install|uninstall)\b/i],
  },
  "browser-auto": {
    request: [/playwright|puppeteer|selenium|cào dữ liệu|điền (biểu mẫu|form)|đăng nhập (tài khoản|web)/i],
    tools: [],
    shell: [/\b(playwright|puppeteer|selenium)\b/i],
  },
  "git-push": {
    request: [/git push|pull request|đẩy (code|lên|nhánh)|\bgh\s+pr\b/i],
    tools: [],
    shell: [/\bgit\s+push\b/i, /\bgh\s+pr\s+(create|merge)\b/i],
  },
  "gui-automation": {
    request: [/giả lập (chuột|bàn phím)|pyautogui|sendkeys|di chuyển chuột|tự (click|gõ phím)/i],
    tools: [],
    shell: [/\b(pyautogui|SendKeys|xdotool|mouse_event|cliclick)\b/i],
  },
  "process-network": {
    request: [/tắt (máy|wifi|bluetooth)|bật (wifi|bluetooth)|force kill|taskkill|shutdown|buộc tắt/i],
    tools: [],
    shell: [/\b(taskkill|Stop-Process|shutdown|Restart-Computer|Stop-Computer)\b/i, /\bnetsh\s+wlan\b/i],
  },
  "scheduled-task": {
    request: [/\bcron\b|task scheduler|schtasks|tác vụ chạy ngầm|lịch (trình|chạy)/i],
    tools: [],
    shell: [/\b(schtasks|Register-ScheduledTask|crontab|New-ScheduledTask)\b/i],
  },
  yolo: {
    request: [/\byolo\b|bỏ qua (bước )?xác nhận|tự chạy hết|không cần hỏi|autonomous/i],
    tools: [],
    shell: [/(\s|^)(--yolo|dangerously-bypass-approvals)/i],
  },
};

export function defaultAccess(): string[] {
  return ACCESS_ROLES.filter((role) => role.level <= 2).map((role) => role.id);
}

export function cleanAccess(value: unknown): string[] {
  const known = new Set(ACCESS_ROLES.map((role) => role.id));
  if (!Array.isArray(value)) return defaultAccess();
  const picked = new Set(value.filter((id): id is string => typeof id === "string" && known.has(id)));
  return ACCESS_ROLES.map((role) => role.id).filter((id) => picked.has(id));
}

export function denialText(roles: AccessRole[]): string {
  const titles = roles.map((role) => role.title).join(", ");
  return `Không có quyền: ${titles}.`;
}

export class AccessDenied extends Error {
  readonly roles: AccessRole[];

  constructor(roles: AccessRole[]) {
    super(denialText(roles));
    this.name = "AccessDenied";
    this.roles = roles;
  }
}

export function deniedRoles(text: string, enabled: readonly string[] | undefined, mode: "request" | "command"): AccessRole[] {
  const allow = new Set(enabled ?? defaultAccess());
  const sample = text.replace(/curl(?:\.exe)?\b[\s\S]{0,240}?127\.0\.0\.1:\d+\/relay-file\/[^\s"']+/gi, "");
  if (!sample.trim()) return [];
  const shell = mode === "command" && /command_execution|shellToolCall|"command"\s*:|"cmd"\s*:|"name"\s*:\s*"(Bash|Shell|PowerShell|shell|bash)"/i.test(sample);
  const hits: AccessRole[] = [];
  for (const role of ACCESS_ROLES) {
    if (allow.has(role.id)) continue;
    const rules = RULES[role.id];
    if (!rules) continue;
    const matched =
      mode === "request"
        ? rules.request.some((pattern) => pattern.test(sample))
        : rules.tools.some((pattern) => pattern.test(sample)) || (shell && rules.shell.some((pattern) => pattern.test(sample)));
    if (matched) hits.push(role);
  }
  return hits;
}

export function latestRequest(history: { role: string; text: string }[]): string {
  let start = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i]?.role === "assistant") {
      start = i + 1;
      break;
    }
  }
  return history
    .slice(start)
    .map((turn) => turn.text)
    .join("\n");
}

export function accessPrompt(enabled: readonly string[] | null | undefined): string {
  if (enabled === null) return "";
  const allow = new Set(enabled ?? defaultAccess());
  const on = ACCESS_ROLES.filter((role) => allow.has(role.id)).map((role) => role.title);
  const off = ACCESS_ROLES.filter((role) => !allow.has(role.id)).map((role) => role.title);
  return [
    on.length ? `Chỉ được dùng các khả năng đã cấp: ${on.join(", ")}.` : "Chưa được cấp khả năng nào.",
    off.length ? `Không có quyền: ${off.join(", ")}. Phải từ chối, không được thực hiện bằng lệnh, tool, script hay cách gián tiếp.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function toolBlob(event: unknown): string {
  if (!event || typeof event !== "object") return "";
  const record = event as Record<string, unknown>;
  const type = String(record.type ?? "");
  if (type === "stream_event" || type === "result" || type === "system") return "";
  if (type === "assistant" || type === "user") {
    const message = record.message as { content?: unknown } | undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    const tools = content.filter((block) => block && typeof block === "object" && (block as { type?: string }).type === "tool_use");
    return tools.length ? JSON.stringify(tools) : "";
  }
  if (type === "item.started" || type === "item.completed") {
    const item = record.item as { type?: string; command?: unknown } | undefined;
    if (!item || item.type === "agent_message" || item.type === "reasoning") return "";
    if (item.type === "command_execution") return typeof item.command === "string" ? item.command : JSON.stringify(item);
    if (item.type === "file_change" || item.type === "mcp_tool_call") return JSON.stringify(item);
    return "";
  }
  if (type === "tool_call" && record.subtype !== "completed") return JSON.stringify(record.tool_call ?? record);
  if (type === "tool_use") {
    const parameters = record.parameters && typeof record.parameters === "object" ? (record.parameters as Record<string, unknown>) : {};
    return JSON.stringify({ name: record.tool_name, ...parameters });
  }
  return "";
}
