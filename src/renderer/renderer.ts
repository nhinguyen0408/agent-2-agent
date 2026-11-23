import { BRIEF_FILE_MAX, BRIEF_TURN_MAX, CODING_TURN_DEFAULT, CODING_TURN_MAX, resultText, type BriefFile, type ProjectBrief } from "../shared/brief";
import { mergeCodingStep, type CodingLive, type CodingStep, type CodingViewSnap } from "../shared/codingLive";
import { CODING_ROLES, GROUP_MAX, codingRoleLabel, groupKey, mentionRanges, parseGroupKey, rewriteMentionLabels, type GroupMember, type GroupRoom, type MentionRef } from "../shared/group";
import type { AppState, ChatLine, ChatNotice, CliReport, CliToolState, FileRef, PeerActivity, PeerView, Settings, WorkFile } from "../shared/types";
import { REPLY_WAIT_MS, cliClientLabel, providerLabel } from "../shared/types";
import { fileRef, type PreviewKind } from "../shared/preview";
import { ACCESS_LEVELS, ACCESS_ROLES, defaultAccess } from "../shared/access";
import { previewSrc, renderMarkdownHtml, renderPreview } from "./previewView";

declare global {
  interface Window {
    lan: {
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
      saveBrief: (peerId: string, patch: { topic: string; goal: string; turnLimit: number; coding?: boolean }) => Promise<AppState>;
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
      setMemberRole: (groupId: string, peerId: string, role: string) => Promise<AppState>;
      setNickname: (peerId: string, nickname: string) => Promise<AppState>;
      deleteSession: (peerId: string, sessionId: string) => Promise<AppState>;
      summarizeSession: (peerId: string, sessionId: string) => Promise<void>;
      endAgentSession: (peerId: string) => Promise<AppState>;
      createSession: (peerId: string) => Promise<AppState>;
      openSession: (peerId: string, sessionId: string) => Promise<AppState>;
      renameSession: (peerId: string, sessionId: string, title: string) => Promise<AppState>;
      stop: (peerId: string) => Promise<void>;
      pickCwd: () => Promise<string | null>;
      rescanClis: () => Promise<AppState>;
      activity: (peerId: string, patch: { typing?: boolean; replying?: boolean; sessionId?: string }) => Promise<void>;
      sendFile: (peerId: string) => Promise<string | null>;
      openPreview: () => Promise<FileRef | null>;
      showPreview: (file: FileRef) => Promise<boolean>;
      deleteCodingLog: (filePath: string) => Promise<boolean>;
      toggleCodingView: (snap: CodingViewSnap) => Promise<boolean>;
      codingReplay: (sessionId: string) => Promise<CodingStep[]>;
      listWorkFiles: (dir: string, root?: string) => Promise<{ found: boolean; files: WorkFile[] }>;
      onState: (listener: (state: AppState) => void) => () => void;
      onNotice: (listener: (notice: ChatNotice) => void) => () => void;
      onPreviewFile: (listener: (file: FileRef) => void) => () => void;
      onCodingLive: (listener: (event: CodingLive) => void) => () => void;
      onCodingView: (listener: (snap: CodingViewSnap) => void) => () => void;
      onCodingViewClosed: (listener: () => void) => () => void;
    };
  }
}

let mentionFaces: GroupMember[] = [];
let mentionNicks: Record<string, string> = {};
let mentionSelf = "";

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("Thiếu #app");
if (!window.lan) {
  root.textContent = "Mở ứng dụng bằng Electron, không mở file HTML trực tiếp.";
} else {
  boot(root);
}

