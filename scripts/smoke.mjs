import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { build } from "./build.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await build();
const electron = createRequire(path.join(root, "package.json"))("electron");

function launch(profile, debugPort) {
  const lines = [];
  const child = spawn(electron, [".", `--profile=${profile}`, "--auto-accept", `--debug-port=${debugPort}`], {
    cwd: root,
    windowsHide: true,
  });
  const keep = (chunk) => {
    lines.push(chunk.toString());
    if (lines.length > 80) lines.shift();
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  return { child, lines };
}

const a = launch("A", 9222);
const b = launch("B", 9223);

function shutdown() {
  for (const proc of [a.child, b.child]) {
    if (!proc.killed) proc.kill();
  }
}

try {
  const identityA = await waitForIdentity("A");
  const identityB = await waitForIdentity("B");
  await waitForPeer(identityA.port, identityB.peerId);
  await waitForPeer(identityB.port, identityA.peerId);
  let result;
  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      result = await evaluate(9222, dialogueScript());
      break;
    } catch (err) {
      lastError = err;
      const text = err instanceof Error ? err.message : String(err);
      if (!text.includes("destroyed") && !text.includes("context")) throw err;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  if (!result) throw lastError ?? new Error("Không chạy được kịch bản giao diện");
  if (!result?.ok || !result.ui) {
    console.error(JSON.stringify(result, null, 2));
    console.error("--- A ---");
    console.error(a.lines.join(""));
    console.error("--- B ---");
    console.error(b.lines.join(""));
    throw new Error(result?.stage ? `Dừng ở ${result.stage}` : "Không nhận được câu Echo");
  }
  console.log(result.reply);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  console.error(a.lines.join(""));
  console.error(b.lines.join(""));
  process.exitCode = 1;
} finally {
  shutdown();
  await new Promise((resolve) => setTimeout(resolve, 400));
}

async function waitForIdentity(profile) {
  const start = Date.now();
  while (Date.now() - start < 20000) {
    for (let port = 3940; port < 3970; port += 1) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/identity`, { signal: AbortSignal.timeout(300) });
        if (!res.ok) continue;
        const body = await res.json();
        if (body.profile === profile) return { port, ...body };
      } catch {
        /* cổng đóng */
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Không thấy profile ${profile}`);
}

async function waitForPeer(port, peerId) {
  const start = Date.now();
  while (Date.now() - start < 20000) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/peers`, { signal: AbortSignal.timeout(500) });
      const body = await res.json();
      if (body.peers?.some((peer) => peer.peerId === peerId && peer.discovered)) return;
    } catch {
      /* chưa nghe */
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Cổng ${port} không thấy peer ${peerId}`);
}

async function evaluate(debugPort, expression) {
  const page = await waitForDebugger(debugPort);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP quá giờ")), 25000);
    const ws = new WebSocket(page.webSocketDebuggerUrl);
        ws.once("open", () => {
          ws.send(
            JSON.stringify({
              id: 1,
              method: "Runtime.evaluate",
              params: { expression, awaitPromise: true, returnByValue: true },
            }),
          );
        });
        ws.on("message", (data) => {
          const message = JSON.parse(data.toString());
          if (message.id !== 1) return;
          clearTimeout(timer);
          ws.close();
          if (message.error) {
            reject(new Error(JSON.stringify(message.error)));
            return;
          }
          if (message.result?.exceptionDetails) {
            reject(new Error(JSON.stringify(message.result.exceptionDetails)));
            return;
          }
          resolve(message.result?.result?.value);
        });
    ws.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function waitForDebugger(debugPort) {
  const start = Date.now();
  while (Date.now() - start < 15000) {
    try {
      const pages = await fetch(`http://127.0.0.1:${debugPort}/json`, { signal: AbortSignal.timeout(500) }).then((res) => res.json());
      const page = pages.find(
        (item) => item.type === "page" && item.webSocketDebuggerUrl && String(item.url || "").includes("index.html"),
      );
      if (page) return page;
    } catch {
      /* debugger chưa mở */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Không có trang debug ở cổng ${debugPort}`);
}

function dialogueScript() {
  return `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const deadline = Date.now() + 15000;
    let peer = null;
    while (Date.now() < deadline) {
      const state = await window.lan.getState();
      peer = state.peers.find((item) => item.discovered && item.peerId !== state.self.peerId) || null;
      if (peer) break;
      await sleep(250);
    }
    if (!peer) return { ok: false, stage: "discover" };
    await window.lan.connect(peer.peerId);
    let linked = false;
    while (Date.now() < deadline) {
      const state = await window.lan.getState();
      const current = state.peers.find((item) => item.peerId === peer.peerId);
      if (current && current.status === "connected") { linked = true; break; }
      await sleep(200);
    }
    if (!linked) {
      const state = await window.lan.getState();
      return { ok: false, stage: "connect", peers: state.peers, logs: state.logs };
    }
    await window.lan.send(peer.peerId, "ping tu may A");
    while (Date.now() < deadline) {
      const state = await window.lan.getState();
      const lines = state.transcripts[peer.peerId] || [];
      const reply = lines.find((line) => line.kind === "agent" && !line.pending && line.text.includes("Echo"));
      if (reply) {
        const tools = document.querySelector("#tools")?.textContent || "";
        if (!tools.includes("Claude CLI") || !tools.includes("Cursor CLI")) {
          return { ok: false, stage: "clis", tools };
        }
        return { ok: true, reply: reply.text, ui: document.querySelector("#self-name")?.textContent || "", tools };
      }
      await sleep(200);
    }
    const state = await window.lan.getState();
    return { ok: false, stage: "reply", lines: state.transcripts[peer.peerId] || [], logs: state.logs };
  })()`;
}
