/**
 * src/hooks/useElectron.ts
 * Electron 环境检测 + 类型安全 API 访问。
 * secureGet / secureSet 为纯函数，可在 Zustand store 等非 React 上下文中安全调用。
 */

export interface ElectronAPI {
  getVersion: () => Promise<string>;
  secureGet: (key: string) => Promise<string | null>;
  secureSet: (key: string, value: string) => Promise<void>;
  storeRead: (relPath: string) => Promise<unknown | null>;
  storeWrite: (relPath: string, data: unknown) => Promise<void>;
  storeDelete: (relPath: string) => Promise<void>;
  storeList: (dirRelPath: string) => Promise<string[]>;
  onMenuNewCard: (cb: () => void) => void;
  onMenuOpenSettings: (cb: () => void) => void;
  onMenuImport: (cb: () => void) => void;
  onMenuExport: (cb: () => void) => void;
  onMenuToggleTheme: (cb: () => void) => void;
  onMenuZoomIn: (cb: () => void) => void;
  onMenuZoomOut: (cb: () => void) => void;
  onMenuZoomReset: (cb: () => void) => void;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

/** 是否为 Electron 运行环境 */
export function isElectronEnv(): boolean {
  return typeof window !== 'undefined' && !!window.electronAPI;
}

/**
 * 安全读取：Electron safeStorage 解密 / Web localStorage base64 降级
 */
export async function secureGet(key: string): Promise<string | null> {
  if (isElectronEnv()) {
    return window.electronAPI!.secureGet(key);
  }
  // Web 降级：localStorage base64
  const val = localStorage.getItem(`cc_${key}`);
  return val ? atob(val) : null;
}

/**
 * 安全写入：Web 降级仅轻度混淆，非真加密
 */
export async function secureSet(key: string, value: string): Promise<void> {
  if (isElectronEnv()) {
    await window.electronAPI!.secureSet(key, value);
  } else {
    localStorage.setItem(`cc_${key}`, btoa(value));
  }
}

/**
 * React 组件用语义化封装（内部不含 Hook 调用，可在任意上下文使用）
 */
export function useElectron() {
  return {
    isElectron: isElectronEnv(),
    secureGet,
    secureSet,
  };
}