function boot(host: HTMLElement): void {
  host.innerHTML = `
    ${iconSprite()}
    <div class="shell">
      <nav class="rail" id="rail">
        ${iconButton("nav-toggle", "sidebar", "Thu gọn thanh bên")}
        ${iconButton("", "people", "Máy trong LAN", "peers")}
        ${iconButton("", "folder", "Thư mục làm việc", "files")}
        <span class="spacer"></span>
        ${iconButton("", "gear", "Cài đặt", "settings")}
        ${iconButton("", "list", "Nhật ký", "logs")}
      </nav>
      <aside class="panel" id="panel">
        <div class="panel-head">
          <span class="level-kicker">Máy này</span>
          <strong id="self-name"></strong>
          <span id="self-meta"></span>
        </div>
        <h2 id="pane-title" class="pane-title">Máy trong LAN</h2>
        <div class="panel-body" data-pane="peers">
          <div id="peers" class="peers"></div>
          <p id="peers-empty" class="hint">Đang dò máy trong LAN và các cổng 3940–3969.</p>
          <div class="group-side">
            <div class="group-side-head">
              <strong>Nhóm</strong>
              <span>tối đa ${GROUP_MAX} máy</span>
              ${iconButton("group-new", "plus", "Tạo nhóm, tối đa 5 máy")}
            </div>
            <div id="groups" class="groups"></div>
          </div>
          <form id="manual" class="manual">
            <input id="manual-host" placeholder="IP hoặc tên máy" autocomplete="off" data-tip="Địa chỉ máy kia" aria-label="Địa chỉ máy kia" />
            <input id="manual-port" inputmode="numeric" value="3940" data-tip="Cổng" aria-label="Cổng" />
            ${iconButton("", "link", "Nối tới địa chỉ này", "", "", "submit")}
          </form>
        </div>
        <div class="panel-body" data-pane="files" hidden>
          <section class="dir-block">
            <label class="cwd">Thư mục làm việc
              <span>
                <input id="set-cwd" spellcheck="false" data-tip="Thư mục agent đọc và ghi file" aria-label="Thư mục làm việc" />
                ${iconButton("pick-cwd", "folder", "Chọn thư mục")}
              </span>
            </label>
            <label class="check confine">
              <input id="set-confine" type="checkbox" />
              <span>Agent máy khác chỉ điều khiển được file và lệnh trong thư mục đã lưu này, kể cả thư mục con.</span>
            </label>
            <p class="hint">Bấm một thư mục để mở bên trong.</p>
            <div id="workdir-files" class="workdir-files"></div>
            <div class="save-row">${iconButton("save-dirs", "check", "Lưu thư mục làm việc", "", "", "button", "icon-btn primary")}</div>
          </section>
        </div>
        <div class="panel-body" data-pane="settings" hidden>
          <label>Tên máy này<input id="set-name" maxlength="40" /></label>
          <label>Runtime
            <select id="set-provider">
              <option value="echo">Echo — thử kênh, không cần đăng nhập</option>
              <option value="claude-cli">Claude terminal — lệnh claude đã login</option>
              <option value="cursor-cli">Cursor terminal — lệnh agent đã login</option>
              <option value="codex-cli">Codex terminal — lệnh codex đã login</option>
              <option value="gemini-cli">Gemini terminal — lệnh gemini đã login</option>
            </select>
          </label>
          <label>Lệnh Claude<input id="set-claude-command" spellcheck="false" /></label>
          <label>Lệnh Cursor<input id="set-cursor-command" spellcheck="false" /></label>
          <label>Lệnh Codex<input id="set-codex-command" spellcheck="false" /></label>
          <label>Lệnh Gemini<input id="set-gemini-command" spellcheck="false" /></label>
          <label class="check"><input id="set-auto" type="checkbox" /> Tự chấp nhận máy trong LAN</label>
          <button id="open-skills" type="button" class="access-open">Thư mục skill</button>
          <button id="open-access" type="button" class="access-open">Khả năng truy cập của agent khác</button>
          <div id="tools" class="tools"></div>
          <p class="hint">Không dùng API key trong app. File đi qua app, không cần share Windows. Claude, Cursor, Codex và Gemini dùng bản CLI đã đăng nhập trên máy này. Gemini cũng nhận GEMINI_API_KEY nếu biến đó đã có sẵn. Lệnh cursor của Cursor IDE không được tính là Cursor CLI.</p>
          <div class="save-row">
            ${iconButton("save", "check", "Lưu cài đặt", "", "", "button", "icon-btn primary")}
            ${iconButton("rescan", "refresh", "Kiểm tra lại CLI")}
            <span id="saved"></span>
          </div>
        </div>
        <div class="panel-body" data-pane="logs" hidden>
          <div id="logs" class="logs" aria-live="polite"></div>
        </div>
      </aside>
      <aside class="panel session-col" id="session-col">
        <header class="session-head">
          <div class="session-kicker">
            <span>Máy trong LAN</span>
            <span class="crumb-sep" aria-hidden="true">›</span>
            <span>Phiên chat</span>
            <span id="session-unread" class="unread-count" hidden></span>
          </div>
          <strong id="session-peer">Chưa chọn máy</strong>
          <span id="session-peer-meta">Chọn một máy ở cột bên trái.</span>
        </header>
        <div class="panel-body">
          <div class="search">
            ${icon("search")}
            <input id="history-query" placeholder="Tìm trong phiên của máy này" autocomplete="off" aria-label="Tìm trong phiên của máy này" />
          </div>
          <div id="history-list" class="history-list"></div>
          <div class="pane-tools">
            <button id="cancel-agent" class="cancel-agent" type="button" hidden>Hủy agent</button>
            ${iconButton("new-session", "plus", "Phiên mới với máy đang chọn", "", "", "button", "icon-btn primary")}
          </div>
        </div>
      </aside>
      <section class="chat">
        <div id="chat-empty" class="empty">
          <h2>Chưa chọn máy</h2>
          <p>Chọn một máy, hoặc tạo nhóm rồi mời máy đã nối. Nhóm chứa tối đa 5 máy. Trong chủ đề, các agent nói lần lượt. Gõ @tên để gọi đúng agent, @me là agent máy này.</p>
        </div>
        <div id="chat-panel" class="chat-panel" hidden>
          <header class="chat-head">
            <div class="chat-id">
              <p id="chat-kicker" class="chat-kicker" hidden></p>
              <h2 id="chat-title"></h2>
              <input id="session-title" maxlength="42" spellcheck="false" placeholder="Tên phiên" data-tip="Tên phiên. Enter để lưu." aria-label="Tên phiên" />
              <p id="chat-status"></p>
            </div>
            <div class="head-actions">
              <button id="coding-view" class="coding-alert" type="button" hidden aria-pressed="false">
                <span class="coding-pulse"></span>
                <span id="coding-view-label">Xem coding</span>
              </button>
              ${iconButton("delete-chat", "trash", "Xóa hội thoại")}
              ${iconButton("delete-group", "x", "Xóa nhóm")}
              ${iconButton("link", "link", "Kết nối")}
            </div>
          </header>
          <div id="banner" class="banner" hidden>
            <span id="banner-text"></span>
            <span>
              ${iconButton("accept", "check", "Chấp nhận", "", "", "button", "icon-btn ok")}
              ${iconButton("reject", "x", "Từ chối")}
            </span>
          </div>
          <div id="group-bar" class="group-bar" hidden>
            <div id="group-members" class="group-members"></div>
            <form id="group-invite" class="group-invite">
              <select id="group-pick" aria-label="Mời máy vào nhóm"></select>
              <button type="submit">Mời</button>
            </form>
          </div>
          <div id="messages" class="messages"></div>
          <p id="typing" class="typing" hidden></p>
          <section id="brief" class="brief">
            <div class="brief-bar">
              ${iconButton("brief-toggle", "sliders", "Cài đặt chủ đề")}
              <button id="brief-summary" type="button" class="brief-summary empty">Chưa đặt chủ đề</button>
              <span id="brief-meter" class="brief-meter"></span>
              <span class="brief-tools">
                <button id="brief-new" type="button">Thêm chủ đề</button>
                <button id="brief-hide" type="button">Ẩn</button>
              </span>
            </div>
            <div id="brief-dock" class="brief-dock" hidden></div>
            <div id="brief-result" class="brief-result" hidden>
              <button id="brief-result-open" type="button" class="brief-result-text"><span></span></button>
              ${iconButton("brief-expand", "expand", "Mở rộng kết quả")}
            </div>
            <div id="brief-pop" class="brief-pop" hidden>
              <div class="brief-pop-head">
                <strong>Hồ sơ dự án</strong>
                ${iconButton("brief-close", "x", "Đóng cài đặt chủ đề")}
              </div>
              <label>Chủ đề
                <input id="brief-topic" maxlength="500" placeholder="Việc các agent cần bàn" aria-label="Chủ đề dự án" />
              </label>
              <label>Kết quả mong muốn
                <textarea id="brief-goal" rows="12" maxlength="2000" placeholder="Dạng kết quả cần chốt" aria-label="Kết quả mong muốn"></textarea>
              </label>
              <div id="brief-files" class="brief-files"></div>
              <label id="brief-coding-row" class="coding-toggle" hidden>
                <input id="brief-coding" type="checkbox" />
                <span id="brief-coding-copy">Chế độ coding. Mặc định 50 lượt, dừng khi có kết quả. Diff hiện trong hội thoại. Tin nhắn agent có icon để mở file log.</span>
              </label>
              <div id="brief-roles" class="brief-roles" hidden></div>
              <div class="brief-actions">
                ${iconButton("brief-add", "paperclip", "Thêm file context: txt, Markdown, ảnh, PDF, Word, Excel")}
                <label class="replies" data-tip="Số lượt agent được trả lời nhau, tối đa ${BRIEF_TURN_MAX}">
                  ${icon("hash")}
                  <input id="brief-turns" type="number" min="1" max="${BRIEF_TURN_MAX}" value="6" aria-label="Số lượt" />
                </label>
                <button id="brief-start" class="brief-go" type="button">Bắt đầu</button>
                <div class="extend" data-tip="Số lượt cộng thêm khi gia hạn">
                  <input id="brief-extra" type="number" min="1" max="${BRIEF_TURN_MAX}" value="4" aria-label="Số lượt gia hạn thêm" />
                  <button id="brief-extend" class="brief-more" type="button">Gia hạn</button>
                </div>
              </div>
            </div>
          </section>
          <form id="composer" class="composer">
            <div id="mention-pop" class="mention-pop" hidden></div>
            <textarea id="draft" rows="3" placeholder="Nhắn cho agent. Gõ @ để gọi đúng máy…"></textarea>
            <div id="session-tools-pop" class="session-tools" hidden>
              <p class="session-id" id="session-id-label"></p>
              <button type="button" id="summarize-current">Tóm tắt phiên này</button>
              <label class="session-search">
                <input id="summarize-query" type="search" placeholder="Tìm tên người hoặc tên phiên" aria-label="Tìm phiên để tóm tắt" />
              </label>
              <div id="summarize-list" class="pick-list"></div>
            </div>
            <div id="attach-chip" class="attach-chip" hidden>
              ${icon("paperclip")}
              <span id="attach-name"></span>
              ${iconButton("attach-clear", "x", "Bỏ file đính kèm")}
            </div>
            <div class="composer-actions">
              ${iconButton("attach", "paperclip", "Đính kèm txt, Markdown, ảnh, PDF, Word hoặc Excel")}
              ${iconButton("send-file", "file", "Gửi file sang máy kia")}
              ${iconButton("open-preview", "eye", "Mở cửa sổ xem file")}
              ${iconButton("copy-session", "copy", "Chép session ID")}
              ${iconButton("summarize", "layers", "Tóm tắt phiên này hoặc chọn phiên khác")}
              ${iconButton("end-cli", "fresh", "Kết thúc phiên agent để câu sau mở phiên mới")}
              <span class="spacer"></span>
              ${iconButton("stop", "stop", "Dừng agent đang trả lời")}
              ${iconButton("send", "send", "Gửi", "", "", "submit", "icon-btn primary")}
            </div>
          </form>
          <details id="http-box" class="http">
            <summary>${icon("terminal")} Lệnh HTTP</summary>
            <pre id="http-snippet"></pre>
            ${iconButton("copy-http", "copy", "Chép lệnh")}
          </details>
        </div>
      </section>
    </div>
    <div id="tip" class="tip" hidden></div>
    <div id="toast" class="toast" hidden></div>
    <div id="skill-pop" class="skill-pop" hidden>
      <div class="skill-card" role="dialog" aria-modal="true" aria-labelledby="skill-title">
        <header>
          <strong id="skill-title">Thư mục skill</strong>
          ${iconButton("skill-close", "x", "Đóng")}
        </header>
        <div class="skill-form">
          <p class="hint">Agent tự đọc skill của dự án đang mở, kể cả thư mục con trong .claude/skills, .cursor/skills, .agents/skills, .codex/skills, .gemini/skills và skills. Thư mục chọn thêm ở dưới cũng được quét nhiều tầng. Khi việc khớp mô tả trong SKILL.md, agent mở file đó rồi làm theo. File ghi ra vẫn nằm trong thư mục làm việc.</p>
          <label class="cwd">Skill Claude
            <span>
              <input id="set-claude-skill" spellcheck="false" placeholder="Thư mục skill của Claude" aria-label="Thư mục skill Claude" />
              ${iconButton("pick-claude-skill", "folder", "Chọn thư mục skill Claude")}
            </span>
          </label>
          <label class="cwd">Skill Cursor
            <span>
              <input id="set-cursor-skill" spellcheck="false" placeholder="Thư mục skill của Cursor" aria-label="Thư mục skill Cursor" />
              ${iconButton("pick-cursor-skill", "folder", "Chọn thư mục skill Cursor")}
            </span>
          </label>
          <label class="cwd">Skill Codex
            <span>
              <input id="set-codex-skill" spellcheck="false" placeholder="Thư mục skill của Codex" aria-label="Thư mục skill Codex" />
              ${iconButton("pick-codex-skill", "folder", "Chọn thư mục skill Codex")}
            </span>
          </label>
          <label class="cwd">Skill Gemini
            <span>
              <input id="set-gemini-skill" spellcheck="false" placeholder="Thư mục skill của Gemini" aria-label="Thư mục skill Gemini" />
              ${iconButton("pick-gemini-skill", "folder", "Chọn thư mục skill Gemini")}
            </span>
          </label>
          <div class="save-row">${iconButton("save-skills", "check", "Lưu thư mục skill", "", "", "button", "icon-btn primary")}</div>
        </div>
      </div>
    </div>
    <div id="result-pop" class="result-pop" hidden>
      <div class="result-card" role="dialog" aria-modal="true" aria-labelledby="result-title">
        <header>
          <strong id="result-title">Kết quả</strong>
          ${iconButton("result-close", "x", "Đóng")}
        </header>
        <article id="result-body" class="markdown"></article>
      </div>
    </div>
  `;
  buildAccessDialog(host);

  const navIds = ["peers", "files", "settings", "logs"] as const;
  type NavId = (typeof navIds)[number];
  const navTitles: Record<NavId, string> = {
    peers: "Máy trong LAN",
    files: "Thư mục làm việc",
    settings: "Cài đặt",
    logs: "Nhật ký",
  };
  const storedNav = localStorage.getItem("lan-nav");
  let nav: NavId = navIds.includes(storedNav as NavId) ? (storedNav as NavId) : "peers";
  let navOpen = localStorage.getItem("lan-nav-open") !== "0";

  function applyNav(): void {
    document.body.dataset.nav = nav;
    document.body.dataset.collapsed = navOpen ? "0" : "1";
    for (const pane of Array.from(document.querySelectorAll<HTMLElement>("[data-pane]"))) {
      pane.hidden = pane.dataset.pane !== nav;
    }
    for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>("[data-nav]"))) {
      button.classList.toggle("active", button.dataset.nav === nav);
    }
    must<HTMLElement>("#pane-title").textContent = navTitles[nav];
    if (nav === "logs") {
      const pane = document.querySelector<HTMLElement>('[data-pane="logs"]');
      if (pane) pane.scrollTop = pane.scrollHeight;
    }
    setIcon(must("#nav-toggle"), "sidebar", navOpen ? "Thu gọn thanh bên" : "Mở thanh bên");
    localStorage.setItem("lan-nav", nav);
    localStorage.setItem("lan-nav-open", navOpen ? "1" : "0");
  }

  must<HTMLElement>("#rail").addEventListener("click", (event) => {
    const toggle = (event.target as HTMLElement).closest<HTMLButtonElement>("#nav-toggle");
    if (toggle) {
      navOpen = !navOpen;
      applyNav();
      return;
    }
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-nav]");
    const next = button?.dataset.nav;
    if (!next || !navIds.includes(next as NavId)) return;
    if (nav === next && navOpen) navOpen = false;
    else {
      nav = next as NavId;
      navOpen = true;
    }
    applyNav();
  });
  applyNav();
  bindTips(host);

  const peersEl = must<HTMLDivElement>("#peers");
  const messagesEl = must<HTMLDivElement>("#messages");
  const draft = must<HTMLTextAreaElement>("#draft");
  let state: AppState | null = null;
  let active: string | null = null;
  let settingsReady = false;
  let toastTimer = 0;
  let rootFiles: WorkFile[] = [];
  let treeRoot = "";
  const openDirs = new Set<string>();
  const dirChildren = new Map<string, WorkFile[]>();
  const dirLoaded = new Set<string>();
  let selectedFile = "";
  let filesTimer = 0;
  let filesKey = "";

  let historyQuery = "";
  let focusLine = "";
  let mentionIndex = 0;
  let watchedKey = "";
  let logsKey = "";

  peersEl.addEventListener("click", (event) => {
    const nick = (event.target as HTMLElement).closest<HTMLElement>("[data-nick]");
    if (nick?.dataset.nick) {
      const row = nick.closest<HTMLElement>(".peer-row");
      if (row) beginNickname(row, nick.dataset.nick, state?.nicknames[nick.dataset.nick] || "");
      return;
    }
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-peer]");
    if (!row?.dataset.peer) return;
    active = row.dataset.peer;
    if (state) paint(state);
  });
  must<HTMLElement>("#groups").addEventListener("click", (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-group]");
    if (!row?.dataset.group) return;
    active = row.dataset.group;
    if (state) paint(state);
  });
  must<HTMLButtonElement>("#group-new").addEventListener("click", () => {
    void guard(async () => {
      const next = await window.lan.createGroup();
      const created = next.groups[next.groups.length - 1];
      if (created) active = groupKey(created.id);
      paint(next);
    });
  });
  must<HTMLFormElement>("#group-invite").addEventListener("submit", (event) => {
    event.preventDefault();
    const groupId = active ? parseGroupKey(active) : null;
    const peerId = must<HTMLSelectElement>("#group-pick").value;
    if (!groupId || !peerId) return;
    void guard(() => window.lan.inviteGroup(groupId, peerId));
  });

  must<HTMLFormElement>("#manual").addEventListener("submit", (event) => {
    event.preventDefault();
    const hostInput = must<HTMLInputElement>("#manual-host").value.trim();
    const port = Number(must<HTMLInputElement>("#manual-port").value);
    void guard(() => window.lan.connectAddress(hostInput, port));
  });

  must<HTMLButtonElement>("#open-access").addEventListener("click", () => {
    paintAccess(state?.settings.access ?? defaultAccess());
    must<HTMLElement>("#access-pop").hidden = false;
  });
  must<HTMLElement>("#access-pop").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeAccess();
  });
  must<HTMLButtonElement>("#access-close").addEventListener("click", () => closeAccess());
  must<HTMLButtonElement>("#access-save").addEventListener("click", () => {
    void guard(async () => {
      await window.lan.saveSettings(readSettings());
      must<HTMLElement>("#access-pop").hidden = true;
      flash("Đã lưu khả năng truy cập");
    });
  });
  must<HTMLButtonElement>("#open-skills").addEventListener("click", () => openSkills());
  must<HTMLElement>("#skill-pop").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeSkills();
  });
  must<HTMLButtonElement>("#skill-close").addEventListener("click", () => closeSkills());
  must<HTMLButtonElement>("#save-skills").addEventListener("click", () => {
    void guard(async () => {
      await window.lan.saveSettings(readSettings());
      must<HTMLElement>("#skill-pop").hidden = true;
      flash("Đã lưu thư mục skill");
    });
  });
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (document.querySelector(".history-menu-pop:not([hidden])")) {
      closeHistoryMenus();
      return;
    }
    if (!must<HTMLElement>("#skill-pop").hidden) {
      closeSkills();
      return;
    }
    if (!must<HTMLElement>("#access-pop").hidden) closeAccess();
  });

  must<HTMLButtonElement>("#save").addEventListener("click", () => {
    void guard(async () => {
      await window.lan.saveSettings(readSettings());
      const note = must<HTMLSpanElement>("#saved");
      note.textContent = "Đã lưu";
      window.setTimeout(() => {
        if (note.textContent === "Đã lưu") note.textContent = "";
      }, 1600);
    });
  });

  must<HTMLButtonElement>("#rescan").addEventListener("click", () => {
    void guard(async () => {
      const next = await window.lan.rescanClis();
      paint(next);
      flash("Đã kiểm tra lại CLI trên máy này");
    });
  });

  function scheduleFiles(): void {
    window.clearTimeout(filesTimer);
    filesTimer = window.setTimeout(() => void refreshFiles(), 250);
  }

  async function refreshFiles(): Promise<void> {
    const dir = must<HTMLInputElement>("#set-cwd").value.trim();
    const box = must<HTMLElement>("#workdir-files");
    if (!dir) {
      rootFiles = [];
      treeRoot = "";
      openDirs.clear();
      dirChildren.clear();
      dirLoaded.clear();
      filesKey = "";
      box.textContent = "Chưa chọn thư mục.";
      return;
    }
    if (dir !== treeRoot) {
      treeRoot = dir;
      openDirs.clear();
      dirChildren.clear();
      dirLoaded.clear();
    }
    try {
      const listed = await window.lan.listWorkFiles(dir, dir);
      if (must<HTMLInputElement>("#set-cwd").value.trim() !== dir) return;
      if (!listed.found) {
        rootFiles = [];
        filesKey = "";
        box.textContent = "Không thấy thư mục này.";
        return;
      }
      rootFiles = listed.files;
      for (const folder of [...openDirs]) {
        if (!underRoot(dir, folder)) {
          openDirs.delete(folder);
          dirChildren.delete(folder);
          dirLoaded.delete(folder);
          continue;
        }
        const child = await window.lan.listWorkFiles(folder, dir);
        if (must<HTMLInputElement>("#set-cwd").value.trim() !== dir) return;
        if (!child.found) {
          openDirs.delete(folder);
          dirChildren.delete(folder);
          dirLoaded.delete(folder);
          continue;
        }
        dirChildren.set(folder, child.files);
        dirLoaded.add(folder);
      }
      paintFileTree();
    } catch (err) {
      box.textContent = messageOf(err);
    }
  }

  async function toggleDir(folder: string): Promise<void> {
    if (openDirs.has(folder)) {
      openDirs.delete(folder);
      paintFileTree();
      return;
    }
    openDirs.add(folder);
    paintFileTree();
    const root = treeRoot;
    const listed = await window.lan.listWorkFiles(folder, root);
    if (treeRoot !== root || !openDirs.has(folder)) return;
    if (!listed.found) {
      openDirs.delete(folder);
      dirChildren.delete(folder);
      dirLoaded.delete(folder);
    } else {
      dirChildren.set(folder, listed.files);
      dirLoaded.add(folder);
    }
    paintFileTree();
  }

  function paintFileTree(): void {
    const box = must<HTMLElement>("#workdir-files");
    const rows = treeRows(rootFiles, 0);
    const key = rows.map((row) => `${row.depth}:${row.file?.path ?? row.label}:${row.file?.size ?? 0}:${row.file && openDirs.has(row.file.path) ? 1 : 0}`).join("|");
    if (key === filesKey && box.querySelector("[data-file], [data-note]")) {
      for (const button of Array.from(box.querySelectorAll<HTMLButtonElement>("[data-file]"))) {
        button.classList.toggle("active", button.dataset.file === selectedFile);
      }
      return;
    }
    filesKey = key;
    box.replaceChildren();
    if (!rows.length) {
      box.textContent = "Thư mục trống.";
      return;
    }
    for (const row of rows) {
      if (!row.file) {
        const note = document.createElement("p");
        note.className = "hint tree-note";
        note.dataset.note = "1";
        note.style.paddingLeft = `${12 + row.depth * 14}px`;
        note.textContent = row.label;
        box.append(note);
        continue;
      }
      const file = row.file;
      const open = file.dir && openDirs.has(file.path);
      const button = document.createElement("button");
      button.type = "button";
      button.className = `workdir-file${file.dir ? " dir" : ""}${file.path === selectedFile ? " active" : ""}`;
      button.style.paddingLeft = `${8 + row.depth * 14}px`;
      button.dataset.file = file.path;
      button.dataset.name = file.name;
      button.dataset.dir = file.dir ? "1" : "";
      button.dataset.preview = file.preview ?? "";
      button.dataset.tip = file.dir ? (open ? `Thu gọn ${file.name}` : `Mở ${file.name}`) : file.preview ? `Xem ${file.name}` : `${file.name} — chưa xem trước được`;
      button.setAttribute("aria-label", file.name);
      const main = document.createElement("span");
      main.className = "tree-main";
      const twist = document.createElement("span");
      twist.className = "twist";
      twist.textContent = file.dir ? (open ? "▾" : "▸") : "";
      const kind = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      kind.setAttribute("class", "icon tree-kind");
      kind.setAttribute("aria-hidden", "true");
      const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
      use.setAttribute("href", file.dir ? "#i-folder" : "#i-file");
      kind.append(use);
      const name = document.createElement("span");
      name.className = "tree-name";
      name.textContent = file.name;
      main.append(twist, kind, name);
      button.append(main);
      if (!file.dir) {
        const meta = document.createElement("small");
        meta.textContent = `${kindLabel(file.preview)} · ${formatFileSize(file.size)}`;
        button.append(meta);
      }
      box.append(button);
    }
  }

  function underRoot(root: string, target: string): boolean {
    const base = root.replace(/[\\/]+$/, "");
    const full = target.replace(/[\\/]+$/, "");
    if (full.toLowerCase() === base.toLowerCase()) return true;
    const slash = base.includes("\\") ? "\\" : "/";
    return full.toLowerCase().startsWith(`${base.toLowerCase()}${slash}`);
  }

  function treeRows(files: WorkFile[], depth: number): { file: WorkFile | null; depth: number; label: string }[] {
    const rows: { file: WorkFile | null; depth: number; label: string }[] = [];
    for (const file of files) {
      rows.push({ file, depth, label: file.name });
      if (!file.dir || !openDirs.has(file.path)) continue;
      if (!dirLoaded.has(file.path)) {
        rows.push({ file: null, depth: depth + 1, label: "Đang mở…" });
        continue;
      }
      const nested = dirChildren.get(file.path) ?? [];
      if (!nested.length) rows.push({ file: null, depth: depth + 1, label: "Thư mục trống" });
      else rows.push(...treeRows(nested, depth + 1));
    }
    return rows;
  }

  must<HTMLButtonElement>("#pick-cwd").addEventListener("click", () => {
    void guard(async () => {
      const picked = await window.lan.pickCwd();
      if (picked) {
        must<HTMLInputElement>("#set-cwd").value = picked;
        void refreshFiles();
      }
    });
  });

  must<HTMLInputElement>("#set-cwd").addEventListener("input", () => scheduleFiles());
  must<HTMLElement>("#workdir-files").addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-file]");
    if (!button?.dataset.file) return;
    if (button.dataset.dir === "1") {
      void guard(() => toggleDir(button.dataset.file || ""));
      return;
    }
    const kind = button.dataset.preview;
    if (kind !== "image" && kind !== "html" && kind !== "markdown" && kind !== "audio" && kind !== "video") {
      flash("Loại file này chưa xem trước được.");
      return;
    }
    selectedFile = button.dataset.file;
    paintFileTree();
    showDock({ name: button.dataset.name || button.dataset.file, path: button.dataset.file, preview: kind });
  });
  for (const [buttonId, inputId] of [
    ["#pick-claude-skill", "#set-claude-skill"],
    ["#pick-cursor-skill", "#set-cursor-skill"],
    ["#pick-codex-skill", "#set-codex-skill"],
    ["#pick-gemini-skill", "#set-gemini-skill"],
  ] as const) {
    must<HTMLButtonElement>(buttonId).addEventListener("click", () => {
      void guard(async () => {
        const picked = await window.lan.pickCwd();
        if (picked) must<HTMLInputElement>(inputId).value = picked;
      });
    });
  }
  must<HTMLInputElement>("#set-confine").addEventListener("change", () => {
    void guard(async () => {
      await window.lan.saveSettings(readSettings());
      flash(must<HTMLInputElement>("#set-confine").checked ? "Đã bật giới hạn thư mục làm việc" : "Đã tắt giới hạn thư mục làm việc");
    });
  });
  must<HTMLButtonElement>("#save-dirs").addEventListener("click", () => {
    void guard(async () => {
      await window.lan.saveSettings(readSettings());
      flash("Đã lưu thư mục làm việc");
    });
  });
  window.setInterval(() => void refreshFiles(), 4000);

  must<HTMLButtonElement>("#open-preview").addEventListener("click", () => {
    void guard(async () => {
      const file = await window.lan.openPreview();
      if (file) showDock(file);
    });
  });

  must<HTMLButtonElement>("#send-file").addEventListener("click", () => {
    if (!active) return;
    const peerId = active;
    void guard(async () => {
      const picked = await window.lan.sendFile(peerId);
      if (picked) flash(`Đã gửi file ${picked.split(/[/\\]/).pop()}`);
    });
  });

  must<HTMLFormElement>("#composer").addEventListener("submit", (event) => {
    event.preventDefault();
    void sendDraft();
  });
  draft.addEventListener("keydown", (event) => {
    const pop = must<HTMLElement>("#mention-pop");
    if (!pop.hidden) {
      const count = pop.children.length;
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && count) {
        event.preventDefault();
        mentionIndex = event.key === "ArrowDown" ? (mentionIndex + 1) % count : (mentionIndex - 1 + count) % count;
        paintMentions();
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && count) {
        event.preventDefault();
        const chosen = pop.children[mentionIndex];
        const name = chosen instanceof HTMLElement ? chosen.dataset.name || "" : "";
        if (name) insertMention(name);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        pop.hidden = true;
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendDraft();
    }
  });
  draft.addEventListener("input", () => {
    mentionIndex = 0;
    noteTyping(true);
    paintMentions();
  });
  draft.addEventListener("click", () => paintMentions());
  draft.addEventListener("keyup", (event) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End") paintMentions();
  });
  must<HTMLButtonElement>("#brief-add").addEventListener("click", () => {
    if (!active) return;
    const peerId = active;
    void guard(async () => {
      const paths = await window.lan.pickBriefFiles();
      if (!paths.length) return;
      await window.lan.addBriefFiles(peerId, paths);
    });
  });
  must<HTMLButtonElement>("#brief-new").addEventListener("click", () => {
    const briefBox = must<HTMLElement>("#brief");
    const id = briefBox.dataset.session || "";
    hiddenBriefs.delete(id);
    briefBox.classList.remove("is-hidden");
    must<HTMLButtonElement>("#brief-hide").textContent = "Ẩn";
    setBriefOpen(true);
    must<HTMLInputElement>("#brief-topic").focus();
  });
  must<HTMLButtonElement>("#brief-hide").addEventListener("click", () => {
    const briefBox = must<HTMLElement>("#brief");
    const id = briefBox.dataset.session || "";
    const hidden = !hiddenBriefs.has(id);
    if (hidden) hiddenBriefs.add(id);
    else hiddenBriefs.delete(id);
    briefBox.classList.toggle("is-hidden", hidden);
    must<HTMLButtonElement>("#brief-hide").textContent = hidden ? "Hiện" : "Ẩn";
    if (hidden) setBriefOpen(false);
  });
  must<HTMLButtonElement>("#brief-toggle").addEventListener("click", () => setBriefOpen(must<HTMLElement>("#brief-pop").hidden));
  must<HTMLButtonElement>("#coding-view").addEventListener("click", () => {
    void toggleCodingView().catch((err: unknown) => flash(messageOf(err)));
  });
  must<HTMLButtonElement>("#brief-summary").addEventListener("click", () => setBriefOpen(must<HTMLElement>("#brief-pop").hidden));
  must<HTMLButtonElement>("#brief-close").addEventListener("click", () => setBriefOpen(false));
  must<HTMLButtonElement>("#brief-result-open").addEventListener("click", () => openResult());
  must<HTMLButtonElement>("#brief-expand").addEventListener("click", () => openResult());
  must<HTMLButtonElement>("#result-close").addEventListener("click", () => closeResult());
  must<HTMLElement>("#result-pop").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeResult();
  });
  document.addEventListener("pointerdown", (event) => {
    const pop = must<HTMLElement>("#brief-pop");
    if (pop.hidden) return;
    const target = event.target;
    if (target instanceof Node && must<HTMLElement>("#brief").contains(target)) return;
    setBriefOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const resultPop = must<HTMLElement>("#result-pop");
    if (!resultPop.hidden) {
      closeResult();
      return;
    }
    setBriefOpen(false);
  });
  must<HTMLButtonElement>("#brief-start").addEventListener("click", () => {
    if (!active) return;
    const peerId = active;
    setBriefOpen(false);
    void guard(async () => {
      await flushBrief(peerId);
      await window.lan.startBrief(peerId);
    });
  });
  must<HTMLButtonElement>("#brief-extend").addEventListener("click", () => {
    if (!active) return;
    const peerId = active;
    setBriefOpen(false);
    void guard(async () => {
      await flushBrief(peerId);
      const extra = Math.round(Number(must<HTMLInputElement>("#brief-extra").value));
      const coding = must<HTMLInputElement>("#brief-coding").checked;
      const cap = coding ? CODING_TURN_MAX : BRIEF_TURN_MAX;
      const add = Number.isFinite(extra) ? Math.max(1, Math.min(cap, extra)) : 4;
      await window.lan.extendBrief(peerId, add);
    });
  });
  for (const id of ["#brief-topic", "#brief-goal", "#brief-turns"]) {
    must<HTMLElement>(id).addEventListener("input", () => scheduleBriefSave());
  }
  must<HTMLInputElement>("#brief-coding").addEventListener("change", () => {
    const box = must<HTMLInputElement>("#brief-coding");
    const turns = must<HTMLInputElement>("#brief-turns");
    const extra = must<HTMLInputElement>("#brief-extra");
    const cap = box.checked ? CODING_TURN_MAX : BRIEF_TURN_MAX;
    turns.max = String(cap);
    extra.max = String(cap);
    const current = Math.round(Number(turns.value));
    if (box.checked && (!Number.isFinite(current) || current <= 6)) turns.value = String(CODING_TURN_DEFAULT);
    if (!box.checked && current === CODING_TURN_DEFAULT) turns.value = "6";
    if (!active) return;
    syncCodingRoles();
    void flushBrief(active);
  });
  must<HTMLButtonElement>("#stop").addEventListener("click", () => {
    if (!active) return;
    void guard(() => window.lan.stop(active as string));
  });
  must<HTMLButtonElement>("#cancel-agent").addEventListener("click", () => {
    if (!active) return;
    void guard(() => window.lan.stop(active as string));
  });
  must<HTMLButtonElement>("#accept").addEventListener("click", () => {
    if (!active) return;
    void guard(() => window.lan.accept(active as string));
  });
  must<HTMLButtonElement>("#reject").addEventListener("click", () => {
    if (!active) return;
    void guard(() => window.lan.reject(active as string));
  });
  must<HTMLButtonElement>("#copy-http").addEventListener("click", () => {
    const text = must<HTMLPreElement>("#http-snippet").textContent ?? "";
    void navigator.clipboard.writeText(text).then(
      () => flash("Đã chép lệnh"),
      () => flash("Không chép được"),
    );
  });
  must<HTMLButtonElement>("#copy-session").addEventListener("click", () => {
    const sessionId = active && state ? state.openSession[active] || "" : "";
    if (!sessionId) {
      flash("Chưa có phiên");
      return;
    }
    void navigator.clipboard.writeText(sessionId).then(
      () => flash("Đã chép session ID"),
      () => flash("Không chép được"),
    );
  });
  must<HTMLButtonElement>("#summarize").addEventListener("click", () => {
    const pop = must<HTMLElement>("#session-tools-pop");
    pop.hidden = !pop.hidden;
    if (!pop.hidden && state) fillSummaryList(state);
  });
  must<HTMLInputElement>("#summarize-query").addEventListener("keydown", (event) => {
    if (event.key === "Enter") event.preventDefault();
  });
  must<HTMLInputElement>("#summarize-query").addEventListener("input", () => {
    if (state) fillSummaryList(state);
  });
  must<HTMLButtonElement>("#summarize-current").addEventListener("click", () => {
    const peerId = active;
    const sessionId = peerId && state ? state.openSession[peerId] || "" : "";
    if (!peerId || !sessionId) return;
    must<HTMLElement>("#session-tools-pop").hidden = true;
    void guard(() => window.lan.summarizeSession(peerId, sessionId));
  });
  must<HTMLButtonElement>("#end-cli").addEventListener("click", () => {
    if (!active || !state) return;
    const name = cliClientLabel(state.self.provider) || providerLabel(state.self.provider);
    const message = state.self.provider === "echo"
      ? "Chốt mốc hội thoại? Câu tiếp theo không kèm nội dung phía trên."
      : `Kết thúc phiên ${name}? Hội thoại vẫn nằm trên màn hình. Câu tiếp theo mở phiên mới, không kèm nội dung phía trên.`;
    if (!window.confirm(message)) return;
    const peerId = active;
    must<HTMLElement>("#session-tools-pop").hidden = true;
    void guard(() => window.lan.endAgentSession(peerId));
  });

  window.lan.onState((next) => paint(next));
  window.lan.onCodingLive((event) => {
    if (!event.sessionId) return;
    if (event.reset) codingFeed.set(event.sessionId, []);
    if (event.step?.key) {
      const list = codingFeed.get(event.sessionId) ?? [];
      const index = list.findIndex((item) => item.key === event.step?.key);
      const merged = mergeCodingStep(index >= 0 ? list[index] : undefined, event.step);
      if (index >= 0) list[index] = merged;
      else list.push(merged);
      while (list.length > 40) list.shift();
      codingFeed.set(event.sessionId, list);
    }
    if (viewedSession() === event.sessionId) paintCodingButton(event.sessionId);
  });
  window.lan.onCodingViewClosed(() => {
    codingViewSession = "";
    const sessionId = viewedSession();
    if (sessionId) paintCodingButton(sessionId);
  });
  window.lan.onNotice((notice) => {
    if (notice.open) openNotice(notice);
  });
  void window.lan.getState().then(paint).catch((err: unknown) => flash(messageOf(err)));

  function paint(next: AppState): void {
    state = next;
    mentionSelf = next.self.peerId;
    mentionNicks = next.nicknames;
    const stillPeer = Boolean(active && next.peers.some((peer) => peer.peerId === active));
    const stillGroup = Boolean(active && next.groups.some((group) => groupKey(group.id) === active));
    if (!stillPeer && !stillGroup) {
      active =
        next.peers.find((peer) => peer.status === "pending-in")?.peerId ??
        next.peers[0]?.peerId ??
        (next.groups[0] ? groupKey(next.groups[0].id) : null);
    }
    mentionFaces = mentionFacesOf(next, active ?? "");
    must<HTMLElement>("#self-name").textContent = next.self.name;
    const localNote = installedNote(next.localClis);
    const meta = must<HTMLElement>("#self-meta");
    const fullMeta = [providerLabel(next.self.provider), `${next.self.host}:${next.self.port}`, shortId(next.self.peerId), localNote].filter(Boolean).join(" · ");
    meta.textContent = `${providerLabel(next.self.provider)} · ${next.self.host}:${next.self.port}`;
    meta.dataset.tip = fullMeta;
    const sessionUnread = must<HTMLElement>("#session-unread");
    const unread = active ? unreadFor(next, active) : 0;
    sessionUnread.hidden = unread === 0;
    sessionUnread.textContent = unread > 9 ? "9+" : unread > 0 ? String(unread) : "";
    const watching = active ? next.openSession[active] ?? "" : "";
    const watchKey = `${active ?? ""}\n${watching}`;
    if (watchKey !== watchedKey) {
      watchedKey = watchKey;
      void window.lan.watch(active ?? "", watching);
    }
    fillSettings(next.settings);
    paintTools(next.localClis);
    paintPeers(next);
    paintGroups(next);
    paintHistory(next);
    paintChat(next);
    paintLogs(next.logs);
  }

  function paintLogs(lines: string[]): void {
    const key = lines.join("\n");
    if (key === logsKey) return;
    logsKey = key;
    const box = must<HTMLElement>("#logs");
    const pane = box.closest(".panel-body");
    const stuck = !pane || pane.scrollHeight - pane.scrollTop - pane.clientHeight < 64;
    box.replaceChildren();
    for (const line of lines) {
      const row = document.createElement("div");
      if (line.includes("Lỗi ·") || line.includes("Chi tiết ·")) row.className = "log-error";
      row.textContent = line;
      box.append(row);
    }
    if (stuck && pane) pane.scrollTop = pane.scrollHeight;
  }

  function paintPeers(next: AppState): void {
    if (peersEl.querySelector("input.nick-edit")) return;
    peersEl.replaceChildren();
    must<HTMLElement>("#peers-empty").hidden = next.peers.length > 0;
    for (const peer of next.peers) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.peer = peer.peerId;
      button.className = `peer${peer.peerId === active ? " active" : ""}`;
      const dot = document.createElement("i");
      dot.className = `dot ${peer.status === "none" && peer.discovered ? "online" : peer.status}`;
      const badge = document.createElement("span");
      badge.className = "peer-badge";
      badge.append(dot);
      const who = document.createElement("span");
      who.className = "who";
      const title = document.createElement("strong");
      const shown = displayName(next, peer.peerId, peer.name);
      title.textContent = shown;
      const meta = document.createElement("span");
      const where = peer.viaLocalhost ? "cùng máy" : peer.host || "chưa có IP";
      meta.textContent = [shown === peer.name ? "" : peer.name, providerLabel(peer.provider), where, peerCliNote(peer.clis), activityNote(next.activity[peer.peerId]), statusText(peer)].filter(Boolean).join(" · ");
      who.append(title, meta);
      button.append(badge, who, unreadMark(unreadFor(next, peer.peerId)));
      const row = document.createElement("div");
      row.className = "peer-row";
      const nick = document.createElement("button");
      nick.type = "button";
      nick.className = "icon-btn nick-btn";
      nick.dataset.nick = peer.peerId;
      nick.dataset.tip = next.nicknames[peer.peerId] ? "Sửa biệt danh" : "Đặt biệt danh để tag @";
      nick.setAttribute("aria-label", nick.dataset.tip);
      nick.innerHTML = icon("pencil");
      row.append(button, nick);
      peersEl.append(row);
    }
  }

  function paintGroups(next: AppState): void {
    const box = must<HTMLElement>("#groups");
    box.replaceChildren();
    if (!next.groups.length) {
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent = "Chưa có nhóm. Tạo nhóm rồi mời máy đã nối.";
      box.append(hint);
      return;
    }
    for (const group of next.groups) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.group = groupKey(group.id);
      button.className = `peer group-card${groupKey(group.id) === active ? " active" : ""}`;
      const mark = document.createElement("span");
      mark.className = "group-mark";
      mark.setAttribute("aria-hidden", "true");
      mark.innerHTML = icon("people");
      const who = document.createElement("span");
      who.className = "who";
      const title = document.createElement("strong");
      title.textContent = group.title;
      const meta = document.createElement("span");
      const turn = group.turn ? group.members.find((member) => member.peerId === group.turn?.speakerId)?.name : "";
      meta.textContent = [`${group.members.length}/${GROUP_MAX} máy`, turn ? `đến lượt ${turn}` : "chưa xếp lượt"].join(" · ");
      who.append(title, meta);
      button.append(mark, who, unreadMark(unreadFor(next, groupKey(group.id))));
      box.append(button);
    }
  }

  let composerTimer = 0;
  const remoteReplyAt = new Map<string, number>();

  function composerWait(lines: ChatLine[], peerIds: string[], sessionId: string, activity: Record<string, PeerActivity>): { locked: boolean; stop: boolean } {
    const pending = lines.find((line) => line.kind === "agent" && line.pending);
    const remoteIds = peerIds.filter((id) => {
      const item = activity[id];
      return Boolean(item?.replying && (!item.replyingSessionId || item.replyingSessionId === sessionId));
    });
    const remoteKey = `${sessionId}|${[...remoteIds].sort().join(",")}`;
    if (!remoteIds.length) {
      for (const key of remoteReplyAt.keys()) {
        if (key.startsWith(`${sessionId}|`)) remoteReplyAt.delete(key);
      }
    } else if (!remoteReplyAt.has(remoteKey)) remoteReplyAt.set(remoteKey, Date.now());
    const stamps = [pending?.createdAt ?? 0, remoteIds.length ? remoteReplyAt.get(remoteKey) ?? 0 : 0].filter((value) => value > 0);
    const since = stamps.length ? Math.min(...stamps) : 0;
    const age = since ? Date.now() - since : 0;
    const waiting = Boolean(pending || remoteIds.length);
    const locked = waiting && age < REPLY_WAIT_MS;
    window.clearTimeout(composerTimer);
    if (locked && since) {
      composerTimer = window.setTimeout(() => {
        if (state) paint(state);
      }, Math.max(0, REPLY_WAIT_MS - age) + 40);
    }
    return { locked, stop: waiting };
  }

  function agentHold(next: AppState, peerKey: string): { sessionId: string; title: string } | null {
    if (!peerKey) return null;
    const groupId = parseGroupKey(peerKey);
    const group = groupId ? next.groups.find((item) => item.id === groupId) : undefined;
    const titled = (sessionId: string, fallback = "phiên đang chạy") => {
      const title = next.sessions.find((item) => item.id === sessionId)?.title.replace(/\s+/g, " ").trim();
      return { sessionId, title: title || fallback };
    };
    if (group?.turn && group.turn.left > 0 && group.sessionId) return titled(group.sessionId);
    const sessions = next.sessions.filter((item) => item.peerId === peerKey);
    for (const session of sessions) {
      const lines = next.transcripts[session.id] ?? [];
      if (lines.some((line) => line.kind === "agent" && line.pending)) return titled(session.id, session.title);
    }
    for (const session of sessions) {
      if (next.briefs[session.id]?.running) return titled(session.id, session.title);
    }
    const people = group ? group.members.map((member) => member.peerId) : [peerKey];
    for (const id of people) {
      const activity = next.activity[id];
      const sessionId = activity?.replying ? activity.replyingSessionId : "";
      if (!sessionId) continue;
      const session = sessions.find((item) => item.id === sessionId);
      if (session) return titled(session.id, session.title);
    }
    return null;
  }

  function setComposer(locked: boolean, canSend: boolean, placeholder: string, stop: boolean): void {
    draft.disabled = locked;
    draft.placeholder = locked ? "Đang đợi agent trả lời…" : placeholder;
    must<HTMLButtonElement>("#attach").disabled = locked || !canSend;
    must<HTMLButtonElement>("#send").disabled = locked || !canSend;
    must<HTMLButtonElement>("#send-file").disabled = locked || !canSend;
    must<HTMLButtonElement>("#stop").disabled = !stop;
    must<HTMLElement>("#mention-pop").hidden = locked || must<HTMLElement>("#mention-pop").hidden;
    must<HTMLFormElement>("#composer").classList.toggle("waiting", locked);
  }

  function sessionHasSpeech(next: AppState, sessionId: string): boolean {
    return (next.transcripts[sessionId] ?? []).some((line) => line.kind !== "system" && !line.aside && line.text.trim());
  }

  function summaryOwner(next: AppState, session: AppState["sessions"][number]): { key: string; name: string; kind: "person" | "group"; search: string } {
    const groupId = parseGroupKey(session.peerId);
    if (groupId) {
      const group = next.groups.find((item) => item.id === groupId);
      const members = (group?.members ?? []).map((member) => displayName(next, member.peerId, member.name));
      const title = group?.title || "Nhóm";
      return { key: session.peerId, name: `Nhóm · ${title}`, kind: "group", search: `${title} ${members.join(" ")}`.toLowerCase() };
    }
    const peer = next.peers.find((item) => item.peerId === session.peerId);
    const name = peer ? displayName(next, peer.peerId, peer.name) : "Máy khác";
    return { key: session.peerId, name, kind: "person", search: name.toLowerCase() };
  }

  function fillSummaryList(next: AppState): void {
    const current = active ? next.openSession[active] || "" : "";
    const label = must<HTMLElement>("#session-id-label");
    label.textContent = current ? `Session ID ${current}` : "Chưa có phiên";
    const query = must<HTMLInputElement>("#summarize-query").value.trim().toLowerCase();
    const list = must<HTMLElement>("#summarize-list");
    list.replaceChildren();
    const buckets = new Map<string, { name: string; kind: "person" | "group"; search: string; sessions: AppState["sessions"] }>();
    for (const session of next.sessions) {
      if (!sessionHasSpeech(next, session.id)) continue;
      const owner = summaryOwner(next, session);
      const bucket = buckets.get(owner.key) ?? { name: owner.name, kind: owner.kind, search: owner.search, sessions: [] };
      bucket.sessions.push(session);
      buckets.set(owner.key, bucket);
    }
    const groups = [...buckets.values()]
      .map((bucket) => {
        const ownerHit = !query || bucket.search.includes(query);
        const sessions = bucket.sessions
          .filter((session) => ownerHit || session.title.toLowerCase().includes(query))
          .sort((a, b) => b.updatedAt - a.updatedAt);
        return { ...bucket, sessions };
      })
      .filter((bucket) => bucket.sessions.length > 0)
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "person" ? -1 : 1;
        return a.name.localeCompare(b.name, "vi");
      });
    if (!groups.length) {
      const empty = document.createElement("p");
      empty.className = "session-empty";
      empty.textContent = query ? "Không thấy người hoặc phiên khớp." : "Chưa có phiên để tóm tắt.";
      list.append(empty);
      return;
    }
    for (const bucket of groups) {
      const section = document.createElement("section");
      section.className = `summary-person${bucket.kind === "group" ? " is-group" : ""}`;
      const heading = document.createElement("h3");
      heading.textContent = bucket.name;
      section.append(heading);
      for (const session of bucket.sessions) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = session.id === current ? `${session.title} · đang mở` : session.title;
        button.addEventListener("click", () => {
          must<HTMLElement>("#session-tools-pop").hidden = true;
          const peerId = active;
          if (!peerId) return;
          void guard(() => window.lan.summarizeSession(peerId, session.id));
        });
        section.append(button);
      }
      list.append(section);
    }
    placeSessionTools();
  }

  function placeSessionTools(): void {
    const pop = must<HTMLElement>("#session-tools-pop");
    if (pop.hidden) return;
    const button = must<HTMLButtonElement>("#summarize");
    const rect = button.getBoundingClientRect();
    const width = Math.min(340, window.innerWidth - 16);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    const available = Math.max(140, rect.top - 16);
    const limit = Math.min(320, available);
    pop.style.width = `${width}px`;
    pop.style.maxHeight = `${limit}px`;
    pop.style.left = `${left}px`;
    const used = Math.min(pop.scrollHeight, limit);
    pop.style.top = `${Math.max(8, rect.top - 8 - used)}px`;
  }

  function paintSessionTools(next: AppState, sessionId: string): void {
    const session = next.sessions.find((item) => item.id === sessionId);
    const lines = next.transcripts[sessionId] ?? [];
    const busy = lines.some((line) => line.kind === "agent" && line.pending);
    const linked = Boolean(session && linkedClient(next, session));
    const name = cliClientLabel(next.self.provider) || providerLabel(next.self.provider);
    const copy = must<HTMLButtonElement>("#copy-session");
    const summary = must<HTMLButtonElement>("#summarize");
    const end = must<HTMLButtonElement>("#end-cli");
    copy.disabled = !sessionId;
    copy.dataset.tip = sessionId ? `Chép session ID ${sessionId}` : "Chưa có phiên";
    copy.setAttribute("aria-label", copy.dataset.tip);
    summary.disabled = !sessionId || busy;
    summary.dataset.tip = "Tóm tắt phiên này hoặc chọn phiên khác";
    summary.setAttribute("aria-label", summary.dataset.tip);
    summary.setAttribute("aria-expanded", must<HTMLElement>("#session-tools-pop").hidden ? "false" : "true");
    const canEnd = Boolean(sessionId) && !busy && (linked || lines.some((line) => line.kind !== "system"));
    end.disabled = !canEnd;
    end.dataset.tip = linked
      ? `Kết thúc phiên ${name}. Câu sau mở phiên mới, không kèm hội thoại phía trên.`
      : "Chốt mốc hội thoại. Câu sau không kèm nội dung phía trên.";
    end.setAttribute("aria-label", end.dataset.tip);
    if (!sessionId || busy) must<HTMLElement>("#session-tools-pop").hidden = true;
  }

  function paintChat(next: AppState): void {
    const group = active ? next.groups.find((item) => groupKey(item.id) === active) ?? null : null;
    if (group && active) {
      paintGroupChat(next, group);
      return;
    }
    must<HTMLElement>("#group-bar").hidden = true;
    must<HTMLElement>("#http-box").hidden = false;
    const peer = next.peers.find((item) => item.peerId === active) ?? null;
    const empty = must<HTMLElement>("#chat-empty");
    const panel = must<HTMLElement>("#chat-panel");
    empty.hidden = Boolean(peer);
    panel.hidden = !peer;
    if (!peer || !active) {
      paintSessionTools(next, "");
      return;
    }
    const head = must<HTMLElement>(".chat-head");
    head.classList.remove("group-mode");
    const machineName = displayName(next, peer.peerId, peer.name);
    const kicker = must<HTMLElement>("#chat-kicker");
    kicker.hidden = false;
    kicker.textContent = `Máy · ${machineName}`;
    must<HTMLElement>("#chat-title").hidden = true;
    must<HTMLElement>("#chat-title").textContent = machineName;
    must<HTMLButtonElement>("#delete-group").hidden = true;
    must<HTMLButtonElement>("#link").hidden = false;
    const sessionTitle = must<HTMLInputElement>("#session-title");
    sessionTitle.hidden = false;
    sessionTitle.placeholder = "Tên phiên";
    sessionTitle.dataset.tip = "Tên phiên. Enter để lưu.";
    const deleteChat = must<HTMLButtonElement>("#delete-chat");
    setIcon(deleteChat, "trash", "Xóa phiên hội thoại");
    const where = peer.viaLocalhost ? "cùng máy" : `${peer.host}:${peer.port}`;
    const sessionId = next.openSession[active] ?? "";
    deleteChat.disabled = !sessionId;
    if (messagesEl.dataset.session !== sessionId) {
      messagesEl.replaceChildren();
      messagesEl.dataset.session = sessionId;
      if (typingOn) noteTyping(false);
    }
    const typing = must<HTMLElement>("#typing");
    const activityText = activitySentence(peer.name, next.activity[peer.peerId], sessionId);
    typing.hidden = !activityText;
    typing.textContent = activityText;
    const link = must<HTMLButtonElement>("#link");
    const connected = peer.status === "connected";
    const linkTip = connected ? "Ngắt kết nối" : peer.status === "pending-out" ? "Đang chờ máy kia chấp nhận" : peer.status === "connecting" ? "Đang nối" : "Kết nối";
    setIcon(link, connected ? "unlink" : "link", linkTip);
    link.disabled = peer.status === "connecting" || peer.status === "pending-out";
    link.onclick = () => {
      const peerId = active;
      if (!peerId) return;
      void guard(() => (connected ? window.lan.disconnect(peerId) : window.lan.connect(peerId)));
    };
    const banner = must<HTMLElement>("#banner");
    banner.hidden = peer.status !== "pending-in";
    must<HTMLElement>("#banner-text").textContent = `${peer.name} muốn nối vào máy này.`;
    const session = next.sessions.find((item) => item.id === sessionId);
    const lines = next.transcripts[sessionId] ?? [];
    const nameInput = must<HTMLInputElement>("#session-title");
    nameInput.disabled = !session;
    if (document.activeElement !== nameInput) nameInput.value = session?.title ?? "";
    must<HTMLElement>("#chat-status").textContent = [providerLabel(peer.provider), where, peerCliNote(peer.clis), next.briefs[sessionId]?.coding ? "Coding" : "", sessionLinkNote(next, session), statusText(peer)]
      .filter(Boolean)
      .join(" · ");
    paintMessages(messagesEl, lines, next.self.peerId, nearBottom(messagesEl), historyQuery);
    if (focusLine) {
      const hit = messagesEl.querySelector<HTMLElement>(`[data-id="${cssEscape(focusLine)}"]`);
      focusLine = "";
      hit?.scrollIntoView({ block: "center" });
    }
    const canSend = connected || Boolean(peer.token);
    const waiting = composerWait(lines, [peer.peerId], sessionId, next.activity);
    setComposer(waiting.locked, canSend, "Tin nhắn thường. Gõ @đối phương để gọi agent đó, @me là máy này…", waiting.stop || Boolean(agentHold(next, peer.peerId)));
    paintBrief(sessionId, next.briefs[sessionId], lines, connected, "");
    paintCodingButton(sessionId);
    must<HTMLInputElement>("#brief-topic").placeholder = "Việc hai agent cần bàn";
    const snippet = peer.token
      ? [
          `curl -X POST http://${peer.host}:${peer.port}/trigger`,
          `  -H "Authorization: Bearer ${peer.token}"`,
          `  -H "Content-Type: application/json"`,
          `  -d "{\\"text\\":\\"Xin chào từ máy khác\\"}"`,
        ].join("\n")
      : "Nối máy trước. Token ghép nối xuất hiện sau khi hai bên chấp nhận.";
    must<HTMLPreElement>("#http-snippet").textContent = snippet;
    paintSessionTools(next, sessionId);
  }

  let briefTimer = 0;
  let liveCoding = false;
  const codingFeed = new Map<string, CodingStep[]>();
  let codingViewSession = "";
  let briefFilesKey = "";
  let briefDockKey = "";
  let briefAnchor = "";
  const hiddenBriefs = new Set<string>();

  function setBriefOpen(open: boolean): void {
    const pop = must<HTMLElement>("#brief-pop");
    const toggle = must<HTMLButtonElement>("#brief-toggle");
    pop.hidden = !open;
    toggle.classList.toggle("active", open);
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    must<HTMLButtonElement>("#brief-summary").setAttribute("aria-expanded", open ? "true" : "false");
  }

  function paintGroupChat(next: AppState, group: GroupRoom): void {
    const key = groupKey(group.id);
    must<HTMLElement>("#chat-empty").hidden = true;
    must<HTMLElement>("#chat-panel").hidden = false;
    must<HTMLElement>("#http-box").hidden = true;
    const head = must<HTMLElement>(".chat-head");
    head.classList.add("group-mode");
    const host = group.hostId === next.self.peerId;
    const kicker = must<HTMLElement>("#chat-kicker");
    kicker.hidden = false;
    kicker.textContent = "Nhóm";
    const title = must<HTMLElement>("#chat-title");
    title.textContent = group.title;
    title.hidden = host;
    const deleteGroup = must<HTMLButtonElement>("#delete-group");
    deleteGroup.hidden = false;
    setIcon(deleteGroup, "x", host ? "Xóa nhóm" : "Rời nhóm");
    const deleteChat = must<HTMLButtonElement>("#delete-chat");
    setIcon(deleteChat, "trash", host ? "Xóa hội thoại nhóm" : "Xóa hội thoại trên máy này");
    must<HTMLButtonElement>("#link").hidden = true;
    const sessionId = next.openSession[key] || group.sessionId;
    deleteChat.disabled = !sessionId;
    if (messagesEl.dataset.session !== sessionId) {
      messagesEl.replaceChildren();
      messagesEl.dataset.session = sessionId;
      if (typingOn) noteTyping(false);
    }
    const linked = host || next.peers.some((peer) => peer.peerId === group.hostId && peer.status === "connected");
    const lines = next.transcripts[sessionId] ?? [];
    const typing = must<HTMLElement>("#typing");
    const activityText = group.members
      .filter((member) => member.peerId !== next.self.peerId)
      .map((member) => activitySentence(member.name, next.activity[member.peerId], sessionId))
      .filter(Boolean)
      .join(" ");
    typing.hidden = !activityText;
    typing.textContent = activityText;
    const link = must<HTMLButtonElement>("#link");
    setIcon(link, "unlink", host ? "Đóng nhóm" : "Rời nhóm");
    link.disabled = false;
    link.onclick = () => {
      void guard(() => window.lan.leaveGroup(group.id));
    };
    must<HTMLElement>("#banner").hidden = true;
    const nameInput = must<HTMLInputElement>("#session-title");
    nameInput.hidden = !host;
    nameInput.disabled = !host;
    nameInput.placeholder = "Tên nhóm";
    nameInput.dataset.tip = "Tên nhóm. Enter để lưu.";
    if (document.activeElement !== nameInput) nameInput.value = group.title;
    const turnMember = group.turn ? group.members.find((member) => member.peerId === group.turn?.speakerId) : undefined;
    const turnName = turnMember ? displayName(next, turnMember.peerId, turnMember.name) : "";
    const groupSession = next.sessions.find((item) => item.id === sessionId);
    must<HTMLElement>("#chat-status").textContent = [
      `${group.members.length}/${GROUP_MAX} máy`,
      host ? "Bạn tạo nhóm" : "Máy khác tạo nhóm",
      turnName ? `Đến lượt ${turnName}` : "",
      next.briefs[sessionId]?.coding ? "Coding" : "",
      sessionLinkNote(next, groupSession),
    ]
      .filter(Boolean)
      .join(" · ");
    paintMessages(messagesEl, lines, next.self.peerId, nearBottom(messagesEl), historyQuery);
    if (focusLine) {
      const hit = messagesEl.querySelector<HTMLElement>(`[data-id="${cssEscape(focusLine)}"]`);
      focusLine = "";
      hit?.scrollIntoView({ block: "center" });
    }
    must<HTMLButtonElement>("#new-session").disabled = false;
    const others = group.members.filter((member) => member.peerId !== next.self.peerId).map((member) => member.peerId);
    const waiting = composerWait(lines, others, sessionId, next.activity);
    setComposer(waiting.locked, linked, "Nhắn trong nhóm. Gõ @ để gọi agent, @me là máy này…", waiting.stop || Boolean(group.turn && group.turn.left > 0));
    paintBrief(sessionId, next.briefs[sessionId], lines, linked, turnName);
    paintCodingButton(sessionId);
    paintGroupBar(next, group);
    const topic = must<HTMLInputElement>("#brief-topic");
    topic.placeholder = "Chủ đề chung. Gõ @tên hoặc @me nếu chỉ muốn vài agent nói";
    paintSessionTools(next, sessionId);
  }

  function paintGroupBar(next: AppState, group: GroupRoom): void {
    const bar = must<HTMLElement>("#group-bar");
    bar.hidden = false;
    const host = group.hostId === next.self.peerId;
    const box = must<HTMLElement>("#group-members");
    if (box.querySelector("input.nick-edit, select.role-pick:focus")) return;
    box.replaceChildren();
    const openId = next.openSession[groupKey(group.id)] || group.sessionId;
    const coding = liveCoding || Boolean(next.briefs[openId]?.coding);
    const codingRunning = Boolean(next.briefs[openId]?.running);
    for (const member of group.members) {
      const chip = document.createElement("span");
      const online = member.peerId === next.self.peerId || next.peers.some((peer) => peer.peerId === member.peerId && peer.status === "connected");
      const mine = member.peerId === next.self.peerId;
      const shown = displayName(next, member.peerId, member.name);
      chip.className = `member-chip${online ? " on" : ""}${mine ? " me" : ""}`;
      const label = document.createElement("span");
      label.textContent = mine ? `${shown} · bạn` : shown;
      if (!mine && shown !== member.name) label.title = member.name;
      chip.append(label);
      if (coding && host) {
        const select = document.createElement("select");
        select.className = "role-pick";
        select.disabled = codingRunning;
        select.setAttribute("aria-label", `Vai của ${shown}`);
        const none = document.createElement("option");
        none.value = "";
        none.textContent = "Vai";
        select.append(none);
        for (const role of CODING_ROLES) {
          const option = document.createElement("option");
          option.value = role;
          option.textContent = codingRoleLabel(role);
          select.append(option);
        }
        select.value = member.role || "";
        select.addEventListener("change", () => {
          void guard(() => window.lan.setMemberRole(group.id, member.peerId, select.value));
        });
        chip.append(select);
      } else if (coding && member.role) {
        const badge = document.createElement("span");
        badge.className = "role-badge";
        badge.textContent = codingRoleLabel(member.role);
        chip.append(badge);
      }
      if (!mine) {
        const nick = document.createElement("button");
        nick.type = "button";
        nick.className = "icon-btn";
        nick.dataset.tip = next.nicknames[member.peerId] ? "Sửa biệt danh" : "Đặt biệt danh để tag @";
        nick.setAttribute("aria-label", nick.dataset.tip);
        nick.innerHTML = icon("pencil");
        nick.addEventListener("click", () => beginNickname(chip, member.peerId, next.nicknames[member.peerId] || ""));
        chip.append(nick);
      }
      if (host && member.peerId !== next.self.peerId) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "×";
        remove.dataset.tip = `Cho ${member.name} rời nhóm`;
        remove.setAttribute("aria-label", `Cho ${member.name} rời nhóm`);
        remove.addEventListener("click", () => {
          void guard(() => window.lan.leaveGroup(group.id, member.peerId));
        });
        chip.append(remove);
      }
      box.append(chip);
    }
    const form = must<HTMLFormElement>("#group-invite");
    const pick = must<HTMLSelectElement>("#group-pick");
    form.hidden = !host || group.members.length >= GROUP_MAX;
    if (document.activeElement === pick) return;
    const choices = next.peers.filter((peer) => peer.status === "connected" && !group.members.some((member) => member.peerId === peer.peerId));
    pick.replaceChildren();
    if (!choices.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "Không có máy đã nối";
      pick.append(option);
      return;
    }
    for (const peer of choices) {
      const option = document.createElement("option");
      option.value = peer.peerId;
      option.textContent = peer.name;
      pick.append(option);
    }
  }

  function syncCodingRoles(): void {
    if (!state || !active) return;
    const grouped = Boolean(parseGroupKey(active));
    const codingOn = must<HTMLInputElement>("#brief-coding").checked;
    liveCoding = codingOn;
    const groupId = parseGroupKey(active);
    const group = groupId ? state.groups.find((item) => item.id === groupId) : undefined;
    const sessionId = state.openSession[active] || group?.sessionId || "";
    paintBriefRoles(grouped, codingOn, Boolean(state.briefs[sessionId]?.running));
    if (group) paintGroupBar(state, group);
    if (codingOn && grouped) must<HTMLElement>("#brief-roles").scrollIntoView({ block: "nearest" });
  }

  function paintBriefRoles(grouped: boolean, codingOn: boolean, running: boolean): void {
    const box = must<HTMLElement>("#brief-roles");
    const groupId = active ? parseGroupKey(active) : null;
    const group = groupId && state ? state.groups.find((item) => item.id === groupId) : undefined;
    if (!grouped || !codingOn || !group || !state) {
      box.hidden = true;
      if (!box.querySelector("select:focus")) {
        box.replaceChildren();
        delete box.dataset.key;
      }
      return;
    }
    box.hidden = false;
    if (box.querySelector("select:focus")) return;
    const host = group.hostId === state.self.peerId;
    const key = `${host ? 1 : 0}:${running ? 1 : 0}:${group.members.map((member) => `${member.peerId}:${member.role || ""}`).join("|")}`;
    if (box.dataset.key === key) return;
    box.dataset.key = key;
    box.replaceChildren();
    const title = document.createElement("strong");
    title.textContent = "Phân vai";
    box.append(title);
    for (const member of group.members) {
      const row = document.createElement("div");
      row.className = "brief-role";
      const name = document.createElement("span");
      const shown = displayName(state, member.peerId, member.name);
      name.textContent = member.peerId === state.self.peerId ? `${shown} · bạn` : shown;
      row.append(name);
      if (host) {
        const select = document.createElement("select");
        select.disabled = running;
        select.setAttribute("aria-label", `Vai của ${shown}`);
        const none = document.createElement("option");
        none.value = "";
        none.textContent = "Chọn vai";
        select.append(none);
        for (const role of CODING_ROLES) {
          const option = document.createElement("option");
          option.value = role;
          option.textContent = codingRoleLabel(role);
          select.append(option);
        }
        select.value = member.role || "";
        select.addEventListener("change", () => {
          box.dataset.key = "";
          void guard(() => window.lan.setMemberRole(group.id, member.peerId, select.value));
        });
        row.append(select);
      } else {
        const badge = document.createElement("span");
        badge.className = "role-badge";
        badge.textContent = member.role ? codingRoleLabel(member.role) : "Chưa giao";
        row.append(badge);
      }
      box.append(row);
    }
  }

  function paintBrief(sessionId: string, brief: ProjectBrief | undefined, lines: ChatLine[], connected: boolean, turnName = ""): void {
    const current: ProjectBrief = brief ?? {
      topic: "",
      goal: "",
      turnLimit: 6,
      turnsUsed: 0,
      running: false,
      coding: false,
      needTurns: 0,
      codingSince: 0,
      files: [],
    };
    const topic = must<HTMLInputElement>("#brief-topic");
    const goal = must<HTMLTextAreaElement>("#brief-goal");
    const turns = must<HTMLInputElement>("#brief-turns");
    const grouped = Boolean(active && parseGroupKey(active));
    const codingBox = must<HTMLInputElement>("#brief-coding");
    const codingOn = document.activeElement === codingBox ? codingBox.checked : current.coding;
    liveCoding = codingOn;
    const cap = codingOn ? CODING_TURN_MAX : BRIEF_TURN_MAX;
    setIfIdle(topic, current.topic);
    setIfIdle(goal, current.goal);
    setIfIdle(turns, String(current.turnLimit));
    turns.max = String(cap);
    topic.disabled = current.running;
    goal.disabled = current.running;
    turns.disabled = current.running;
    const codingRow = must<HTMLElement>("#brief-coding-row");
    codingRow.hidden = false;
    if (document.activeElement !== codingBox) codingBox.checked = codingOn;
    codingBox.disabled = current.running;
    must<HTMLElement>("#brief-coding-copy").textContent = codingCopy(grouped);
    paintBriefRoles(grouped, codingOn, current.running);
    const replies = turns.closest("label");
    if (replies instanceof HTMLElement) {
      replies.dataset.tip = codingOn
        ? `Số lượt coding, mặc định ${CODING_TURN_DEFAULT}, tối đa ${CODING_TURN_MAX}. Có kết quả thì dừng sớm.`
        : `Số lượt agent được trả lời nhau, tối đa ${BRIEF_TURN_MAX}`;
    }
    const extra = must<HTMLInputElement>("#brief-extra");
    extra.max = String(cap);
    const stamp = String(current.needTurns || "");
    if (document.activeElement !== extra && extra.dataset.need !== stamp) {
      extra.dataset.need = stamp;
      if (current.needTurns > 0) extra.value = String(current.needTurns);
    }
    const extendBox = extra.parentElement;
    if (extendBox) {
      extendBox.dataset.tip = current.needTurns > 0
        ? `Agent lượt cuối ước tính cần thêm ${current.needTurns} lượt`
        : "Số lượt cộng thêm khi gia hạn";
    }
    must<HTMLButtonElement>("#brief-add").disabled = current.running || current.files.length >= BRIEF_FILE_MAX;
    must<HTMLButtonElement>("#brief-start").disabled = !connected || current.running;
    must<HTMLButtonElement>("#brief-extend").disabled = !connected || (!current.running && current.turnsUsed === 0);
    const anchor = `${active ?? ""}:${sessionId}`;
    if (briefAnchor && briefAnchor !== anchor) {
      setBriefOpen(false);
      briefDockKey = "";
    }
    briefAnchor = anchor;
    const briefBox = must<HTMLElement>("#brief");
    briefBox.dataset.session = sessionId;
    const hidden = hiddenBriefs.has(sessionId);
    briefBox.classList.toggle("is-hidden", hidden);
    must<HTMLButtonElement>("#brief-hide").textContent = hidden ? "Hiện" : "Ẩn";
    must<HTMLButtonElement>("#brief-new").textContent = current.topic.trim() ? "Sửa chủ đề" : "Thêm chủ đề";
    const summary = must<HTMLButtonElement>("#brief-summary");
    const title = current.topic.trim();
    summary.textContent = title || "Chưa đặt chủ đề";
    summary.classList.toggle("empty", !title);
    summary.title = title;
    const fileNote = current.files.length ? ` · ${current.files.length} file` : "";
    const turnNote = turnName && current.running ? `Đến lượt ${turnName} · ` : "";
    must<HTMLElement>("#brief-meter").textContent = `${turnNote}${briefMeter(current)}${fileNote}`;
    paintBriefFiles(sessionId, current.files, current.running);
    paintBriefDock(sessionId, current.files);
    const result = latestResult(lines);
    const box = must<HTMLElement>("#brief-result");
    const resultTextNode = box.querySelector("span");
    const resultPop = must<HTMLElement>("#result-pop");
    if (!result) {
      box.hidden = true;
      if (resultTextNode) resultTextNode.textContent = "";
      delete box.dataset.full;
      resultPop.hidden = true;
    } else {
      box.hidden = false;
      if (box.dataset.full !== result) {
        box.dataset.full = result;
        if (resultTextNode) resultTextNode.textContent = result;
        if (!resultPop.hidden) paintResultBody(result);
      }
    }
  }

  function openResult(): void {
    const full = must<HTMLElement>("#brief-result").dataset.full ?? "";
    if (!full) return;
    const title = must<HTMLElement>("#brief-summary").textContent?.trim() ?? "";
    must<HTMLElement>("#result-title").textContent = title && title !== "Chưa đặt chủ đề" ? title : "Kết quả";
    paintResultBody(full);
    must<HTMLElement>("#result-pop").hidden = false;
  }

  function closeResult(): void {
    must<HTMLElement>("#result-pop").hidden = true;
  }

  function paintResultBody(text: string): void {
    must<HTMLElement>("#result-body").innerHTML = renderMarkdownHtml(text);
  }

  function paintBriefDock(sessionId: string, files: BriefFile[]): void {
    const dock = must<HTMLElement>("#brief-dock");
    const key = `${sessionId}:${files.map((file) => `${file.name}:${file.path ?? ""}`).join("|")}`;
    if (key === briefDockKey) return;
    briefDockKey = key;
    dock.replaceChildren();
    dock.hidden = files.length === 0;
    for (const file of files) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "brief-preview";
      button.dataset.tip = `Xem ${file.name}`;
      const ref = file.path ? fileRef(file.path) : null;
      if (ref?.preview === "image" && file.path) {
        const img = document.createElement("img");
        img.alt = file.name;
        img.src = previewSrc(file.path);
        button.append(img);
      }
      const name = document.createElement("span");
      name.textContent = file.name;
      button.append(name);
      button.addEventListener("click", () => {
        void openBriefPreview(sessionId, file);
      });
      dock.append(button);
    }
  }

  async function openBriefPreview(sessionId: string, file: BriefFile): Promise<void> {
    const ref = file.path ? fileRef(file.path) : null;
    if (ref) {
      showDock(ref);
      return;
    }
    const opened = await window.lan.openBriefFile(sessionId, file.name);
    if (opened) {
      showDock(opened);
      return;
    }
    if (file.path) return;
    flash("Không thấy file trên máy này.");
  }

  function setIfIdle(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    if (document.activeElement === el) return;
    if (el.value !== value) el.value = value;
  }

  function paintBriefFiles(sessionId: string, files: BriefFile[], locked: boolean): void {
    const box = must<HTMLElement>("#brief-files");
    const key = `${sessionId}:${locked ? 1 : 0}:${files.map((file) => file.name).join("|")}`;
    if (key === briefFilesKey) return;
    briefFilesKey = key;
    box.replaceChildren();
    if (!files.length) {
      const empty = document.createElement("span");
      empty.className = "brief-meter";
      empty.textContent = "Chưa có file context.";
      box.append(empty);
      return;
    }
    for (const file of files) {
      const row = document.createElement("div");
      row.className = "brief-file";
      const name = document.createElement("button");
      name.type = "button";
      name.textContent = file.name;
      name.title = `Xem ${file.name}`;
      name.addEventListener("click", () => {
        void openBriefPreview(sessionId, file);
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Bỏ";
      remove.disabled = locked;
      remove.addEventListener("click", () => {
        const peerId = active;
        if (!peerId) return;
        void guard(() => window.lan.removeBriefFile(peerId, file.name));
      });
      row.append(name, remove);
      box.append(row);
    }
  }

  function codingCopy(grouped: boolean): string {
    return grouped
      ? "Chế độ coding. Mỗi agent chỉ làm đúng vai đã giao. Mặc định 50 lượt, dừng ngay khi có kết quả. Nút Coding trên đầu hội thoại mở cửa sổ nổi, nền tối, và nhấp nháy khi agent đang sửa code. Icon trên tin nhắn agent mở file log Markdown, xem lại hoặc xóa lúc nào cũng được."
      : "Chế độ coding. Hai agent cùng làm. Mặc định 50 lượt, dừng khi có kết quả. Nút Coding trên đầu hội thoại mở cửa sổ nổi của máy đang sửa. Icon trên tin nhắn agent mở file log Markdown của máy đó.";
  }

  function viewedSession(): string {
    if (!state || !active) return "";
    const group = state.groups.find((item) => groupKey(item.id) === active);
    if (group) return state.openSession[active] || group.sessionId;
    return state.openSession[active] ?? "";
  }

  function codingBusy(sessionId: string): boolean {
    const brief = state?.briefs[sessionId];
    const steps = codingFeed.get(sessionId) ?? [];
    return Boolean(brief?.running) || steps.some((step) => step.status === "run");
  }

  function savedCoding(sessionId: string): boolean {
    return (state?.transcripts[sessionId] ?? []).some((line) => Boolean(line.codingLog));
  }

  function paintCodingButton(sessionId: string): void {
    const button = must<HTMLButtonElement>("#coding-view");
    const brief = state?.briefs[sessionId];
    const steps = codingFeed.get(sessionId) ?? [];
    const show = Boolean(brief?.coding) || Boolean(brief?.codingSince) || steps.length > 0 || savedCoding(sessionId);
    button.hidden = !show;
    if (!show) return;
    const live = codingBusy(sessionId);
    const running = [...steps].reverse().find((step) => step.status === "run");
    const open = codingViewSession === sessionId;
    button.classList.toggle("live", live);
    button.classList.toggle("open", open);
    button.setAttribute("aria-pressed", open ? "true" : "false");
    const text = live ? running?.label || "Agent đang coding" : "Xem coding";
    must<HTMLElement>("#coding-view-label").textContent = text;
    button.dataset.tip = live ? "Agent đang coding. Bấm để mở hoặc đóng cửa sổ." : "Mở bản coding đã lưu của phiên này.";
    button.setAttribute("aria-label", button.dataset.tip);
  }

  async function stepsForCodingView(sessionId: string): Promise<CodingStep[]> {
    const live = codingFeed.get(sessionId) ?? [];
    if (live.length) return live;
    if (codingFeed.has(sessionId) && codingBusy(sessionId)) return live;
    const saved = await window.lan.codingReplay(sessionId);
    return Array.isArray(saved) ? saved : [];
  }

  async function toggleCodingView(): Promise<void> {
    const sessionId = viewedSession();
    if (!sessionId || !state) return;
    const group = active ? state.groups.find((item) => groupKey(item.id) === active) : undefined;
    const session = state.sessions.find((item) => item.id === sessionId);
    const open = await window.lan.toggleCodingView({
      sessionId,
      title: group?.title || session?.title || "Coding",
      steps: await stepsForCodingView(sessionId),
      live: codingBusy(sessionId),
      workDir: state.settings.workDir,
    });
    codingViewSession = open ? sessionId : "";
    paintCodingButton(sessionId);
  }

  function briefMeter(brief: ProjectBrief): string {
    const prefix = brief.coding ? "Coding " : "";
    if (brief.running) return `${prefix}đang nói ${brief.turnsUsed}/${brief.turnLimit}`;
    if (brief.needTurns > 0) return `${prefix}hết lượt. Cần thêm ${brief.needTurns}`;
    if (brief.turnsUsed > 0 && brief.turnsUsed >= brief.turnLimit) return `${prefix}hết ${brief.turnsUsed}/${brief.turnLimit} lượt`;
    if (brief.turnsUsed > 0) return `${prefix}đã nói ${brief.turnsUsed}/${brief.turnLimit}`;
    return `${prefix}${brief.turnLimit} lượt`;
  }

  function latestResult(lines: ChatLine[]): string {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (line.kind !== "agent" || line.pending) continue;
      const found = resultText(line.text);
      if (found) return shownMentionText(found);
    }
    return "";
  }

  function scheduleBriefSave(): void {
    const peerId = active;
    if (!peerId) return;
    window.clearTimeout(briefTimer);
    briefTimer = window.setTimeout(() => {
      void flushBrief(peerId);
    }, 350);
  }

  async function flushBrief(peerId: string): Promise<void> {
    const coding = must<HTMLInputElement>("#brief-coding").checked;
    const cap = coding ? CODING_TURN_MAX : BRIEF_TURN_MAX;
    const turns = Number(must<HTMLInputElement>("#brief-turns").value);
    await window.lan.saveBrief(peerId, {
      topic: must<HTMLInputElement>("#brief-topic").value,
      goal: must<HTMLTextAreaElement>("#brief-goal").value,
      turnLimit: Number.isFinite(turns) ? Math.max(1, Math.min(cap, Math.round(turns))) : coding ? CODING_TURN_DEFAULT : 6,
      coding,
    });
  }

  function paintAccess(ids: string[]): void {
    const on = new Set(ids);
    for (const input of Array.from(document.querySelectorAll<HTMLInputElement>("[data-access]"))) {
      input.checked = on.has(input.dataset.access || "");
    }
  }

  function paintSkillFields(settings: Settings): void {
    must<HTMLInputElement>("#set-claude-skill").value = settings.claudeSkillDir;
    must<HTMLInputElement>("#set-cursor-skill").value = settings.cursorSkillDir;
    must<HTMLInputElement>("#set-codex-skill").value = settings.codexSkillDir;
    must<HTMLInputElement>("#set-gemini-skill").value = settings.geminiSkillDir;
  }

  function openSkills(): void {
    if (state) paintSkillFields(state.settings);
    must<HTMLElement>("#skill-pop").hidden = false;
  }

  function closeSkills(): void {
    if (state) paintSkillFields(state.settings);
    must<HTMLElement>("#skill-pop").hidden = true;
  }

  function closeAccess(): void {
    paintAccess(state?.settings.access ?? defaultAccess());
    must<HTMLElement>("#access-pop").hidden = true;
  }

  function fillSettings(settings: Settings): void {
    if (settingsReady) return;
    must<HTMLInputElement>("#set-name").value = settings.name;
    must<HTMLSelectElement>("#set-provider").value = settings.provider;
    must<HTMLInputElement>("#set-claude-command").value = settings.claudeCommand;
    must<HTMLInputElement>("#set-cursor-command").value = settings.cursorCommand;
    must<HTMLInputElement>("#set-codex-command").value = settings.codexCommand;
    must<HTMLInputElement>("#set-gemini-command").value = settings.geminiCommand;
    must<HTMLInputElement>("#set-cwd").value = settings.workDir;
    paintSkillFields(settings);
    must<HTMLInputElement>("#set-confine").checked = settings.confineWorkDir;
    must<HTMLInputElement>("#set-auto").checked = settings.autoAccept;
    paintAccess(settings.access);
    settingsReady = true;
    void refreshFiles();
  }

  function readSettings(): Settings {
    const provider = must<HTMLSelectElement>("#set-provider").value;
    return {
      name: must<HTMLInputElement>("#set-name").value,
      provider: provider === "claude-cli" || provider === "cursor-cli" || provider === "codex-cli" || provider === "gemini-cli" ? provider : "echo",
      workDir: must<HTMLInputElement>("#set-cwd").value,
      claudeCommand: must<HTMLInputElement>("#set-claude-command").value,
      cursorCommand: must<HTMLInputElement>("#set-cursor-command").value,
      codexCommand: must<HTMLInputElement>("#set-codex-command").value,
      geminiCommand: must<HTMLInputElement>("#set-gemini-command").value,
      claudeSkillDir: must<HTMLInputElement>("#set-claude-skill").value,
      cursorSkillDir: must<HTMLInputElement>("#set-cursor-skill").value,
      codexSkillDir: must<HTMLInputElement>("#set-codex-skill").value,
      geminiSkillDir: must<HTMLInputElement>("#set-gemini-skill").value,
      confineWorkDir: must<HTMLInputElement>("#set-confine").checked,
      access: Array.from(document.querySelectorAll<HTMLInputElement>("[data-access]"))
        .filter((input) => input.checked)
        .map((input) => input.dataset.access || "")
        .filter(Boolean),
      autoAccept: must<HTMLInputElement>("#set-auto").checked,
    };
  }

  let typingOn = false;
  let typingTimer = 0;
  let typingSession = "";

  function noteTyping(activeNow: boolean): void {
    const peerId = active;
    if (!peerId) return;
    const sessionId = state?.openSession[peerId] ?? typingSession;
    window.clearTimeout(typingTimer);
    if (!activeNow) {
      if (!typingOn) return;
      typingOn = false;
      const ended = typingSession || sessionId;
      typingSession = "";
      void window.lan.activity(peerId, { typing: false, sessionId: ended });
      return;
    }
    if (!typingOn || typingSession !== sessionId) {
      typingOn = true;
      typingSession = sessionId;
      void window.lan.activity(peerId, { typing: true, sessionId });
    }
    typingTimer = window.setTimeout(() => noteTyping(false), 900);
  }

  let attached = "";

  function paintAttach(): void {
    const chip = must<HTMLElement>("#attach-chip");
    chip.hidden = !attached;
    must<HTMLElement>("#attach-name").textContent = attached ? attached.split(/[/\\]/).pop() || attached : "";
  }

  must<HTMLButtonElement>("#attach").addEventListener("click", () => {
    void guard(async () => {
      const picked = await window.lan.pickDiscuss();
      if (!picked) return;
      attached = picked;
      paintAttach();
    });
  });
  must<HTMLButtonElement>("#attach-clear").addEventListener("click", () => {
    attached = "";
    paintAttach();
  });

  async function sendDraft(): Promise<void> {
    if (!active || draft.disabled) return;
    const text = draft.value;
    const file = attached;
    if (!text.trim() && !file) return;
    const peerId = active;
    draft.value = "";
    attached = "";
    paintAttach();
    must<HTMLElement>("#mention-pop").hidden = true;
    must<HTMLElement>("#session-tools-pop").hidden = true;
    noteTyping(false);
    await guard(() => window.lan.send(peerId, text, file || undefined));
  }

  async function guard(action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
    } catch (err) {
      flash(messageOf(err));
    }
  }

  function showDock(file: FileRef): void {
    void guard(() => window.lan.showPreview(file));
  }

  function closeHistoryMenus(): void {
    for (const pop of Array.from(document.querySelectorAll<HTMLElement>(".history-menu-pop"))) pop.hidden = true;
  }

  function placeHistoryMenu(pop: HTMLElement, button: HTMLElement): void {
    const rect = button.getBoundingClientRect();
    pop.hidden = false;
    pop.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
    const spaceBelow = window.innerHeight - rect.bottom;
    pop.style.top = spaceBelow < 92 ? `${Math.max(8, rect.top - 84)}px` : `${rect.bottom + 4}px`;
  }

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest(".history-menu")) return;
    closeHistoryMenus();
    if (target instanceof Element && (target.closest("#session-tools-pop") || target.closest("#summarize"))) return;
    must<HTMLElement>("#session-tools-pop").hidden = true;
  });
  window.addEventListener("resize", () => placeSessionTools());
  must<HTMLElement>("#history-list").addEventListener("scroll", () => closeHistoryMenus());

  function selectedCaption(next: AppState): { title: string; meta: string } {
    if (!active) return { title: "Chưa chọn máy", meta: "Chọn một máy ở cột bên trái." };
    const groupId = parseGroupKey(active);
    if (groupId) {
      const group = next.groups.find((item) => item.id === groupId);
      return { title: group?.title || "Nhóm", meta: "Các phiên của nhóm này" };
    }
    const peer = next.peers.find((item) => item.peerId === active);
    if (!peer) return { title: "Máy", meta: "Các phiên của máy này" };
    const where = peer.viaLocalhost ? "cùng máy" : peer.host || "";
    return { title: displayName(next, peer.peerId, peer.name), meta: where || "Các phiên của máy này" };
  }

  function paintHistory(next: AppState): void {
    const caption = selectedCaption(next);
    must<HTMLElement>("#session-peer").textContent = caption.title;
    must<HTMLElement>("#session-peer-meta").textContent = caption.meta;
    const box = must<HTMLElement>("#history-list");
    const query = historyQuery.trim().toLowerCase();
    const mine = active ? next.sessions.filter((session) => session.peerId === active) : next.sessions;
    const openId = active ? next.openSession[active] : "";
    const rows = mine
      .map((session) => {
        const lines = next.transcripts[session.id] ?? [];
        const peer = next.peers.find((item) => item.peerId === session.peerId);
        const group = next.groups.find((item) => groupKey(item.id) === session.peerId);
        const blob = `${session.title}\n${group?.title ?? peer?.name ?? ""}\n${lines.map((line) => line.text).join("\n")}`.toLowerCase();
        const matched = query ? lines.find((line) => line.text.toLowerCase().includes(query)) : undefined;
        const last = [...lines].reverse().find((line) => line.text.trim());
        return { session, lines, peer, matched, last, shown: !query || blob.includes(query) };
      })
      .filter((row) => row.shown)
      .sort((a, b) => b.session.updatedAt - a.session.updatedAt);
    box.replaceChildren();
    const hold = active ? agentHold(next, active) : null;
    const cancel = must<HTMLButtonElement>("#cancel-agent");
    cancel.hidden = !hold;
    if (hold) {
      cancel.dataset.tip = `Dừng agent đang chạy ở phiên ${hold.title}`;
      cancel.setAttribute("aria-label", cancel.dataset.tip);
    }
    const newer = must<HTMLButtonElement>("#new-session");
    const groupOpen = Boolean(active && parseGroupKey(active));
    newer.disabled = !active;
    newer.dataset.tip = groupOpen ? "Phiên mới trong nhóm này" : "Phiên mới với máy đang chọn";
    newer.setAttribute("aria-label", newer.dataset.tip);
    if (!active) {
      box.replaceChildren(historyNote("Chọn một máy để xem các phiên chat."));
      return;
    }
    if (!rows.length) {
      box.replaceChildren(historyNote(query ? "Không thấy phiên nào khớp." : "Chưa có phiên. Gửi tin hoặc bấm Phiên mới."));
      return;
    }
    for (const row of rows) {
      const open = document.createElement("button");
      open.type = "button";
      open.className = `history-open${row.session.id === openId ? " active" : ""}`;
      open.dataset.session = row.session.id;
      open.dataset.peer = row.session.peerId;
      if (row.matched) open.dataset.line = row.matched.id;
      const fresh = next.unreadSessions.includes(row.session.id);
      const title = document.createElement("strong");
      title.textContent = row.session.title;
      const heading = document.createElement("span");
      heading.className = "history-title";
      heading.append(title);
      if (fresh) heading.append(unreadMark(1));
      const when = new Date(row.session.updatedAt).toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
      const preview = shownMentionText(row.matched?.text || row.last?.text || "").replace(/\s+/g, " ").trim().slice(0, 90);
      const client = linkedClient(next, row.session);
      const live = hold?.sessionId === row.session.id;
      const facts = document.createElement("small");
      facts.textContent = [live ? "Agent đang chạy" : "", client, `${row.lines.length} dòng`, when].filter(Boolean).join(" · ");
      if (live) facts.className = "history-live";
      open.append(heading, facts);
      if (preview) {
        const peek = document.createElement("small");
        peek.className = "history-peek";
        peek.textContent = preview;
        open.append(peek);
      }
      const menu = document.createElement("div");
      menu.className = "history-menu";
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "icon-btn history-menu-btn";
      toggle.dataset.tip = "Tùy chọn phiên";
      toggle.setAttribute("aria-label", "Tùy chọn phiên");
      toggle.setAttribute("aria-haspopup", "menu");
      toggle.innerHTML = icon("more");
      const pop = document.createElement("div");
      pop.className = "history-menu-pop";
      pop.hidden = true;
      pop.setAttribute("role", "menu");
      const edit = document.createElement("button");
      edit.type = "button";
      edit.dataset.editSession = row.session.id;
      edit.dataset.peer = row.session.peerId;
      edit.setAttribute("role", "menuitem");
      edit.innerHTML = `${icon("pencil")}<span>Sửa tên</span>`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger";
      remove.dataset.deleteSession = row.session.id;
      remove.dataset.peer = row.session.peerId;
      remove.setAttribute("role", "menuitem");
      remove.innerHTML = `${icon("trash")}<span>${parseGroupKey(row.session.peerId) ? "Xóa hội thoại" : "Xóa phiên"}</span>`;
      pop.append(edit, remove);
      menu.append(toggle, pop);
      const item = document.createElement("div");
      item.className = `history-row${hold?.sessionId === row.session.id ? " agent-live" : ""}`;
      item.append(open, menu);
      box.append(item);
    }
  }

  must<HTMLInputElement>("#history-query").addEventListener("input", (event) => {
    historyQuery = (event.target as HTMLInputElement).value;
    if (!state) return;
    paintHistory(state);
    const sessionId = active ? state.openSession[active] : "";
    if (sessionId) paintMessages(messagesEl, state.transcripts[sessionId] ?? [], state.self.peerId, false, historyQuery);
  });
  must<HTMLInputElement>("#session-title").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    must<HTMLInputElement>("#session-title").blur();
  });
  must<HTMLInputElement>("#session-title").addEventListener("change", () => {
    const peerId = active;
    const title = must<HTMLInputElement>("#session-title").value;
    const groupId = peerId ? parseGroupKey(peerId) : null;
    if (groupId) {
      void guard(() => window.lan.renameGroup(groupId, title));
      return;
    }
    const sessionId = peerId ? state?.openSession[peerId] : "";
    if (!peerId || !sessionId) return;
    void guard(() => window.lan.renameSession(peerId, sessionId, title));
  });
  must<HTMLButtonElement>("#delete-chat").addEventListener("click", () => {
    if (!active || !state) return;
    const current = state;
    const peerId = active;
    const sessionId = current.openSession[peerId] || "";
    if (!sessionId) return;
    const groupId = parseGroupKey(peerId);
    const host = groupId ? current.groups.some((group) => group.id === groupId && group.hostId === current.self.peerId) : false;
    const message = deletePrompt(current, peerId, sessionId, Boolean(groupId), host);
    if (!window.confirm(message)) return;
    void guard(() => window.lan.deleteSession(peerId, sessionId));
  });
  must<HTMLButtonElement>("#delete-group").addEventListener("click", () => {
    const groupId = active ? parseGroupKey(active) : null;
    if (!groupId || !state) return;
    const current = state;
    const host = current.groups.some((group) => group.id === groupId && group.hostId === current.self.peerId);
    if (!window.confirm(host ? "Xóa nhóm này cho mọi máy?" : "Rời nhóm này?")) return;
    void guard(() => window.lan.leaveGroup(groupId));
  });
  must<HTMLElement>("#history-list").addEventListener("click", (event) => {
    const menuBtn = (event.target as HTMLElement).closest<HTMLButtonElement>(".history-menu-btn");
    if (menuBtn) {
      const pop = menuBtn.parentElement?.querySelector<HTMLElement>(".history-menu-pop");
      if (!pop) return;
      const willOpen = pop.hidden;
      closeHistoryMenus();
      if (willOpen) placeHistoryMenu(pop, menuBtn);
      return;
    }
    const remove = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-delete-session]");
    if (remove?.dataset.deleteSession && remove.dataset.peer) {
      closeHistoryMenus();
      const peerId = remove.dataset.peer;
      const sessionId = remove.dataset.deleteSession;
      const groupId = parseGroupKey(peerId);
      const current = state;
      const host = Boolean(groupId && current?.groups.some((group) => group.id === groupId && group.hostId === current.self.peerId));
      const message = current ? deletePrompt(current, peerId, sessionId, Boolean(groupId), host) : "Xóa phiên hội thoại này trên máy này?";
      if (!window.confirm(message)) return;
      void guard(() => window.lan.deleteSession(peerId, sessionId));
      return;
    }
    const edit = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-edit-session]");
    if (edit?.dataset.editSession && edit.dataset.peer) {
      closeHistoryMenus();
      const peerId = edit.dataset.peer;
      const sessionId = edit.dataset.editSession;
      if (parseGroupKey(peerId)) {
        const current = state?.sessions.find((item) => item.id === sessionId)?.title || "";
        const title = window.prompt("Tên phiên", current);
        if (title === null) return;
        void guard(() => window.lan.renameSession(peerId, sessionId, title));
        return;
      }
      active = peerId;
      void guard(async () => {
        const next = await window.lan.openSession(peerId, sessionId);
        paint(next);
        const input = must<HTMLInputElement>("#session-title");
        input.focus();
        input.select();
      });
      return;
    }
    const open = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-session]");
    if (!open?.dataset.session || !open.dataset.peer) return;
    const peerId = open.dataset.peer;
    const sessionId = open.dataset.session;
    active = peerId;
    focusLine = open.dataset.line || "";
    void guard(async () => {
      const next = await window.lan.openSession(peerId, sessionId);
      paint(next);
    });
  });
  must<HTMLButtonElement>("#new-session").addEventListener("click", () => {
    const peerId = active;
    if (!peerId) return;
    void guard(async () => {
      const next = await window.lan.createSession(peerId);
      paint(next);
    });
  });

  function displayName(next: AppState, peerId: string, real: string): string {
    if (peerId === next.self.peerId) return real;
    return next.nicknames?.[peerId]?.trim() || real;
  }

  function personName(peerId: string): string {
    if (!state) return "";
    const peer = state.peers.find((item) => item.peerId === peerId);
    if (peer) return peer.name;
    for (const group of state.groups) {
      const member = group.members.find((item) => item.peerId === peerId);
      if (member) return member.name;
    }
    return "";
  }

  function beginNickname(host: HTMLElement, peerId: string, current: string): void {
    if (host.querySelector("input.nick-edit")) return;
    const input = document.createElement("input");
    input.className = "nick-edit";
    input.maxLength = 40;
    input.value = current;
    input.placeholder = "Biệt danh";
    input.setAttribute("aria-label", "Biệt danh");
    const label = host.querySelector("strong") ?? host.querySelector(":scope > span");
    label?.replaceWith(input);
    input.focus();
    input.select();
    const finish = () => {
      if (!input.isConnected) return;
      input.replaceWith(label || document.createTextNode(""));
      void guard(() => window.lan.setNickname(peerId, input.value));
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        input.blur();
      } else if (event.key === "Escape") {
        input.value = current;
        input.blur();
      }
    });
    input.addEventListener("blur", finish);
  }

  function mentionChoices(): MentionRef[] {
    if (!state || !active) return [];
    const people = conversationPeople(state, active);
    const seen = new Set<string>();
    const base: MentionRef[] = [];
    const selfId = state.self.peerId;
    if (selfId) {
      base.push({ peerId: selfId, name: "me" });
      seen.add(selfId);
    }
    for (const person of people) {
      if (!person.peerId || seen.has(person.peerId)) continue;
      seen.add(person.peerId);
      const nick = (state.nicknames?.[person.peerId] || "").trim();
      const useNick = Boolean(nick) && nick.toLowerCase() !== "me" && nick.toLowerCase() !== person.name.toLowerCase();
      base.push({ peerId: person.peerId, name: useNick ? nick : person.name });
    }
    return base;
  }

  function currentMention(): { start: number; query: string } | null {
    const caret = draft.selectionStart ?? draft.value.length;
    const before = draft.value.slice(0, caret);
    const at = before.lastIndexOf("@");
    if (at < 0) return null;
    if (at > 0 && !/\s/.test(before[at - 1] || "")) return null;
    const query = before.slice(at + 1);
    if (query.includes("\n") || query.length > 40) return null;
    return { start: at, query };
  }

  function paintMentions(): void {
    const pop = must<HTMLElement>("#mention-pop");
    const token = currentMention();
    const matches = token
      ? mentionChoices().filter((person) => person.name.toLowerCase().startsWith(token.query.toLowerCase()))
      : [];
    if (!token || !matches.length) {
      pop.hidden = true;
      pop.replaceChildren();
      return;
    }
    if (mentionIndex >= matches.length) mentionIndex = 0;
    pop.hidden = false;
    pop.replaceChildren();
    const selfId = state?.self.peerId ?? "";
    const selfName = state?.self.name ?? "";
    matches.forEach((person, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = index === mentionIndex ? "active" : "";
      button.dataset.name = person.name;
      const label = document.createElement("span");
      label.textContent = `@${person.name}`;
      button.append(label);
      const mine = person.peerId === selfId && person.name.toLowerCase() === "me";
      const nick = (state?.nicknames?.[person.peerId] || "").trim();
      const named = personName(person.peerId);
      if (mine || (nick && person.name.toLowerCase() === nick.toLowerCase() && named && named.toLowerCase() !== nick.toLowerCase())) {
        const hint = document.createElement("small");
        hint.textContent = mine ? (selfName && selfName.toLowerCase() !== "me" ? `máy này · ${selfName}` : "máy này") : named;
        button.append(hint);
      }
      button.addEventListener("mousedown", (event) => {
        event.preventDefault();
        insertMention(person.name);
      });
      pop.append(button);
    });
  }

  function insertMention(name: string): void {
    const token = currentMention();
    if (!token) return;
    const caret = draft.selectionStart ?? draft.value.length;
    draft.value = `${draft.value.slice(0, token.start)}@${name} ${draft.value.slice(caret)}`;
    const pos = token.start + name.length + 2;
    draft.focus();
    draft.setSelectionRange(pos, pos);
    must<HTMLElement>("#mention-pop").hidden = true;
    noteTyping(true);
  }

  function flash(text: string): void {
    const toast = must<HTMLDivElement>("#toast");
    toast.hidden = false;
    toast.textContent = text;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toast.hidden = true;
    }, 3200);
  }

  function openNotice(notice: ChatNotice): void {
    active = notice.peerId;
    focusLine = "";
    void guard(async () => {
      const next = await window.lan.openSession(notice.peerId, notice.sessionId);
      if (next && typeof next === "object") paint(next as AppState);
    });
  }
}

