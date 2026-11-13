import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, screen, type OpenDialogOptions } from "electron";
import { BRIEF_EXTEND } from "../shared/brief";
import { IPC, type FileRef, type Settings } from "../shared/types";
import { fileRef } from "../shared/preview";
import { listWorkFiles } from "./files";
import { AppCore } from "./core";
import { allowPreview, attachPreviewProtocol, registerPreviewScheme } from "./preview";

registerPreviewScheme();

const DISCUSS_EXTENSIONS = ["txt", "md", "markdown", "png", "jpg", "jpeg", "gif", "webp", "bmp", "pdf", "docx", "xlsx", "xls", "csv"];

const profileArg = process.argv.find((arg) => arg.startsWith("--profile="));
const profile = (profileArg?.slice("--profile=".length) || "default").replace(/[^a-zA-Z0-9_-]/g, "") || "default";
const sessionAutoAccept = process.argv.includes("--auto-accept");
const debugArg = process.argv.find((arg) => arg.startsWith("--debug-port="));
if (debugArg) {
  app.commandLine.appendSwitch("remote-debugging-port", debugArg.slice("--debug-port=".length));
}

app.setPath("userData", path.join(app.getPath("appData"), "lan-agents", profile));

process.on("uncaughtException", (err) => {
  console.error("[lan] uncaught", err);
});
process.on("unhandledRejection", (err) => {
  console.error("[lan] rejection", err);
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let core: AppCore | null = null;
  let mainWindow: BrowserWindow | null = null;
  let previewWindow: BrowserWindow | null = null;
  let pendingPreview: FileRef | null = null;

  const broadcast = () => {
    if (!core || !mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send(IPC.state, core.snapshot());
  };

  const dialogHost = (): BrowserWindow | undefined => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
    return win && !win.isDestroyed() ? win : undefined;
  };

  const choosePath = async (options: OpenDialogOptions): Promise<string | null> => {
    const win = dialogHost();
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (result.canceled) return null;
    return result.filePaths[0] ?? null;
  };

  const openPreviewWindow = (file: FileRef) => {
    pendingPreview = file;
    if (previewWindow && !previewWindow.isDestroyed()) {
      previewWindow.setTitle(file.name);
      if (previewWindow.isMinimized()) previewWindow.restore();
      previewWindow.show();
      previewWindow.focus();
      previewWindow.webContents.send(IPC.previewFile, file);
      return;
    }
    const win = new BrowserWindow({
      width: 860,
      height: 640,
      minWidth: 420,
      minHeight: 320,
      backgroundColor: "#f5f5f7",
      title: file.name,
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    previewWindow = win;
    win.removeMenu();
    if (mainWindow && !mainWindow.isDestroyed()) {
      const bounds = mainWindow.getBounds();
      const area = screen.getDisplayMatching(bounds).workArea;
      let x = bounds.x + bounds.width + 12;
      let y = bounds.y;
      if (x + 860 > area.x + area.width) x = Math.max(area.x, bounds.x + 36);
      if (y + 640 > area.y + area.height) y = area.y + Math.max(0, area.height - 640);
      win.setPosition(Math.round(x), Math.round(y));
    }
    win.once("ready-to-show", () => {
      if (!win.isDestroyed()) win.show();
    });
    win.webContents.on("did-finish-load", () => {
      const current = pendingPreview;
      if (!current || win.isDestroyed()) return;
      win.setTitle(current.name);
      win.webContents.send(IPC.previewFile, current);
    });
    win.on("closed", () => {
      if (previewWindow === win) previewWindow = null;
    });
    void win.loadFile(path.join(__dirname, "preview.html"));
  };

  const createWindow = async () => {
    core = new AppCore(profile, sessionAutoAccept);
    core.onChange = broadcast;
    await core.start();
    const win = new BrowserWindow({
      width: 1180,
      height: 780,
      minWidth: 960,
      minHeight: 640,
      backgroundColor: "#f5f5f7",
      title: `LAN Agents — ${core.store.settings.name}`,
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    mainWindow = win;
    win.removeMenu();
    win.on("closed", () => {
      if (mainWindow === win) mainWindow = null;
      if (previewWindow && !previewWindow.isDestroyed()) previewWindow.close();
    });
    win.once("ready-to-show", () => win.show());
    win.webContents.on("did-finish-load", () => {
      if (!core) return;
      win.setTitle(`LAN Agents — ${core.store.settings.name}`);
      broadcast();
    });
    await win.loadFile(path.join(__dirname, "index.html"));
  };

  app.on("second-instance", () => {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app
    .whenReady()
    .then(() => {
      ipcMain.handle(IPC.getState, () => {
        if (!core) throw new Error("App chưa sẵn sàng");
        return core.snapshot();
      });
      ipcMain.handle(IPC.saveSettings, (_event, settings: Settings) => {
        if (!core) throw new Error("App chưa sẵn sàng");
        const state = core.saveSettings(settings);
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle(`LAN Agents — ${state.self.name}`);
        return state;
      });
      ipcMain.handle(IPC.connect, (_event, peerId: string) => core?.connect(peerId));
      ipcMain.handle(IPC.connectAddress, (_event, host: string, port: number) => core?.connectAddress(host, port));
      ipcMain.handle(IPC.disconnect, (_event, peerId: string) => core?.disconnect(peerId));
      ipcMain.handle(IPC.accept, (_event, peerId: string) => core?.accept(peerId));
      ipcMain.handle(IPC.reject, (_event, peerId: string) => core?.reject(peerId));
      ipcMain.handle(IPC.send, (_event, peerId: string, text: string, attachmentPath?: string) =>
        core?.sendHuman(peerId, text, attachmentPath),
      );
      ipcMain.handle(IPC.pickDiscuss, async () => {
        const picked = await choosePath({
          properties: ["openFile"],
          filters: [{ name: "File để trao đổi", extensions: DISCUSS_EXTENSIONS }],
        });
        return picked;
      });
      ipcMain.handle(IPC.pickBriefFiles, async () => {
        const options: OpenDialogOptions = {
          properties: ["openFile", "multiSelections"],
          filters: [{ name: "File context", extensions: DISCUSS_EXTENSIONS }],
        };
        const host = dialogHost();
        const picked = host ? await dialog.showOpenDialog(host, options) : await dialog.showOpenDialog(options);
        return picked.canceled ? [] : picked.filePaths;
      });
      ipcMain.handle(IPC.saveBrief, (_event, peerId: string, patch: { topic?: string; goal?: string; turnLimit?: number }) => {
        if (!core) throw new Error("App chưa sẵn sàng");
        return core.saveBrief(String(peerId), patch ?? {});
      });
      ipcMain.handle(IPC.addBriefFiles, (_event, peerId: string, paths: string[]) => {
        if (!core) throw new Error("App chưa sẵn sàng");
        return core.addBriefFiles(String(peerId), Array.isArray(paths) ? paths : []);
      });
      ipcMain.handle(IPC.removeBriefFile, (_event, peerId: string, name: string) => {
        if (!core) throw new Error("App chưa sẵn sàng");
        return core.removeBriefFile(String(peerId), String(name ?? ""));
      });
      ipcMain.handle(IPC.startBrief, (_event, peerId: string) => {
        if (!core) throw new Error("App chưa sẵn sàng");
        return core.startBrief(String(peerId));
      });
      ipcMain.handle(IPC.extendBrief, (_event, peerId: string, extra?: number) => {
        if (!core) throw new Error("App chưa sẵn sàng");
        return core.extendBrief(String(peerId), Number(extra) || BRIEF_EXTEND);
      });
      ipcMain.handle(IPC.createGroup, () => {
        if (!core) throw new Error("App chưa sẵn sàng");
        return core.createGroup();
      });
      ipcMain.handle(IPC.inviteGroup, (_event, groupId: string, peerId: string) => {
        if (!core) throw new Error("App chưa sẵn sàng");
        return core.inviteGroup(String(groupId), String(peerId));
      });
      ipcMain.handle(IPC.leaveGroup, (_event, groupId: string, peerId?: string) => {
        if (!core) throw new Error("App chưa sẵn sàng");
        return core.leaveGroup(String(groupId), peerId ? String(peerId) : undefined);
      });
      ipcMain.handle(IPC.renameGroup, (_event, groupId: string, title: string) => {
        if (!core) throw new Error("App chưa sẵn sàng");
        return core.renameGroup(String(groupId), String(title ?? ""));
      });
      ipcMain.handle(IPC.dialogue, (_event, peerId: string, topic: string, replies: number) =>
        core?.startDialogue(peerId, topic, replies),
      );
      ipcMain.handle(IPC.stop, (_event, peerId: string) => core?.stopTalk(peerId));
      ipcMain.handle(IPC.activity, (_event, peerId: string, patch: { typing?: boolean; replying?: boolean }) => {
        core?.notifyActivity(peerId, patch);
      });
      ipcMain.handle(IPC.rescanClis, () => {
        if (!core) throw new Error("App chưa sẵn sàng");
        return core.rescanClis();
      });
      attachPreviewProtocol(() => core?.store.settings.workDir ?? "");
      ipcMain.handle(IPC.createSession, (_event, peerId: string) => {
        if (!core) throw new Error("App chưa sẵn sàng");
        return core.createSession(String(peerId));
      });
      ipcMain.handle(IPC.openSession, (_event, peerId: string, sessionId: string) => {
        if (!core) throw new Error("App chưa sẵn sàng");
        return core.openSession(String(peerId), String(sessionId));
      });
      ipcMain.handle(IPC.renameSession, (_event, peerId: string, sessionId: string, title: string) => {
        if (!core) throw new Error("App chưa sẵn sàng");
        return core.renameSession(String(peerId), String(sessionId), String(title ?? ""));
      });
      ipcMain.handle(IPC.listWorkFiles, async (_event, dir: string) => {
        if (typeof dir !== "string" || !dir.trim()) return { found: false, files: [] };
        const listed = await listWorkFiles(dir);
        for (const file of listed.files) {
          if (file.preview) allowPreview(file.path);
        }
        return listed;
      });
      ipcMain.handle(IPC.showPreview, (_event, raw: unknown) => {
        const picked = raw && typeof raw === "object" && "path" in raw ? fileRef(String((raw as { path: unknown }).path)) : null;
        if (!picked) return false;
        allowPreview(picked.path);
        openPreviewWindow(picked);
        return true;
      });
      ipcMain.handle(IPC.openPreview, async () => {
        const picked = await choosePath({
          properties: ["openFile"],
          filters: [
            {
              name: "Xem trước",
              extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "html", "htm", "md", "markdown", "mp3", "wav", "ogg", "m4a", "flac", "mp4", "webm", "mov", "ogv"],
            },
          ],
        });
        const ref = picked ? fileRef(picked) : null;
        if (!ref) return null;
        allowPreview(ref.path);
        return ref;
      });
      ipcMain.handle(IPC.sendFile, async (_event, peerId: string) => {
        if (!core) throw new Error("App chưa sẵn sàng");
        const filePath = await choosePath({ properties: ["openFile"] });
        if (!filePath) return null;
        await core.sendFile(peerId, filePath, true);
        return filePath;
      });
      ipcMain.handle(IPC.pickCwd, () => choosePath({ properties: ["openDirectory"] }));
      return createWindow();
    })
    .catch((err) => {
      console.error(err);
      app.quit();
    });

  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => {
    void core?.stop();
  });
}
