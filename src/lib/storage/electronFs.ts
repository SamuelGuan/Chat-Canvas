/**
 * src/lib/storage/electronFs.ts
 * ElectronFsAdapter：preload 暴露的 window.electronAPI.store* → IPC 到主进程 fs。
 * 语义与 DevServerAdapter 一致（读缺失返回 null / 原子写 / 递归删除 / 列目录）。
 */
import { StoreError, type StorageAdapter } from './protocol';

export class ElectronFsAdapter implements StorageAdapter {
  readonly kind = 'electron-fs' as const;

  async readJson(relPath: string): Promise<unknown | null> {
    try {
      return await window.electronAPI!.storeRead(relPath);
    } catch (e) {
      throw toStoreError(e);
    }
  }

  async writeJson(relPath: string, data: unknown): Promise<void> {
    try {
      await window.electronAPI!.storeWrite(relPath, data);
    } catch (e) {
      throw toStoreError(e);
    }
  }

  async delete(relPath: string): Promise<void> {
    try {
      await window.electronAPI!.storeDelete(relPath);
    } catch (e) {
      throw toStoreError(e);
    }
  }

  async list(dirRelPath: string): Promise<string[]> {
    try {
      return await window.electronAPI!.storeList(dirRelPath);
    } catch (e) {
      throw toStoreError(e);
    }
  }
}

/** IPC 异常（Electron 包装为通用 Error，原始 message 保留在 message 内）翻译为 StoreError */
function toStoreError(e: unknown): StoreError {
  const message = e instanceof Error ? e.message : String(e);
  return new StoreError(message, 'IPC_ERROR');
}