function historyNote(text: string): HTMLElement {
  const note = document.createElement("p");
  note.className = "hint";
  note.textContent = text;
  return note;
}

function unreadFor(next: AppState, peerId: string): number {
  const ids = new Set(next.unreadSessions);
  return next.sessions.filter((session) => session.peerId === peerId && ids.has(session.id)).length;
}

function unreadMark(count: number): HTMLElement | string {
  if (count <= 0) return "";
  const mark = document.createElement("span");
  mark.className = "unread-count";
  mark.textContent = count > 9 ? "9+" : String(count);
  return mark;
}

function paintMessages(host: HTMLElement, lines: ChatLine[], selfId: string, stick: boolean, query = ""): void {
  const ids = new Set(lines.map((line) => line.id));
  for (const child of Array.from(host.children)) {
    if (!(child instanceof HTMLElement)) continue;
    const id = child.getAttribute("data-id");
    if (!id || !ids.has(id)) child.remove();
  }
  const byId = new Map<string, HTMLElement>();
  for (const child of Array.from(host.children)) {
    if (!(child instanceof HTMLElement)) continue;
    const id = child.getAttribute("data-id");
    if (id && !byId.has(id)) byId.set(id, child);
  }
  const previewScroll = new Map<string, number>();
  for (const [id, article] of byId) {
    const scroller = article.querySelector<HTMLElement>(":scope > .preview:not(.agent-md) .markdown, :scope > .preview:not(.agent-md) iframe");
    if (scroller && scroller.scrollTop > 0) previewScroll.set(id, scroller.scrollTop);
  }
  let changed = false;
  let previous: HTMLElement | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    let article = byId.get(line.id) ?? null;
    const text = line.text || (line.pending ? "…" : "");
    if (!article) {
      article = renderLine(line, selfId);
      article.dataset.id = line.id;
      changed = true;
    } else {
      const body = line.kind === "agent"
        ? article.querySelector<HTMLElement>(":scope > .preview .md-body")
        : article.querySelector<HTMLElement>(":scope > p:not(.attach-note)");
      if (line.kind === "agent" && body) {
        const shown = text === "…" ? text : shownMentionText(text);
        const key = `${text}\n${nickSignature()}\n${shown}`;
        if (body.dataset.source !== key) {
          body.dataset.source = key;
          body.innerHTML = agentHtml(shown);
          changed = true;
        }
      } else if (body) {
        const marked = plainHtml(line);
        if (body.dataset.source !== marked.key) {
          body.dataset.source = marked.key;
          body.innerHTML = marked.html;
          changed = true;
        }
      }
      body?.classList.toggle("pending", line.pending);
      article.classList.toggle("hit", Boolean(query.trim()) && line.text.toLowerCase().includes(query.trim().toLowerCase()));
    }
    article.classList.toggle("continued", continuesSender(lines[index - 1], line));
    syncCodingLog(article, line);
    const anchor: ChildNode | null = previous ? previous.nextSibling : host.firstChild;
    if (article !== anchor) host.insertBefore(article, anchor);
    previous = article;
  }
  for (const [id, top] of previewScroll) {
    const scroller = byId.get(id)?.querySelector<HTMLElement>(":scope > .preview:not(.agent-md) .markdown, :scope > .preview:not(.agent-md) iframe");
    if (scroller && scroller.scrollTop !== top) scroller.scrollTop = top;
  }
  if (changed && stick) host.scrollTop = host.scrollHeight;
}

