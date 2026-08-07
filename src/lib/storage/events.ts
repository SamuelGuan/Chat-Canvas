/**
 * src/lib/storage/events.ts
 * 数据目录外部变更订阅：dev-server/http-remote 走 SSE（GET /events），electron-fs 走 IPC 推送。
 * 文件监听（中间件/主进程）发现外部进程改文件并完成一致性收敛后，经此通道通知渲染层联动。
 */
import type { StorageAdapter } from './protocol';
import { DevServerAdapter } from './devServer';
import { isElectronEnv } from '@/hooks/useElectron';

/**
 * 订阅外部变更通知
 *
 * :param adapter: 当前存储适配器（localstorage 兜底无推送通道，返回空退订函数）
 * :param onChanged: 变更通知回调（触发后应调用 store 的 reconvergeFromDisk）
 * :return: 退订函数
 */
export function subscribeStoreEvents(adapter: StorageAdapter, onChanged: () => void): () => void {
  if (adapter instanceof DevServerAdapter) {
    const es = new EventSource(`${adapter.getBaseUrl()}/events`);
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data?.type === 'store-changed') onChanged();
      } catch {
        /* 忽略非 JSON 帧（如注释心跳） */
      }
    };
    return () => es.close();
  }
  if (adapter.kind === 'electron-fs' && isElectronEnv() && window.electronAPI?.onStoreChanged) {
    return window.electronAPI.onStoreChanged(onChanged);
  }
  return () => {};
}
