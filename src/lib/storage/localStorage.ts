/**
 * src/lib/storage/localStorage.ts
 * LocalStorageAdapter：静态构建 / 降级兜底（现状行为保留），兼作旧数据迁移源。
 * 以 'chat-canvas-data:' + relPath 为 key 模拟文件布局，list 按路径段归纳直接子项。
 * 注意 localStorage 5-10MB 上限，仅作兜底，不作主存储。
 */
import type { StorageAdapter } from './protocol';

const PREFIX = 'chat-canvas-data:';

export class LocalStorageAdapter implements StorageAdapter {
  readonly kind = 'localstorage' as const;

  async readJson(relPath: string): Promise<unknown | null> {
    const raw = localStorage.getItem(PREFIX + relPath);
    if (raw === null) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async writeJson(relPath: string, data: unknown): Promise<void> {
    localStorage.setItem(PREFIX + relPath, JSON.stringify(data));
  }

  /** 删除文件 key，或以 relPath 为前缀递归删除模拟目录 */
  async delete(relPath: string): Promise<void> {
    const dirPrefix = `${PREFIX}${relPath.replace(/\/$/, '')}/`;
    const toRemove: string[] = [PREFIX + relPath];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(dirPrefix)) toRemove.push(key);
    }
    for (const key of toRemove) localStorage.removeItem(key);
  }

  /** 列模拟目录的直接子项（文件末段名或子目录首段名，去重） */
  async list(dirRelPath: string): Promise<string[]> {
    const dirPrefix = dirRelPath ? `${PREFIX}${dirRelPath.replace(/\/$/, '')}/` : PREFIX;
    const children = new Set<string>();
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(dirPrefix)) continue;
      const rest = key.slice(dirPrefix.length);
      if (!rest) continue;
      children.add(rest.split('/')[0]);
    }
    return [...children];
  }
}