function continuesSender(previous: ChatLine | undefined, line: ChatLine): boolean {
  if (!previous || previous.kind === "system" || line.kind === "system") return false;
  if (previous.fromPeerId !== line.fromPeerId || previous.kind !== line.kind) return false;
  const gap = line.createdAt - previous.createdAt;
  return gap >= 0 && gap <= 60_000;
}

function syncCodingLog(article: HTMLElement, line: ChatLine): void {
  const host = article.querySelector(":scope > .meta") ?? article;
  const current = article.querySelector<HTMLButtonElement>("button.coding-log");
  if (!line.codingLog) {
    current?.remove();
    return;
  }
  if (current?.dataset.path === line.codingLog) return;
  current?.remove();
  const button = document.createElement("button");
  button.type = "button";
  button.className = "coding-log";
  button.dataset.path = line.codingLog;
  button.dataset.tip = "Mở log coding";
  button.setAttribute("aria-label", "Mở log coding");
  button.innerHTML = icon("file");
  const filePath = line.codingLog;
  button.addEventListener("click", () => {
    const ref = fileRef(filePath);
    if (!ref) return;
    void window.lan.showPreview(ref);
  });
  host.append(button);
}

function renderLine(line: ChatLine, selfId: string): HTMLElement {
  const article = document.createElement("article");
  const mine = line.fromPeerId === selfId && line.kind !== "system";
  article.className = `line ${line.kind}${mine ? " mine" : ""}`;
  if (line.kind !== "system") {
    const meta = document.createElement("div");
    meta.className = "meta";
    const who = document.createElement("span");
    who.textContent = line.kind === "agent" ? `${line.fromName} · agent` : line.fromName;
    const time = document.createElement("time");
    time.dateTime = new Date(line.createdAt).toISOString();
    time.textContent = new Date(line.createdAt).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
    meta.append(who, time);
    article.append(meta);
  }
  if (line.kind === "agent") {
    const box = document.createElement("div");
    box.className = "preview preview-markdown agent-md";
    const body = document.createElement("article");
    body.className = "markdown md-body";
    const text = line.text || (line.pending ? "…" : "");
    const shown = text === "…" ? text : shownMentionText(text);
    body.dataset.source = `${text}\n${nickSignature()}\n${shown}`;
    body.innerHTML = agentHtml(shown);
    if (line.pending) body.classList.add("pending");
    box.append(body);
    article.append(box);
  } else {
    const body = document.createElement("p");
    const marked = plainHtml(line);
    body.dataset.source = marked.key;
    body.innerHTML = marked.html;
    if (line.pending) body.classList.add("pending");
    article.append(body);
  }
  if (line.attachment) {
    const note = document.createElement("p");
    note.className = "attach-note";
    note.textContent = `Đính kèm: ${line.attachment.name}`;
    article.append(note);
  }
  const attached = attachment(line);
  if (attached) article.append(renderPreview(attached));
  return article;
}

