import { contextBridge, ipcRenderer } from "electron";
import { IPC, type AppState, type LanApi, type Settings } from "../shared/types";

const api: LanApi = {
  getState: () => ipcRenderer.invoke(IPC.getState) as Promise<AppState>,
  saveSettings: (settings: Settings) => ipcRenderer.invoke(IPC.saveSettings, settings) as Promise<AppState>,
  connect: (peerId: string) => ipcRenderer.invoke(IPC.connect, peerId) as Promise<void>,
  connectAddress: (host: string, port: number) => ipcRenderer.invoke(IPC.connectAddress, host, port) as Promise<void>,
  disconnect: (peerId: string) => ipcRenderer.invoke(IPC.disconnect, peerId) as Promise<void>,
  accept: (peerId: string) => ipcRenderer.invoke(IPC.accept, peerId) as Promise<void>,
  reject: (peerId: string) => ipcRenderer.invoke(IPC.reject, peerId) as Promise<void>,
  send: (peerId: string, text: string) => ipcRenderer.invoke(IPC.send, peerId, text) as Promise<void>,
  dialogue: (peerId: string, topic: string, replies: number) =>
    ipcRenderer.invoke(IPC.dialogue, peerId, topic, replies) as Promise<void>,
  stop: (peerId: string) => ipcRenderer.invoke(IPC.stop, peerId) as Promise<void>,
  pickCwd: () => ipcRenderer.invoke(IPC.pickCwd) as Promise<string | null>,
  rescanClis: () => ipcRenderer.invoke(IPC.rescanClis) as Promise<AppState>,
  onState: (listener) => {
    const wrapped = (_event: unknown, state: AppState) => listener(state);
    ipcRenderer.on(IPC.state, wrapped);
    return () => ipcRenderer.removeListener(IPC.state, wrapped);
  },
};

contextBridge.exposeInMainWorld("lan", api);
