import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { IPC, type Settings } from "../shared/types";
import { AppCore } from "./core";

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

  const broadcast = () => {
    if (!core) return;
    const state = core.snapshot();
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.webContents.isDestroyed()) win.webContents.send(IPC.state, state);
    }
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
      backgroundColor: "#12150e",
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
    win.removeMenu();
    win.once("ready-to-show", () => win.show());
    win.webContents.on("did-finish-load", () => {
      if (!core) return;
      win.setTitle(`LAN Agents — ${core.store.settings.name}`);
      broadcast();
    });
    await win.loadFile(path.join(__dirname, "index.html"));
  };

  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
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
        const win = BrowserWindow.getAllWindows()[0];
        if (win) win.setTitle(`LAN Agents — ${state.self.name}`);
        return state;
      });
      ipcMain.handle(IPC.connect, (_event, peerId: string) => core?.connect(peerId));
      ipcMain.handle(IPC.connectAddress, (_event, host: string, port: number) => core?.connectAddress(host, port));
      ipcMain.handle(IPC.disconnect, (_event, peerId: string) => core?.disconnect(peerId));
      ipcMain.handle(IPC.accept, (_event, peerId: string) => core?.accept(peerId));
      ipcMain.handle(IPC.reject, (_event, peerId: string) => core?.reject(peerId));
      ipcMain.handle(IPC.send, (_event, peerId: string, text: string) => core?.sendHuman(peerId, text));
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
      ipcMain.handle(IPC.sendFile, async (_event, peerId: string) => {
        if (!core) throw new Error("App chưa sẵn sàng");
        const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
        const result = await dialog.showOpenDialog(win, { properties: ["openFile"] });
        if (result.canceled) return null;
        const filePath = result.filePaths[0];
        if (!filePath) return null;
        await core.sendFile(peerId, filePath, true);
        return filePath;
      });
      ipcMain.handle(IPC.pickCwd, async () => {
        const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
        const result = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
        if (result.canceled) return null;
        return result.filePaths[0] ?? null;
      });
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