function plainHtml(line: ChatLine): { key: string; html: string } {
  const text = line.text || (line.pending ? "…" : "");
  const shown = line.kind === "system" || text === "…" ? text : shownMentionText(text);
  const html = line.kind === "system" || text === "…" ? escapeHtml(text) : mentionHtml(shown, mentionFaces);
  return { key: `${text}\n${nickSignature()}\n${shown}`, html };
}

function shownMentionText(text: string): string {
  if (!text) return text;
  return rewriteMentionLabels(text, mentionFaces, (hit) => {
    if (hit.peerId === mentionSelf) return hit.name;
    return mentionNicks[hit.peerId]?.trim() || hit.name;
  }).text;
}

function nickSignature(): string {
  return Object.entries(mentionNicks)
    .map(([id, name]) => `${id}:${name}`)
    .sort()
    .join("|");
}

function conversationPeople(state: AppState, peerKey: string): GroupMember[] {
  const group = state.groups.find((item) => groupKey(item.id) === peerKey);
  if (group) return group.members.slice();
  const people: GroupMember[] = [];
  if (state.self.peerId && state.self.name) people.push({ peerId: state.self.peerId, name: state.self.name });
  const peer = state.peers.find((item) => item.peerId === peerKey);
  if (peer) people.push({ peerId: peer.peerId, name: peer.name });
  return people;
}

