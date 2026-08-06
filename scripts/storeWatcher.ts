/**
 * scripts/storeWatcher.ts
 * 数据目录文件监听（chokidar）：外部进程（agent / Python sidecar / 手动）改文件
 * → 去抖 300ms → 一致性校验收敛 → 回调通知（渲染层联动）。
 * 本进程自身经 storeCore 的写入经 isSelfWrite 过滤，不会触发收敛循环。
 */
import chokidar, { type FSWatcher } from 'chokidar';
import { isSelfWrite } from './storeCore';
import { createNodeFsAdapter } from './nodeFsAdapter';
import { reconcileData } from '../src/lib/storage/consistency';

export interface StoreWatcher {
  close: () => Promise<void>;
}

/** 外部变更去抖间隔（ms）：编辑器/拷贝动作往往一串事件，合并为一次收敛 */
const WATCH_DEBOUNCE_MS = 300;

/**
 * 启动数据目录监听
 *
 * :param dataRoot: 数据目录绝对路径
 * :param onChanged: 外部变更收敛完成后的回调（参数为变更的绝对路径列表）
 * :return: 监听句柄
 */
export function startStoreWatcher(dataRoot: string, onChanged: (changedPaths: string[]) => void): StoreWatcher {
  const adapter = createNodeFsAdapter(dataRoot);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending = new Set<string>();
  let reconciling = false;

  const watcher: FSWatcher = chokidar.watch(dataRoot, {
    ignoreInitial: true,
    // .git / 原子写 tmp / schema 目录不触发
    ignored: [/(^|[/\\])\.git([/\\]|$)/, /\.tmp-\d+$/, /[/\\]schema[/\\]/],
    depth: 5,
  });

  const flush = async (): Promise<void> => {
    if (reconciling) return; // 防重入：校验自身写盘会再触发事件
    const paths = [...pending].filter((p) => !isSelfWrite(p));
    pending = new Set();
    if (paths.length === 0) return;
    reconciling = true;
    try {
      await reconcileData(adapter);
      onChanged(paths);
    } catch (e) {
      console.error('[store-watcher] 一致性校验失败', e);
    } finally {
      reconciling = false;
    }
  };

  watcher.on('all', (event, path) => {
    // 只跟踪文件事件；目录事件由内部文件事件覆盖（且自身 mkdir 不触发收敛）
    if (event === 'addDir' || event === 'unlinkDir') return;
    pending.add(path);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void flush(), WATCH_DEBOUNCE_MS);
  });

  watcher.on('error', (e) => console.error('[store-watcher] 监听错误', e));

  return {
    close: async () => {
      if (timer) clearTimeout(timer);
      await watcher.close();
    },
  };
}
