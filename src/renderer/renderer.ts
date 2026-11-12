import type { AppState, ChatLine, CliReport, CliToolState, FileRef, PeerActivity, PeerView, Settings, WorkFile } from "../shared/types";
import { providerLabel } from "../shared/types";
import { fileRef, type PreviewKind } from "../shared/preview";
import { renderPreview } from "./previewView";

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
      stop: (peerId: string) => Promise<void>;
      pickCwd: () => Promise<string | null>;
      rescanClis: () => Promise<AppState>;
      activity: (peerId: string, patch: { typing?: boolean; replying?: boolean }) => Promise<void>;
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
    <header class="top">
      <div class="brand">
        <span class="mark" aria-hidden="true"></span>
        <div>
          <p class="kicker">Mạng nội bộ</p>
          <h1>LAN Agents</h1>
        </div>
      </div>
      <div class="self">
        <strong id="self-name"></strong>
        <span id="self-meta"></span>
      </div>
    </header>
    <main>
      <aside>
        <section>
          <div class="section-label">Máy trong LAN</div>
          <div id="peers" class="peers"></div>
          <p id="peers-empty" class="hint">Đang dò multicast và các cổng local 3940–3969.</p>
        </section>
        <form id="manual" class="manual">
          <input id="manual-host" placeholder="IP hoặc tên máy" autocomplete="off" />
          <input id="manual-port" inputmode="numeric" value="3940" aria-label="Cổng" />
          <button type="submit">Nối</button>
        </form>
        <details open>
          <summary>Cài đặt agent</summary>
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
          <label class="cwd">Thư mục làm việc
            <span>
              <input id="set-cwd" spellcheck="false" />
              <button id="pick-cwd" type="button">Chọn</button>
            </span>
          </label>
          <div id="workdir-files" class="workdir-files"></div>
          <label class="check"><input id="set-auto" type="checkbox" /> Tự chấp nhận máy trong LAN</label>
          <div id="tools" class="tools"></div>
          <p class="hint">Không dùng API key. Hai bên dùng chung một prompt hội thoại. File gửi qua nút Gửi file, hoặc nhờ agent gửi file trong thư mục làm việc: file đi qua app, không cần share Windows. Lệnh cursor của Cursor IDE không được tính là Cursor CLI.</p>
          <div class="save-row">
            <button id="save" type="button">Lưu cài đặt</button>
            <button id="rescan" type="button" class="ghost">Kiểm tra lại</button>
            <span id="saved"></span>
          </div>
        </details>
        <pre id="logs" class="logs" aria-live="polite"></pre>
      </aside>
      <section class="chat">
        <div id="chat-empty" class="empty">
          <h2>Chưa chọn máy</h2>
          <p>Mở app trên máy thứ hai trong cùng LAN, hoặc chạy thêm một cửa sổ với profile B. Hai bên sẽ hiện trong danh sách.</p>
        </div>
        <div id="chat-panel" class="chat-panel" hidden>
          <header class="chat-head">
            <div>
              <h2 id="chat-title"></h2>
              <p id="chat-status"></p>
            </div>
            <button id="link" type="button">Kết nối</button>
          </header>
          <div id="banner" class="banner" hidden>
            <span id="banner-text"></span>
            <span>
              <button id="accept" type="button">Chấp nhận</button>
              <button id="reject" type="button" class="ghost">Từ chối</button>
            </span>
          </div>
          <div id="messages" class="messages"></div>
          <p id="typing" class="typing" hidden></p>
          <form id="composer" class="composer">
            <textarea id="draft" rows="3" placeholder="Nhắn cho agent máy kia…"></textarea>
            <div id="attach-chip" class="attach-chip" hidden>
              <span id="attach-name"></span>
              <button id="attach-clear" type="button" class="ghost">Bỏ</button>
            </div>
            <div class="composer-actions">
              <button id="send" type="submit">Gửi</button>
              <button id="attach" type="button" class="ghost">Đính kèm</button>
              <button id="send-file" type="button" class="ghost">Gửi file</button>
              <button id="open-preview" type="button" class="ghost">Xem file</button>
              <label class="replies">Lượt
                <input id="replies" type="number" min="1" max="8" value="4" />
              </label>
              <button id="dialogue" type="button" class="ghost">Cho hai agent nói</button>
              <button id="stop" type="button" class="ghost">Dừng</button>
            </div>
          </form>
          <details class="http">
            <summary>Lệnh HTTP tới agent máy kia</summary>
            <pre id="http-snippet"></pre>
            <button id="copy-http" type="button" class="ghost">Chép lệnh</button>
          </details>
        </div>
      </section>
    </main>
    <div id="toast" class="toast" hidden></div>
  `;

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
  must<HTMLButtonElement>("#dialogue").addEventListener("click", () => {
    if (!active) return;
    const peerId = active;
    const topic = draft.value.trim() || "Xin chào. Hãy giới thiệu bạn đang chạy trên máy nào, trong một đoạn ngắn.";
    const replies = Number(must<HTMLInputElement>("#replies").value);
    draft.value = "";
    noteTyping(false);
    void guard(() => window.lan.dialogue(peerId, topic, replies));
  });
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
    must<HTMLElement>("#self-meta").textContent = [providerLabel(next.self.provider), `${next.self.host}:${next.self.port}`, shortId(next.self.peerId), localNote]
      .filter(Boolean)
      .join(" · ");
    fillSettings(next.settings);
    paintTools(next.localClis);
    paintPeers(next);
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
      const title = document.createElement("strong");
      title.textContent = peer.name;
      const meta = document.createElement("span");
      const where = peer.viaLocalhost ? "cùng máy" : peer.host || "chưa có IP";
      meta.textContent = [providerLabel(peer.provider), where, peerCliNote(peer.clis), activityNote(next.activity[peer.peerId]), statusText(peer)].filter(Boolean).join(" · ");
      button.append(title, meta);
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
    must<HTMLElement>("#chat-status").textContent = [providerLabel(peer.provider), where, peerCliNote(peer.clis), statusText(peer)]
      .filter(Boolean)
      .join(" · ");
    const typing = must<HTMLElement>("#typing");
    const activityText = activitySentence(peer.name, next.activity[peer.peerId]);
    typing.hidden = !activityText;
    typing.textContent = activityText;
    const link = must<HTMLButtonElement>("#link");
    const connected = peer.status === "connected";
    link.textContent = connected ? "Ngắt" : peer.status === "pending-out" ? "Đang chờ" : peer.status === "connecting" ? "Đang nối" : "Kết nối";
    link.disabled = peer.status === "connecting" || peer.status === "pending-out";
    link.onclick = () => {
      const peerId = active;
      if (!peerId) return;
      void guard(() => (connected ? window.lan.disconnect(peerId) : window.lan.connect(peerId)));
    };
    const banner = must<HTMLElement>("#banner");
    banner.hidden = peer.status !== "pending-in";
    must<HTMLElement>("#banner-text").textContent = `${peer.name} muốn nối vào máy này.`;
    const lines = next.transcripts[active] ?? [];
    paintMessages(messagesEl, lines, next.self.peerId, nearBottom(messagesEl));
    const canSend = connected || Boolean(peer.token);
    must<HTMLButtonElement>("#send").disabled = !canSend;
    must<HTMLButtonElement>("#send-file").disabled = !canSend;
    must<HTMLButtonElement>("#dialogue").disabled = !connected;
    must<HTMLButtonElement>("#stop").disabled = !lines.some((line) => line.pending);
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

  function noteTyping(activeNow: boolean): void {
    const peerId = active;
    if (!peerId) return;
    window.clearTimeout(typingTimer);
    if (!activeNow) {
      if (!typingOn) return;
      typingOn = false;
      void window.lan.activity(peerId, { typing: false });
      return;
    }
    if (!typingOn) {
      typingOn = true;
      void window.lan.activity(peerId, { typing: true });
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

function paintMessages(host: HTMLElement, lines: ChatLine[], selfId: string, stick: boolean): void {
  const ids = new Set(lines.map((line) => line.id));
  for (const child of Array.from(host.children)) {
    const id = child.getAttribute("data-id");
    if (!id || !ids.has(id)) child.remove();
  }
  let changed = false;
  for (const line of lines) {
    const article = host.querySelector<HTMLElement>(`[data-id="${line.id}"]`);
    const text = line.text || (line.pending ? "…" : "");
    if (!article) {
      const created = renderLine(line, selfId);
      created.dataset.id = line.id;
      host.append(created);
      changed = true;
      continue;
    }
    const body = article.querySelector("p");
    if (body && body.textContent !== text) {
      body.textContent = text;
      changed = true;
    }
    body?.classList.toggle("pending", line.pending);
    host.append(article);
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
  const body = document.createElement("p");
  body.textContent = line.text || (line.pending ? "…" : "");
  if (line.pending) body.classList.add("pending");
  article.append(body);
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

function activitySentence(name: string, activity: PeerActivity | undefined): string {
  if (activity?.replying) return `${name} đang trả lời…`;
  if (activity?.typing) return `${name} đang nhập…`;
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

function shortId(id: string): string {
  return id.slice(0, 8);
}

function nearBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 90;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : "Có lỗi";
}

function must<T extends HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Thiếu ${selector}`);
  return node;
}