function mentionFacesOf(state: AppState, peerKey: string): GroupMember[] {
  const faces: GroupMember[] = [];
  const add = (peerId: string, name: string) => {
    const clean = name.replace(/\s+/g, " ").trim();
    if (!peerId || !clean) return;
    if (faces.some((face) => face.peerId === peerId && face.name.toLowerCase() === clean.toLowerCase())) return;
    faces.push({ peerId, name: clean });
  };
  const people = conversationPeople(state, peerKey);
  add(state.self.peerId, state.self.name);
  add(state.self.peerId, "me");
  for (const person of people) add(person.peerId, person.name);
  const allowed = new Set(faces.map((face) => face.peerId));
  for (const [peerId, name] of Object.entries(state.nicknames)) {
    if (allowed.has(peerId)) add(peerId, name);
  }
  return faces;
}

function mentionHtml(text: string, mentions: MentionRef[] | undefined): string {
  const hits = mentionRanges(text, mentions ?? []);
  if (!hits.length) return escapeHtml(text);
  let html = "";
  let cursor = 0;
  for (const hit of hits) {
    html += escapeHtml(text.slice(cursor, hit.start));
    html += `<span class="at">${escapeHtml(text.slice(hit.start, hit.end))}</span>`;
    cursor = hit.end;
  }
  return html + escapeHtml(text.slice(cursor));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    if (char === "&") return "&amp;";
    if (char === "<") return "&lt;";
    if (char === ">") return "&gt;";
    if (char === '"') return "&quot;";
    return "&#39;";
  });
}

