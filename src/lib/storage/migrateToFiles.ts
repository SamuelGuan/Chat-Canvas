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
import { INDEX_FILE, projectFilePath, sessionFilePath } from './paths';
import { migrateLegacyBlob } from './legacyMigrations';
import {
  DEFAULT_PROJECT_ID,
  IMPORT_PROJECT_ID,
  STORE_FILE_VERSION,
  type ProjectData,
  type ProjectFile,
  type RootIndex,
  type SessionData,
  type SessionFile,
} from '@/types';

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

/**
 * Phase 2 文件级迁移：state.json 整包 blob → index/project/session 三级文件（一次性）。
 * 触发条件：index.json 不存在且 state.json 存在。
 * 流程：原 blob 硬备份（state.blob-backup.json）→ v0→v3 blob 变换流水线 → 按 v3 结构拆分写盘
 * （固定项目补齐、孤儿 Session 归拢 proj_imported 顺带执行）→ 删除 state.json。
 *
 * :param adapter: 当前存储适配器
 * :return: 是否执行了拆分
 */
export async function splitStateBlobToFiles(adapter: StorageAdapter): Promise<boolean> {
  if ((await adapter.readJson(INDEX_FILE)) !== null) return false;
  const blob = (await adapter.readJson(STATE_FILE)) as { state?: any; version?: number } | null;
  if (!blob) return false;

  const state = migrateLegacyBlob(blob.state ?? {}, blob.version ?? 0);
  // 激活快照与 sessions 字典合并（激活快照更新）
  const sessions: Record<string, SessionData> = { ...(state.sessions ?? {}) };
  if (state.session?.id) sessions[state.session.id] = state.session;
  const projects: Record<string, ProjectData> = { ...(state.projects ?? {}) };
  // 固定项目补齐（拆分过程顺带执行的不变量，保证孤儿有处可归）
  const now = Date.now();
  if (!projects[DEFAULT_PROJECT_ID]) {
    projects[DEFAULT_PROJECT_ID] = { id: DEFAULT_PROJECT_ID, name: '默认项目', pinned: true, createdAt: now, updatedAt: now };
  } else {
    projects[DEFAULT_PROJECT_ID].pinned = true;
  }
  if (!projects[IMPORT_PROJECT_ID]) {
    projects[IMPORT_PROJECT_ID] = { id: IMPORT_PROJECT_ID, name: '导入的 Sessions', pinned: true, createdAt: now, updatedAt: now };
  } else {
    projects[IMPORT_PROJECT_ID].pinned = true;
  }
  // 孤儿 Session（projectId 指向已不存在的项目）归拢 proj_imported
  for (const s of Object.values(sessions)) {
    if (!projects[s.projectId]) s.projectId = IMPORT_PROJECT_ID;
  }
  const activeProjectId: string = projects[state.activeProjectId] ? state.activeProjectId : DEFAULT_PROJECT_ID;
  const activeSessionId: string | undefined = state.activeSessionId;

  // 1) 原 blob 原样硬备份
  await adapter.writeJson('state.blob-backup.json', blob);
  // 2) 项目：project.json（sessionIds 从 sessions 字典归纳）
  for (const p of Object.values(projects)) {
    const sessionIds = Object.values(sessions).filter((s) => s.projectId === p.id).map((s) => s.id);
    const file: ProjectFile = {
      version: STORE_FILE_VERSION,
      id: p.id,
      name: p.name,
      activeSessionId: p.id === activeProjectId ? activeSessionId ?? null : null,
      sessionIds,
    };
    await adapter.writeJson(projectFilePath(p.id), file);
  }
  // 3) Session 文件
  for (const s of Object.values(sessions)) {
    const file: SessionFile = { ...s, version: STORE_FILE_VERSION };
    await adapter.writeJson(sessionFilePath(s.projectId, s.id), file);
  }
  // 4) 根索引
  const index: RootIndex = {
    version: STORE_FILE_VERSION,
    activeProjectId,
    projects: Object.values(projects),
  };
  await adapter.writeJson(INDEX_FILE, index);
  // 5) 校验根索引可读后删除原 blob
  if ((await adapter.readJson(INDEX_FILE)) === null) throw new Error('index.json 回读为空');
  await adapter.delete(STATE_FILE);
  return true;
}
