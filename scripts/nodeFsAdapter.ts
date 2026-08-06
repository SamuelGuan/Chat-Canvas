/**
 * scripts/nodeFsAdapter.ts
 * Node 侧 StorageAdapter 实现（storeCore 直封装，无 IPC/HTTP 跳跃）。
 * 用于：check-data CLI / 文件监听 / Electron 主进程的一致性校验。
 */
import type { StorageAdapter } from '../src/lib/storage/protocol';
import { deletePath, listDir, readJsonFile, writeJsonFile } from './storeCore';

/**
 * 创建 Node fs 适配器
 *
 * :param dataRoot: 数据目录绝对路径
 * :return: 语义与渲染层适配器一致的 StorageAdapter
 */
export function createNodeFsAdapter(dataRoot: string): StorageAdapter {
  return {
    kind: 'node-cli',
    readJson: (relPath) => readJsonFile(dataRoot, relPath),
    writeJson: (relPath, data) => writeJsonFile(dataRoot, relPath, data),
    delete: (relPath) => deletePath(dataRoot, relPath),
    list: (dirRelPath) => listDir(dataRoot, dirRelPath),
  };
}
