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

  // 文件存储（readJson 不存在返回 null / writeJson 原子写 / delete 递归 / list 列目录）
  storeRead: (relPath: string) => ipcRenderer.invoke(IPC_CHANNELS.STORE_READ, relPath),
  storeWrite: (relPath: string, data: unknown) =>
    ipcRenderer.invoke(IPC_CHANNELS.STORE_WRITE, relPath, data),
  storeDelete: (relPath: string) => ipcRenderer.invoke(IPC_CHANNELS.STORE_DELETE, relPath),
  storeList: (dirRelPath: string) => ipcRenderer.invoke(IPC_CHANNELS.STORE_LIST, dirRelPath),
  storeReadBinary: (relPath: string) => ipcRenderer.invoke(IPC_CHANNELS.STORE_READ_BINARY, relPath),
  storeWriteBinary: (relPath: string, data: ArrayBuffer) => ipcRenderer.invoke(IPC_CHANNELS.STORE_WRITE_BINARY, relPath, data),
  storeExists: (relPath: string) => ipcRenderer.invoke(IPC_CHANNELS.STORE_EXISTS, relPath),

  // 数据目录外部变更通知（文件监听触发）
  onStoreChanged: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(IPC_CHANNELS.STORE_CHANGED, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.STORE_CHANGED, listener);
  },

  // 菜单事件监听
  onMenuNewCard: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(IPC_CHANNELS.MENU_NEW_CARD, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MENU_NEW_CARD, listener);
  },
  onMenuOpenSettings: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(IPC_CHANNELS.MENU_OPEN_SETTINGS, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MENU_OPEN_SETTINGS, listener);
  },
  onMenuImport: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(IPC_CHANNELS.MENU_IMPORT, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MENU_IMPORT, listener);
  },
  onMenuExport: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(IPC_CHANNELS.MENU_EXPORT, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MENU_EXPORT, listener);
  },
  onMenuToggleTheme: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(IPC_CHANNELS.MENU_TOGGLE_THEME, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MENU_TOGGLE_THEME, listener);
  },
  onMenuZoomIn: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(IPC_CHANNELS.MENU_ZOOM_IN, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MENU_ZOOM_IN, listener);
  },
  onMenuZoomOut: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(IPC_CHANNELS.MENU_ZOOM_OUT, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MENU_ZOOM_OUT, listener);
  },
  onMenuZoomReset: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(IPC_CHANNELS.MENU_ZOOM_RESET, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MENU_ZOOM_RESET, listener);
  },
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);

// 类型声明（供渲染进程使用）
export type ElectronAPI = typeof electronAPI;