function agentHtml(text: string): string {
  if (!text || text === "…") return text === "…" ? "…" : "";
  return renderMarkdownHtml(text);
}

function kindLabel(kind: PreviewKind | null): string {
  if (kind === "image") return "ảnh";
  if (kind === "html") return "html";
  if (kind === "markdown") return "markdown";
  if (kind === "audio") return "âm thanh";
  if (kind === "video") return "video";
  return "file";
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function attachment(line: ChatLine): FileRef | null {
  if (line.file?.path && line.file.preview) return line.file;
  const saved = line.text.match(/Lưu tại\s+([A-Za-z]:\\.*)$/);
  return saved?.[1] ? fileRef(saved[1].trim()) : null;
}

function paintTools(report: CliReport | undefined): void {
  const box = document.querySelector<HTMLElement>("#tools");
  if (!box) return;
  box.replaceChildren();
  const tools = report ? [report.claude, report.cursor, report.codex, report.gemini] : [];
  if (!tools.length) {
    box.textContent = "Đang kiểm tra Claude CLI, Cursor CLI, Codex và Gemini…";
    return;
  }
  for (const tool of tools) {
    const row = document.createElement("div");
    row.className = "tool";
    const name = document.createElement("span");
    name.textContent = tool.label;
    const state = document.createElement("strong");
    state.className = tool.installed ? "ok" : "miss";
    state.textContent = toolStatus(tool);
    if (tool.path) state.title = tool.path;
    row.append(name, state);
    box.append(row);
  }
}

function toolStatus(tool: CliToolState): string {
  if (!tool.installed) return "Chưa có trên máy";
  if (tool.loggedIn === true) return "Đã cài · đã đăng nhập";
  if (tool.loggedIn === false) return "Đã cài · chưa đăng nhập";
  return "Đã cài";
}

function installedNote(report: CliReport | undefined): string {
  if (!report) return "";
  const names: string[] = [];
  if (report.claude.installed) names.push("Claude CLI");
  if (report.cursor.installed) names.push("Cursor CLI");
  if (report.codex.installed) names.push("Codex");
  if (report.gemini.installed) names.push("Gemini CLI");
  return names.length ? `có ${names.join(", ")}` : "";
}

function activityNote(activity: PeerActivity | undefined): string {
  if (activity?.replying) return "đang trả lời";
  if (activity?.typing) return "đang nhập";
  return "";
}

function activitySentence(name: string, activity: PeerActivity | undefined, sessionId: string): string {
  if (activity?.replying && activity.replyingSessionId === sessionId) return `${name} đang trả lời…`;
  if (activity?.typing && activity.typingSessionId === sessionId) return `${name} đang nhập…`;
  return "";
}

function peerCliNote(clis: string | undefined): string {
  const names = (clis ?? "")
    .split(",")
    .map((id) => (id === "claude" ? "Claude CLI" : id === "cursor" ? "Cursor CLI" : id === "codex" ? "Codex" : id === "gemini" ? "Gemini CLI" : ""))
    .filter(Boolean);
  return names.length ? `có ${names.join(", ")}` : "";
}

function linkedClient(state: AppState, session: { cli?: AppState["sessions"][number]["cli"] } | undefined): string {
  const provider = state.self.provider;
  if (!session || provider === "echo") return "";
  const link = session.cli?.[provider];
  if (!link?.id) return "";
  return cliClientLabel(provider);
}

function sessionLinkNote(state: AppState, session: { cli?: AppState["sessions"][number]["cli"] } | undefined): string {
  const client = linkedClient(state, session);
  return client ? `cùng phiên ${client}` : "";
}

function deletePrompt(state: AppState, peerId: string, sessionId: string, group: boolean, host: boolean): string {
  const session = state.sessions.find((item) => item.id === sessionId && item.peerId === peerId);
  const linked = Boolean(linkedClient(state, session));
  if (group) {
    const count = state.sessions.filter((item) => item.peerId === peerId).length;
    const base = count > 1 ? "Xóa phiên này cho cả nhóm?" : host ? "Xóa hội thoại của cả nhóm?" : "Xóa hội thoại nhóm trên máy này?";
    return linked ? `${base} Phiên trong client vẫn giữ để bạn mở lại.` : base;
  }
  return linked ? "Xóa phiên này trong LAN Agents? Phiên trong client vẫn giữ để bạn mở lại." : "Xóa phiên hội thoại này trên máy này?";
}

function statusText(peer: PeerView): string {
  if (peer.status === "connected") return "đã nối";
  if (peer.status === "pending-in") return "chờ chấp nhận";
  if (peer.status === "pending-out") return "đang chờ";
  if (peer.status === "connecting") return "đang nối";
  if (peer.discovered) return "đang online";
  return "ngoại tuyến";
}

function cssEscape(value: string): string {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value.replace(/"/g, "");
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function nearBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 90;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : "Có lỗi";
}

function buildAccessDialog(host: HTMLElement): void {
  const pop = document.createElement("div");
  pop.id = "access-pop";
  pop.className = "access-pop";
  pop.hidden = true;
  const card = document.createElement("div");
  card.className = "access-card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-labelledby", "access-title");
  const header = document.createElement("header");
  const title = document.createElement("strong");
  title.id = "access-title";
  title.textContent = "Khả năng truy cập của agent khác";
  const close = document.createElement("button");
  close.id = "access-close";
  close.type = "button";
  close.className = "icon-btn";
  close.dataset.tip = "Đóng";
  close.setAttribute("aria-label", "Đóng");
  close.innerHTML = icon("x");
  header.append(title, close);
  const hint = document.createElement("p");
  hint.className = "hint access-hint";
  hint.textContent = "Agent máy khác chỉ làm được các mục đang bật. Mục tắt sẽ bị từ chối.";
  const list = document.createElement("div");
  list.className = "access-list";
  for (const level of ACCESS_LEVELS) {
    const heading = document.createElement("h3");
    heading.className = "access-level";
    heading.textContent = level.title;
    list.append(heading);
    for (const role of ACCESS_ROLES.filter((item) => item.level === level.level)) {
      const row = document.createElement("label");
      row.className = "access-row";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.dataset.access = role.id;
      const name = document.createElement("span");
      name.textContent = role.title;
      const info = document.createElement("button");
      info.type = "button";
      info.className = "icon-btn access-info";
      info.dataset.tip = role.detail;
      info.dataset.wide = "1";
      info.setAttribute("aria-label", `Chi tiết ${role.title}`);
      info.innerHTML = icon("info");
      info.addEventListener("pointerdown", (event) => event.stopPropagation());
      info.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      row.append(input, name, info);
      list.append(row);
    }
  }
  const row = document.createElement("div");
  row.className = "save-row access-save";
  const save = document.createElement("button");
  save.id = "access-save";
  save.type = "button";
  save.className = "icon-btn primary";
  save.dataset.tip = "Lưu khả năng truy cập";
  save.setAttribute("aria-label", "Lưu khả năng truy cập");
  save.innerHTML = icon("check");
  row.append(save);
  card.append(header, hint, list, row);
  pop.append(card);
  host.append(pop);
}

function icon(name: string): string {
  return `<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

function iconButton(id: string, name: string, tip: string, nav = "", extra = "", type = "button", className = "icon-btn"): string {
  const idAttr = id ? ` id="${id}"` : "";
  const navAttr = nav ? ` data-nav="${nav}"` : "";
  return `<button${idAttr} type="${type}" class="${className}" data-tip="${tip}" aria-label="${tip}"${navAttr}>${icon(name)}${extra}</button>`;
}

function setIcon(button: HTMLElement, name: string, tip: string): void {
  button.querySelector("use")?.setAttribute("href", `#i-${name}`);
  button.dataset.tip = tip;
  button.setAttribute("aria-label", tip);
}

function bindTips(host: HTMLElement): void {
  const tip = must<HTMLDivElement>("#tip");
  const place = (el: HTMLElement) => {
    const text = el.dataset.tip;
    if (!text) return;
    tip.textContent = text;
    tip.classList.toggle("wide", el.dataset.wide === "1");
    tip.hidden = false;
    const rect = el.getBoundingClientRect();
    const box = tip.getBoundingClientRect();
    const pad = 8;
    let left = rect.left + rect.width / 2 - box.width / 2;
    let top = rect.bottom + 6;
    if (rect.left < 90) {
      left = rect.right + 8;
      top = rect.top + rect.height / 2 - box.height / 2;
    } else if (top + box.height > window.innerHeight - pad) {
      top = rect.top - box.height - 6;
    }
    tip.style.left = `${Math.max(pad, Math.min(left, window.innerWidth - box.width - pad))}px`;
    tip.style.top = `${Math.max(pad, top)}px`;
  };
  host.addEventListener("mouseover", (event) => {
    const el = (event.target as HTMLElement).closest<HTMLElement>("[data-tip]");
    if (el) place(el);
  });
  host.addEventListener("mouseout", (event) => {
    const el = (event.target as HTMLElement).closest<HTMLElement>("[data-tip]");
    if (!el) return;
    const next = event.relatedTarget;
    if (next instanceof Node && el.contains(next)) return;
    tip.hidden = true;
  });
  host.addEventListener("pointerdown", () => {
    tip.hidden = true;
  });
  window.addEventListener("scroll", () => {
    tip.hidden = true;
  }, true);
}

function iconSprite(): string {
  const stroke = `fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"`;
  const item = (id: string, body: string) => `<symbol id="i-${id}" viewBox="0 0 24 24"><g ${stroke}>${body}</g></symbol>`;
  return `<svg class="sprite" aria-hidden="true">${[
    item("sidebar", `<rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M9 4v16"/>`),
    item("people", `<circle cx="9" cy="8" r="2.2"/><path d="M4.8 18c.5-2.3 2.2-3.5 4.2-3.5s3.7 1.2 4.2 3.5"/><circle cx="16.2" cy="9" r="1.7"/><path d="M14.2 14.8c1.1-.4 2.2-.5 3.2-.2 1.3.4 2.2 1.4 2.6 2.9"/>`),
    item("bubble", `<path d="M5 16.2V7.8A2.3 2.3 0 0 1 7.3 5.5h9.4A2.3 2.3 0 0 1 19 7.8v5.6a2.3 2.3 0 0 1-2.3 2.3H9.2L5 18.5z"/>`),
    item("folder", `<path d="M3.5 8.2V7A1.5 1.5 0 0 1 5 5.5h3.8l1.6 1.6H19A1.5 1.5 0 0 1 20.5 8.6v8A1.5 1.5 0 0 1 19 18.1H5A1.5 1.5 0 0 1 3.5 16.6z"/>`),
    item("gear", `<path d="M4 8h11M15 8a2 2 0 1 0 4 0 2 2 0 0 0-4 0zM20 16H9M9 16a2 2 0 1 0-4 0 2 2 0 0 0 4 0z"/>`),
    item("sliders", `<path d="M4 8h16M4 16h16"/><circle cx="9" cy="8" r="2.1"/><circle cx="15" cy="16" r="2.1"/>`),
    item("list", `<path d="M9 7h10M9 12h10M9 17h10"/><circle cx="5" cy="7" r="0.8"/><circle cx="5" cy="12" r="0.8"/><circle cx="5" cy="17" r="0.8"/>`),
    item("plus", `<path d="M12 5v14M5 12h14"/>`),
    item("search", `<circle cx="11" cy="11" r="5.5"/><path d="M15.5 15.5L20 20"/>`),
    item("link", `<path d="M9 16H7.5a4 4 0 0 1 0-8H9"/><path d="M15 8h1.5a4 4 0 0 1 0 8H15"/><path d="M8 12h8"/>`),
    item("unlink", `<path d="M9 16H7.5a4 4 0 0 1 0-8H9"/><path d="M15 8h1.5a4 4 0 0 1 0 8H15"/><path d="M8 12h3M13 12h3"/><path d="M5 5l14 14"/>`),
    item("check", `<path d="M5 12.5l4.2 4.2L19 7"/>`),
    item("x", `<path d="M7 7l10 10M17 7L7 17"/>`),
    item("paperclip", `<path d="M8.2 12.6V7.4a2.4 2.4 0 0 1 4.8 0v8.6a3.6 3.6 0 0 1-7.2 0V8.6"/>`),
    item("file", `<path d="M7 3.8h6.2L19 9.2v11H7z"/><path d="M13.2 3.8V9.2H19"/>`),
    item("eye", `<path d="M2.8 12S6.2 6.8 12 6.8 21.2 12 21.2 12 17.8 17.2 12 17.2 2.8 12 2.8 12z"/><circle cx="12" cy="12" r="2.2"/>`),
    item("send", `<path d="M12 19V6M7 11l5-5 5 5"/>`),
    item("dialogue", `<path d="M3.8 14.2V8A1.8 1.8 0 0 1 5.6 6.2h7A1.8 1.8 0 0 1 14.4 8v4a1.8 1.8 0 0 1-1.8 1.8H7.2z"/><path d="M10.2 16.2v.6A1.7 1.7 0 0 0 11.9 18.5h5.2l2.6 2v-6.2"/>`),
    item("stop", `<rect x="7" y="7" width="10" height="10" rx="1.6"/>`),
    item("pencil", `<path d="M13.2 6.4l4.4 4.4L8 20.4H3.6V16z"/><path d="M11.6 8l4.4 4.4"/>`),
    item("refresh", `<path d="M19 12a7 7 0 1 1-2.1-4.9"/><path d="M19 4.6V9h-4.4"/>`),
    item("copy", `<rect x="8" y="8" width="10" height="11.5" rx="1.5"/><path d="M6 16H5.5A1.5 1.5 0 0 1 4 14.5v-9A1.5 1.5 0 0 1 5.5 4H14"/>`),
    item("layers", `<path d="M12 4.5l8 3.5-8 3.5-8-3.5z"/><path d="M4 12l8 3.5L20 12"/><path d="M4 16l8 3.5L20 16"/>`),
    item("fresh", `<path d="M5 6.5h14v4H5z"/><path d="M5 14.5h14v4H5z"/><path d="M12 10.5v3"/>`),
    item("hash", `<path d="M9 4.5L7.5 19.5M16.5 4.5L15 19.5M5 9h14M4.5 15h14"/>`),
    item("terminal", `<path d="M5 8l4 4-4 4M12 16h7"/>`),
    item("expand", `<path d="M9 4H4v5M15 4h5v5M20 15v5h-5M4 15v5h5"/>`),
    item("trash", `<path d="M5 7.5h14"/><path d="M9.2 7.4V5.6h5.6v1.8"/><path d="M7.4 7.5l.6 11.2h8l.6-11.2"/>`),
    item("info", `<circle cx="12" cy="12" r="8"/><path d="M12 11.2v5"/><path d="M12 8h.01"/>`),
    item("more", `<circle cx="6" cy="12" r="1.15" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.15" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.15" fill="currentColor" stroke="none"/>`),
  ].join("")}</svg>`;
}

function must<T extends HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Thiếu ${selector}`);
  return node;
}
