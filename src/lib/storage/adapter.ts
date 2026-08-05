/**
 * src/lib/storage/adapter.ts
 * StorageAdapter 运行时选择：按能力描述探测，结果全局缓存。
 * 优先级：远端消息服务（未来 Python sidecar）→ Electron IPC → dev 中间件 → localStorage 兜底。
 */
import { probeCaps } from './probe';
import type { StorageAdapter } from './protocol';
import { DevServerAdapter } from './devServer';
import { ElectronFsAdapter } from './electronFs';
import { LocalStorageAdapter } from './localStorage';
import { isElectronEnv } from '@/hooks/useElectron';

export type { StorageAdapter, StoreHealth } from './protocol';
export { StoreError, PROTOCOL_VERSION, DATA_DIR_NAME, STATE_FILE, LEGACY_STORAGE_KEY } from './protocol';
export { probeCaps } from './probe';

let adapterPromise: Promise<StorageAdapter> | null = null;

/** 获取全局存储适配器（首次调用时完成探测，之后复用同一实例） */
export function getStorageAdapter(): Promise<StorageAdapter> {
  if (!adapterPromise) adapterPromise = selectAdapter();
  return adapterPromise;
}

/**
 * 启动时选择适配器（顺序即优先级，任一探测失败自动降级下一档）
 *
 * :return: 选中的 StorageAdapter 实例
 */
async function selectAdapter(): Promise<StorageAdapter> {
  // 1) 远端消息服务（未来 Python sidecar / 独立后端）：按能力描述探测，存在则优先
  const remoteUrl = (import.meta.env?.VITE_REMOTE_STORE_URL as string | undefined) ?? '';
  if (remoteUrl && (await probeCaps(remoteUrl))) {
    return new DevServerAdapter(remoteUrl); // kind: 'http-remote'
  }
  // 2) Electron：preload 暴露的 store* IPC
  if (isElectronEnv() && typeof window.electronAPI?.storeRead === 'function') {
    return new ElectronFsAdapter();
  }
  // 3) 浏览器 dev：探测 Vite 中间件（vite preview / 静态部署时不存在 → 降级）
  if (await probeCaps()) {
    return new DevServerAdapter();
  }
  // 4) 兜底：localStorage（静态构建，兼作旧数据迁移源）
  return new LocalStorageAdapter();
}
