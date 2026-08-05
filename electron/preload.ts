// electron/preload.ts — 预加载脚本，安全桥接主进程与渲染进程
import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from './ipc-channels.js';

const electronAPI = {
  // 版本
  getVersion: () => ipcRenderer.invoke(IPC_CHANNELS.GET_VERSION),

  // 安全存储
  secureGet: (key: string) => ipcRenderer.invoke(IPC_CHANNELS.SECURE_GET, key),
  secureSet: (key: string, value: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SECURE_SET, key, value),

  // 菜单事件监听
  onMenuNewCard: (callback: () => void) => {
    ipcRenderer.on(IPC_CHANNELS.MENU_NEW_CARD, () => callback());
  },
  onMenuOpenSettings: (callback: () => void) => {
    ipcRenderer.on(IPC_CHANNELS.MENU_OPEN_SETTINGS, () => callback());
  },
  onMenuImport: (callback: () => void) => {
    ipcRenderer.on(IPC_CHANNELS.MENU_IMPORT, () => callback());
  },
  onMenuExport: (callback: () => void) => {
    ipcRenderer.on(IPC_CHANNELS.MENU_EXPORT, () => callback());
  },
  onMenuToggleTheme: (callback: () => void) => {
    ipcRenderer.on(IPC_CHANNELS.MENU_TOGGLE_THEME, () => callback());
  },
  onMenuZoomIn: (callback: () => void) => {
    ipcRenderer.on(IPC_CHANNELS.MENU_ZOOM_IN, () => callback());
  },
  onMenuZoomOut: (callback: () => void) => {
    ipcRenderer.on(IPC_CHANNELS.MENU_ZOOM_OUT, () => callback());
  },
  onMenuZoomReset: (callback: () => void) => {
    ipcRenderer.on(IPC_CHANNELS.MENU_ZOOM_RESET, () => callback());
  },
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);

// 类型声明（供渲染进程使用）
export type ElectronAPI = typeof electronAPI;
