import { BRIEF_FILE_MAX, BRIEF_TURN_MAX, resultText, type BriefFile, type ProjectBrief } from "../shared/brief";
import type { AppState, ChatLine, CliReport, CliToolState, FileRef, PeerActivity, PeerView, Settings, WorkFile } from "../shared/types";
import { providerLabel } from "../shared/types";
import { fileRef, type PreviewKind } from "../shared/preview";
import { renderMarkdownHtml, renderPreview } from "./previewView";

declare global {
  interface Window {
    lan: {
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
      saveBrief: (peerId: string, patch: { topic: string; goal: string; turnLimit: number }) => Promise<AppState>;
      pickBriefFiles: () => Promise<string[]>;
      addBriefFiles: (peerId: string, paths: string[]) => Promise<AppState>;
      removeBriefFile: (peerId: string, name: string) => Promise<AppState>;
      startBrief: (peerId: string) => Promise<AppState>;
      extendBrief: (peerId: string, extra?: number) => Promise<AppState>;
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
      listWorkFiles: (dir: string) => Promise<{ found: boolean; files: WorkFile[] }>;
      onState: (listener: (state: AppState) => void) => () => void;
      onPreviewFile: (listener: (file: FileRef) => void) => () => void;
    };
  }
}

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
        ${iconButton("", "bubble", "Phiên chat", "sessions", `<span id="nav-unread" class="badge" hidden></span>`)}
        ${iconButton("", "folder", "Thư mục làm việc", "files")}
        <span class="spacer"></span>
        ${iconButton("", "gear", "Cài đặt", "settings")}
        ${iconButton("", "list", "Nhật ký", "logs")}
      </nav>
      <aside class="panel" id="panel">
        <div class="panel-head">
          <strong id="self-name"></strong>
          <span id="self-meta"></span>
        </div>
        <h2 id="pane-title" class="pane-title">Máy trong LAN</h2>
        <div class="panel-body" data-pane="peers">
          <div id="peers" class="peers"></div>
          <p id="peers-empty" class="hint">Đang dò máy trong LAN và các cổng 3940–3969.</p>
          <form id="manual" class="manual">
            <input id="manual-host" placeholder="IP hoặc tên máy" autocomplete="off" data-tip="Địa chỉ máy kia" aria-label="Địa chỉ máy kia" />
            <input id="manual-port" inputmode="numeric" value="3940" data-tip="Cổng" aria-label="Cổng" />
            ${iconButton("", "link", "Nối tới địa chỉ này", "", "", "submit")}
          </form>
        </div>
        <div class="panel-body" data-pane="sessions" hidden>
          <div class="search">
            ${icon("search")}
            <input id="history-query" placeholder="Tìm trong các phiên" autocomplete="off" aria-label="Tìm trong các phiên" />
          </div>
          <div id="history-list" class="history-list"></div>
          <div class="pane-tools">${iconButton("new-session", "plus", "Phiên mới với máy đang chọn")}</div>
        </div>
        <div class="panel-body" data-pane="files" hidden>
          <label class="cwd">Thư mục làm việc
            <span>
              <input id="set-cwd" spellcheck="false" data-tip="Thư mục agent đọc và ghi file" aria-label="Thư mục làm việc" />
              ${iconButton("pick-cwd", "folder", "Chọn thư mục")}
            </span>
          </label>
          <div id="workdir-files" class="workdir-files"></div>
        </div>
        <div class="panel-body" data-pane="settings" hidden>
          <label>Tên máy này<input id="set-name" maxlength="40" /></label>
          <label>Runtime
            <select id="set-provider">
              <option value="echo">Echo — thử kênh, không cần đăng nhập</option>
              <option value="claude-cli">Claude terminal — lệnh claude đã login</option>
              <option value="cursor-cli">Cursor terminal — lệnh agent đã login</option>
            </select>
          </label>
          <label>Lệnh Claude<input id="set-claude-command" spellcheck="false" /></label>
          <label>Lệnh Cursor<input id="set-cursor-command" spellcheck="false" /></label>
          <label class="check"><input id="set-auto" type="checkbox" /> Tự chấp nhận máy trong LAN</label>
          <div id="tools" class="tools"></div>
          <p class="hint">Không dùng API key. File đi qua app, không cần share Windows. Lệnh cursor của Cursor IDE không được tính là Cursor CLI.</p>
          <div class="save-row">
            ${iconButton("save", "check", "Lưu cài đặt", "", "", "button", "icon-btn primary")}
            ${iconButton("rescan", "refresh", "Kiểm tra lại CLI")}
            <span id="saved"></span>
          </div>
        </div>
        <div class="panel-body" data-pane="logs" hidden>
          <pre id="logs" class="logs" aria-live="polite"></pre>
        </div>
      </aside>
      <section class="chat">
        <div id="chat-empty" class="empty">
          <h2>Chưa chọn máy</h2>
          <p>Mở app trên máy thứ hai trong cùng LAN. Máy đó hiện ở mục Máy trong LAN.</p>
        </div>
        <div id="chat-panel" class="chat-panel" hidden>
          <header class="chat-head">
            <div class="chat-id">
              <h2 id="chat-title"></h2>
              <input id="session-title" maxlength="42" spellcheck="false" placeholder="Tên phiên" data-tip="Tên phiên. Enter để lưu." aria-label="Tên phiên" />
              <p id="chat-status"></p>
            </div>
            ${iconButton("link", "link", "Kết nối")}
          </header>
          <div id="banner" class="banner" hidden>
            <span id="banner-text"></span>
            <span>
              ${iconButton("accept", "check", "Chấp nhận", "", "", "button", "icon-btn ok")}
              ${iconButton("reject", "x", "Từ chối")}
            </span>
          </div>
          <div id="messages" class="messages"></div>
          <p id="typing" class="typing" hidden></p>
          <section id="brief" class="brief">
            <div class="brief-bar">
              ${iconButton("brief-toggle", "sliders", "Cài đặt chủ đề")}
              <button id="brief-summary" type="button" class="brief-summary empty">Chưa đặt chủ đề</button>
              <span id="brief-meter" class="brief-meter"></span>
            </div>
            <button id="brief-result" type="button" class="brief-result" hidden><span></span></button>
            <div id="brief-pop" class="brief-pop" hidden>
              <div class="brief-pop-head">
                <strong>Hồ sơ dự án</strong>
                ${iconButton("brief-close", "x", "Đóng cài đặt chủ đề")}
              </div>
              <label>Chủ đề
                <input id="brief-topic" maxlength="500" placeholder="Việc hai agent cần bàn" aria-label="Chủ đề dự án" />
              </label>
              <label>Kết quả mong muốn
                <textarea id="brief-goal" rows="12" maxlength="2000" placeholder="Dạng kết quả cần chốt" aria-label="Kết quả mong muốn"></textarea>
              </label>
              <div id="brief-files" class="brief-files"></div>
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
            <textarea id="draft" rows="3" placeholder="Nhắn cho agent máy kia…"></textarea>
            <div id="attach-chip" class="attach-chip" hidden>
              ${icon("paperclip")}
              <span id="attach-name"></span>
              ${iconButton("attach-clear", "x", "Bỏ file đính kèm")}
            </div>
            <div class="composer-actions">
              ${iconButton("attach", "paperclip", "Đính kèm txt, Markdown, ảnh, PDF, Word hoặc Excel")}
              ${iconButton("send-file", "file", "Gửi file sang máy kia")}
              ${iconButton("open-preview", "eye", "Mở cửa sổ xem file")}
              <span class="spacer"></span>
              ${iconButton("stop", "stop", "Dừng agent đang trả lời")}
              ${iconButton("send", "send", "Gửi", "", "", "submit", "icon-btn primary")}
            </div>
          </form>
          <details class="http">
            <summary>${icon("terminal")} Lệnh HTTP</summary>
            <pre id="http-snippet"></pre>
            ${iconButton("copy-http", "copy", "Chép lệnh")}
          </details>
        </div>
      </section>
    </div>
    <div id="tip" class="tip" hidden></div>
    <div id="toast" class="toast" hidden></div>
  `;

  const navIds = ["peers", "sessions", "files", "settings", "logs"] as const;
  type NavId = (typeof navIds)[number];
  const navTitles: Record<NavId, string> = {
    peers: "Máy trong LAN",
    sessions: "Phiên chat",
    files: "Thư mục làm việc",
    settings: "Cài đặt",
    logs: "Nhật ký",
  };
  let nav: NavId = navIds.includes(localStorage.getItem("lan-nav") as NavId) ? (localStorage.getItem("lan-nav") as NavId) : "peers";
  let navOpen = localStorage.getItem("lan-nav-open") !== "0";

  function applyNav(): void {
    document.body.dataset.collapsed = navOpen ? "0" : "1";
    for (const pane of Array.from(document.querySelectorAll<HTMLElement>("[data-pane]"))) {
      pane.hidden = pane.dataset.pane !== nav;
    }
    for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>("[data-nav]"))) {
      button.classList.toggle("active", button.dataset.nav === nav);
    }
    must<HTMLElement>("#pane-title").textContent = navTitles[nav];
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
  let lastFiles: WorkFile[] = [];
  let selectedFile = "";
  let filesTimer = 0;
  let filesKey = "";

  let historyQuery = "";
  let focusLine = "";

  peersEl.addEventListener("click", (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-peer]");
    if (!row?.dataset.peer) return;
    active = row.dataset.peer;
    if (state) paint(state);
  });

  must<HTMLFormElement>("#manual").addEventListener("submit", (event) => {
    event.preventDefault();
    const hostInput = must<HTMLInputElement>("#manual-host").value.trim();
    const port = Number(must<HTMLInputElement>("#manual-port").value);
    void guard(() => window.lan.connectAddress(hostInput, port));
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
      lastFiles = [];
      filesKey = "";
      box.textContent = "Chưa chọn thư mục.";
      return;
    }
    try {
      const listed = await window.lan.listWorkFiles(dir);
      if (must<HTMLInputElement>("#set-cwd").value.trim() !== dir) return;
      if (!listed.found) {
        lastFiles = [];
        filesKey = "";
        box.textContent = "Không thấy thư mục này.";
        return;
      }
      lastFiles = listed.files;
      paintFileList(listed.files);
    } catch (err) {
      box.textContent = messageOf(err);
    }
  }

  function paintFileList(files: WorkFile[]): void {
    const box = must<HTMLElement>("#workdir-files");
    const key = files.map((file) => `${file.path}:${file.size}`).join("|");
    if (key === filesKey && box.querySelector("[data-file]")) {
      for (const button of Array.from(box.querySelectorAll<HTMLButtonElement>("[data-file]"))) {
        button.classList.toggle("active", button.dataset.file === selectedFile);
      }
      return;
    }
    filesKey = key;
    box.replaceChildren();
    if (!files.length) {
      box.textContent = "Thư mục chưa có file.";
      return;
    }
    for (const file of files) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `workdir-file${file.path === selectedFile ? " active" : ""}`;
      button.dataset.file = file.path;
      button.dataset.name = file.name;
      button.dataset.preview = file.preview ?? "";
      button.dataset.tip = file.preview ? `Xem ${file.name}` : `${file.name} — chưa xem trước được`;
      button.setAttribute("aria-label", file.name);
      const name = document.createElement("span");
      name.textContent = file.name;
      const meta = document.createElement("small");
      meta.textContent = `${kindLabel(file.preview)} · ${formatFileSize(file.size)}`;
      button.append(name, meta);
      box.append(button);
    }
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
    const kind = button.dataset.preview;
    if (kind !== "image" && kind !== "html" && kind !== "markdown" && kind !== "audio" && kind !== "video") {
      flash("Loại file này chưa xem trước được.");
      return;
    }
    selectedFile = button.dataset.file;
    paintFileList(lastFiles);
    showDock({ name: button.dataset.name || button.dataset.file, path: button.dataset.file, preview: kind });
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
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendDraft();
    }
  });
  draft.addEventListener("input", () => noteTyping(true));
  must<HTMLButtonElement>("#brief-add").addEventListener("click", () => {
    if (!active) return;
    const peerId = active;
    void guard(async () => {
      const paths = await window.lan.pickBriefFiles();
      if (!paths.length) return;
      await window.lan.addBriefFiles(peerId, paths);
    });
  });
  must<HTMLButtonElement>("#brief-toggle").addEventListener("click", () => setBriefOpen(must<HTMLElement>("#brief-pop").hidden));
  must<HTMLButtonElement>("#brief-summary").addEventListener("click", () => setBriefOpen(must<HTMLElement>("#brief-pop").hidden));
  must<HTMLButtonElement>("#brief-close").addEventListener("click", () => setBriefOpen(false));
  must<HTMLButtonElement>("#brief-result").addEventListener("click", () => {
    must<HTMLElement>("#brief-result").classList.toggle("open");
  });
  document.addEventListener("pointerdown", (event) => {
    const pop = must<HTMLElement>("#brief-pop");
    if (pop.hidden) return;
    const target = event.target;
    if (target instanceof Node && must<HTMLElement>("#brief").contains(target)) return;
    setBriefOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setBriefOpen(false);
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
      const add = Number.isFinite(extra) ? Math.max(1, Math.min(BRIEF_TURN_MAX, extra)) : 4;
      await window.lan.extendBrief(peerId, add);
    });
  });
  for (const id of ["#brief-topic", "#brief-goal", "#brief-turns"]) {
    must<HTMLElement>(id).addEventListener("input", () => scheduleBriefSave());
  }
  must<HTMLButtonElement>("#stop").addEventListener("click", () => {
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

  window.lan.onState((next) => paint(next));
  void window.lan.getState().then(paint).catch((err: unknown) => flash(messageOf(err)));

  function paint(next: AppState): void {
    state = next;
    if (!active || !next.peers.some((peer) => peer.peerId === active)) {
      active = next.peers.find((peer) => peer.status === "pending-in")?.peerId ?? next.peers[0]?.peerId ?? null;
    }
    must<HTMLElement>("#self-name").textContent = next.self.name;
    const localNote = installedNote(next.localClis);
    const meta = must<HTMLElement>("#self-meta");
    const fullMeta = [providerLabel(next.self.provider), `${next.self.host}:${next.self.port}`, shortId(next.self.peerId), localNote].filter(Boolean).join(" · ");
    meta.textContent = `${providerLabel(next.self.provider)} · ${next.self.host}:${next.self.port}`;
    meta.dataset.tip = fullMeta;
    must<HTMLElement>("#nav-unread").hidden = next.unreadSessions.length === 0;
    fillSettings(next.settings);
    paintTools(next.localClis);
    paintPeers(next);
    paintHistory(next);
    paintChat(next);
    must<HTMLPreElement>("#logs").textContent = next.logs.slice(-14).join("\n");
  }

  function paintPeers(next: AppState): void {
    peersEl.replaceChildren();
    must<HTMLElement>("#peers-empty").hidden = next.peers.length > 0;
    for (const peer of next.peers) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.peer = peer.peerId;
      button.className = `peer${peer.peerId === active ? " active" : ""}`;
      const dot = document.createElement("i");
      dot.className = `dot ${peer.status === "none" && peer.discovered ? "online" : peer.status}`;
      const who = document.createElement("span");
      who.className = "who";
      const title = document.createElement("strong");
      title.textContent = peer.name;
      const meta = document.createElement("span");
      const where = peer.viaLocalhost ? "cùng máy" : peer.host || "chưa có IP";
      meta.textContent = [providerLabel(peer.provider), where, peerCliNote(peer.clis), activityNote(next.activity[peer.peerId]), statusText(peer)].filter(Boolean).join(" · ");
      who.append(title, meta);
      button.append(dot, who);
      peersEl.append(button);
    }
  }

  function paintChat(next: AppState): void {
    const peer = next.peers.find((item) => item.peerId === active) ?? null;
    const empty = must<HTMLElement>("#chat-empty");
    const panel = must<HTMLElement>("#chat-panel");
    empty.hidden = Boolean(peer);
    panel.hidden = !peer;
    if (!peer || !active) return;
    must<HTMLElement>("#chat-title").textContent = peer.name;
    const where = peer.viaLocalhost ? "cùng máy" : `${peer.host}:${peer.port}`;
    const sessionId = next.openSession[active] ?? "";
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
    must<HTMLElement>("#chat-status").textContent = [session?.title, providerLabel(peer.provider), where, peerCliNote(peer.clis), statusText(peer)]
      .filter(Boolean)
      .join(" · ");
    paintMessages(messagesEl, lines, next.self.peerId, nearBottom(messagesEl), historyQuery);
    if (focusLine) {
      const hit = messagesEl.querySelector<HTMLElement>(`[data-id="${cssEscape(focusLine)}"]`);
      focusLine = "";
      hit?.scrollIntoView({ block: "center" });
    }
    const canSend = connected || Boolean(peer.token);
    must<HTMLButtonElement>("#send").disabled = !canSend;
    must<HTMLButtonElement>("#send-file").disabled = !canSend;
    const replyingSomewhere = next.sessions
      .filter((item) => item.peerId === active)
      .some((item) => (next.transcripts[item.id] ?? []).some((line) => line.pending));
    must<HTMLButtonElement>("#stop").disabled = !replyingSomewhere;
    paintBrief(sessionId, next.briefs[sessionId], lines, connected);
    const snippet = peer.token
      ? [
          `curl -X POST http://${peer.host}:${peer.port}/trigger`,
          `  -H "Authorization: Bearer ${peer.token}"`,
          `  -H "Content-Type: application/json"`,
          `  -d "{\\"text\\":\\"Xin chào từ máy khác\\"}"`,
        ].join("\n")
      : "Nối máy trước. Token ghép nối xuất hiện sau khi hai bên chấp nhận.";
    must<HTMLPreElement>("#http-snippet").textContent = snippet;
  }

  let briefTimer = 0;
  let briefFilesKey = "";
  let briefAnchor = "";

  function setBriefOpen(open: boolean): void {
    const pop = must<HTMLElement>("#brief-pop");
    const toggle = must<HTMLButtonElement>("#brief-toggle");
    pop.hidden = !open;
    toggle.classList.toggle("active", open);
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    must<HTMLButtonElement>("#brief-summary").setAttribute("aria-expanded", open ? "true" : "false");
  }

  function paintBrief(sessionId: string, brief: ProjectBrief | undefined, lines: ChatLine[], connected: boolean): void {
    const current: ProjectBrief = brief ?? { topic: "", goal: "", turnLimit: 6, turnsUsed: 0, running: false, files: [] };
    const topic = must<HTMLInputElement>("#brief-topic");
    const goal = must<HTMLTextAreaElement>("#brief-goal");
    const turns = must<HTMLInputElement>("#brief-turns");
    setIfIdle(topic, current.topic);
    setIfIdle(goal, current.goal);
    setIfIdle(turns, String(current.turnLimit));
    topic.disabled = current.running;
    goal.disabled = current.running;
    turns.disabled = current.running;
    must<HTMLButtonElement>("#brief-add").disabled = current.running || current.files.length >= BRIEF_FILE_MAX;
    must<HTMLButtonElement>("#brief-start").disabled = !connected || current.running;
    must<HTMLButtonElement>("#brief-extend").disabled = !connected || (!current.running && current.turnsUsed === 0);
    const anchor = `${active ?? ""}:${sessionId}`;
    if (briefAnchor && briefAnchor !== anchor) setBriefOpen(false);
    briefAnchor = anchor;
    const summary = must<HTMLButtonElement>("#brief-summary");
    const title = current.topic.trim();
    summary.textContent = title || "Chưa đặt chủ đề";
    summary.classList.toggle("empty", !title);
    summary.title = title;
    const fileNote = current.files.length ? ` · ${current.files.length} file` : "";
    must<HTMLElement>("#brief-meter").textContent = `${briefMeter(current)}${fileNote}`;
    paintBriefFiles(sessionId, current.files, current.running);
    const result = latestResult(lines);
    const box = must<HTMLButtonElement>("#brief-result");
    const resultTextNode = box.querySelector("span");
    if (!result) {
      box.hidden = true;
      if (resultTextNode) resultTextNode.textContent = "";
      box.classList.remove("open");
      delete box.dataset.full;
    } else {
      box.hidden = false;
      if (box.dataset.full !== result) {
        box.dataset.full = result;
        if (resultTextNode) resultTextNode.textContent = result;
        box.classList.remove("open");
      }
    }
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
      const name = document.createElement("span");
      name.textContent = file.name;
      name.title = file.kind;
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

  function briefMeter(brief: ProjectBrief): string {
    if (brief.running) return `Đang nói ${brief.turnsUsed}/${brief.turnLimit}`;
    if (brief.turnsUsed > 0 && brief.turnsUsed >= brief.turnLimit) return `Hết ${brief.turnsUsed}/${brief.turnLimit} lượt`;
    if (brief.turnsUsed > 0) return `Đã nói ${brief.turnsUsed}/${brief.turnLimit}`;
    return `${brief.turnLimit} lượt`;
  }

  function latestResult(lines: ChatLine[]): string {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (line.kind !== "agent" || line.pending) continue;
      const found = resultText(line.text);
      if (found) return found;
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
    const turns = Number(must<HTMLInputElement>("#brief-turns").value);
    await window.lan.saveBrief(peerId, {
      topic: must<HTMLInputElement>("#brief-topic").value,
      goal: must<HTMLTextAreaElement>("#brief-goal").value,
      turnLimit: Number.isFinite(turns) ? Math.max(1, Math.min(BRIEF_TURN_MAX, Math.round(turns))) : 6,
    });
  }

  function fillSettings(settings: Settings): void {
    if (settingsReady) return;
    must<HTMLInputElement>("#set-name").value = settings.name;
    must<HTMLSelectElement>("#set-provider").value = settings.provider;
    must<HTMLInputElement>("#set-claude-command").value = settings.claudeCommand;
    must<HTMLInputElement>("#set-cursor-command").value = settings.cursorCommand;
    must<HTMLInputElement>("#set-cwd").value = settings.workDir;
    must<HTMLInputElement>("#set-auto").checked = settings.autoAccept;
    settingsReady = true;
    void refreshFiles();
  }

  function readSettings(): Settings {
    const provider = must<HTMLSelectElement>("#set-provider").value;
    return {
      name: must<HTMLInputElement>("#set-name").value,
      provider: provider === "claude-cli" || provider === "cursor-cli" ? provider : "echo",
      workDir: must<HTMLInputElement>("#set-cwd").value,
      claudeCommand: must<HTMLInputElement>("#set-claude-command").value,
      cursorCommand: must<HTMLInputElement>("#set-cursor-command").value,
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
    if (!active) return;
    const text = draft.value;
    const file = attached;
    if (!text.trim() && !file) return;
    const peerId = active;
    draft.value = "";
    attached = "";
    paintAttach();
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

  function paintHistory(next: AppState): void {
    const box = must<HTMLElement>("#history-list");
    const query = historyQuery.trim().toLowerCase();
    const mine = active ? next.sessions.filter((session) => session.peerId === active) : next.sessions;
    const openId = active ? next.openSession[active] : "";
    const rows = mine
      .map((session) => {
        const lines = next.transcripts[session.id] ?? [];
        const peer = next.peers.find((item) => item.peerId === session.peerId);
        const blob = `${session.title}\n${peer?.name ?? ""}\n${lines.map((line) => line.text).join("\n")}`.toLowerCase();
        const matched = query ? lines.find((line) => line.text.toLowerCase().includes(query)) : undefined;
        const last = [...lines].reverse().find((line) => line.text.trim());
        return { session, lines, peer, matched, last, shown: !query || blob.includes(query) };
      })
      .filter((row) => row.shown)
      .sort((a, b) => b.session.updatedAt - a.session.updatedAt);
    box.replaceChildren();
    must<HTMLButtonElement>("#new-session").disabled = !active;
    if (!active) {
      box.textContent = "Chọn một máy để xem các phiên chat.";
      return;
    }
    if (!rows.length) {
      box.textContent = query ? "Không thấy phiên nào khớp." : "Chưa có phiên. Gửi tin hoặc bấm Phiên mới.";
      return;
    }
    for (const row of rows) {
      const open = document.createElement("button");
      open.type = "button";
      open.className = `history-open${row.session.id === openId ? " active" : ""}`;
      open.dataset.session = row.session.id;
      open.dataset.peer = row.session.peerId;
      if (row.matched) open.dataset.line = row.matched.id;
      const title = document.createElement("strong");
      title.textContent = `${row.session.title}${next.unreadSessions.includes(row.session.id) ? " · mới" : ""}`;
      const meta = document.createElement("small");
      const when = new Date(row.session.updatedAt).toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
      const preview = (row.matched?.text || row.last?.text || "").replace(/\s+/g, " ").trim().slice(0, 72);
      meta.textContent = `${row.lines.length} dòng · ${when}${preview ? ` · ${preview}` : ""}`;
      open.append(title, meta);
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "icon-btn history-rename";
      edit.dataset.editSession = row.session.id;
      edit.dataset.peer = row.session.peerId;
      edit.dataset.tip = "Sửa tên phiên";
      edit.setAttribute("aria-label", "Sửa tên phiên");
      edit.innerHTML = icon("pencil");
      const item = document.createElement("div");
      item.className = "history-row";
      item.append(open, edit);
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
    const sessionId = peerId ? state?.openSession[peerId] : "";
    if (!peerId || !sessionId) return;
    const title = must<HTMLInputElement>("#session-title").value;
    void guard(() => window.lan.renameSession(peerId, sessionId, title));
  });
  must<HTMLElement>("#history-list").addEventListener("click", (event) => {
    const edit = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-edit-session]");
    if (edit?.dataset.editSession && edit.dataset.peer) {
      const peerId = edit.dataset.peer;
      const sessionId = edit.dataset.editSession;
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

  function flash(text: string): void {
    const toast = must<HTMLDivElement>("#toast");
    toast.hidden = false;
    toast.textContent = text;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toast.hidden = true;
    }, 3200);
  }
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
  for (const line of lines) {
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
        if (body.dataset.source !== text) {
          body.dataset.source = text;
          body.innerHTML = agentHtml(text);
          changed = true;
        }
      } else if (body && body.textContent !== text) {
        body.textContent = text;
        changed = true;
      }
      body?.classList.toggle("pending", line.pending);
      article.classList.toggle("hit", Boolean(query.trim()) && line.text.toLowerCase().includes(query.trim().toLowerCase()));
    }
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
    body.dataset.source = text;
    body.innerHTML = agentHtml(text);
    if (line.pending) body.classList.add("pending");
    box.append(body);
    article.append(box);
  } else {
    const body = document.createElement("p");
    body.textContent = line.text || (line.pending ? "…" : "");
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
  const tools = report ? [report.claude, report.cursor] : [];
  if (!tools.length) {
    box.textContent = "Đang kiểm tra Claude CLI và Cursor CLI…";
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
    .map((id) => (id === "claude" ? "Claude CLI" : id === "cursor" ? "Cursor CLI" : ""))
    .filter(Boolean);
  return names.length ? `có ${names.join(", ")}` : "";
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
    item("hash", `<path d="M9 4.5L7.5 19.5M16.5 4.5L15 19.5M5 9h14M4.5 15h14"/>`),
    item("terminal", `<path d="M5 8l4 4-4 4M12 16h7"/>`),
  ].join("")}</svg>`;
}

function must<T extends HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Thiếu ${selector}`);
  return node;
}
