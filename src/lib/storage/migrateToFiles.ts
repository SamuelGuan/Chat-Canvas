/**
 * src/lib/storage/migrateToFiles.ts
 * v0.4 Phase 1：旧 localStorage 单 blob → 文件布局的一次性迁移。
 *
 * 触发条件：检测到旧 key `chat-canvas-session` 且数据目录为空（无 state.json / index.json）。
 * 流程：硬拷贝备份 → 写入 → 校验 → 删除旧 key；任何一步失败保留旧 key 不动，下次启动重试。
 *
 * 注：Phase 1 的 persist 仍为整包 blob，迁移落点为单个 state.json；
 * Phase 2 三层 Manager 上线后由启动流程按 index/project/session 三级文件拆分。
 */
import { LEGACY_STORAGE_KEY, STATE_FILE, type StorageAdapter } from './protocol';

export type MigrationResult = 'migrated' | 'skipped' | 'failed';

/**
 * 执行一次性迁移（不满足触发条件时返回 'skipped'，失败时返回 'failed' 并保留旧 key）
 *
 * :param adapter: 当前选中的存储适配器（localstorage 兜底时无需迁移，调用方已排除）
 * :return: 迁移结果
 */
export async function migrateLocalStorageBlob(adapter: StorageAdapter): Promise<MigrationResult> {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(LEGACY_STORAGE_KEY);
  } catch {
    return 'skipped'; // localStorage 不可用（隐私模式等），按无旧数据处理
  }
  if (!raw) return 'skipped';
  // 数据目录非空（已有新格式数据）时不迁移，避免覆盖
  if ((await adapter.readJson(STATE_FILE)) !== null) return 'skipped';
  if ((await adapter.readJson('index.json')) !== null) return 'skipped';

  try {
    const blob = JSON.parse(raw);
    // 1) 原样硬拷贝备份
    await adapter.writeJson(`migration-backup-${Date.now()}.json`, blob);
    // 2) 写入整包状态（Phase 2 起由启动流程拆分为三级文件）
    await adapter.writeJson(STATE_FILE, blob);
    // 3) 校验写入成功后删除旧 key，避免双数据源歧义（Q5）
    if ((await adapter.readJson(STATE_FILE)) === null) throw new Error('state.json 回读为空');
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    return 'migrated';
  } catch {
    return 'failed'; // 保留旧 key 不动，下次启动重试
  }
}
