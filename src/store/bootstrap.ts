/**
 * src/store/bootstrap.ts
 * v0.4 启动序列：适配器选择 → localStorage 迁移 → state.json 拆分 → 不变量自愈 → 装载三级 Manager。
 * 启动读 index + 各 project.json + session 文件（Phase 2 全量装载；懒加载属 Phase 3）。
 * 不变量自愈为每次启动执行，不依赖版本号（原 persist merge 逻辑平移）。
 */
import { getStorageAdapter } from '@/lib/storage/adapter';
import type { StorageAdapter } from '@/lib/storage/protocol';
import { migrateLocalStorageBlob, splitStateBlobToFiles } from '@/lib/storage/migrateToFiles';
import { RootManager } from './rootManager';
import { ProjectManager } from './projectManager';
import { SessionRuntime } from './sessionRuntime';
import { makeSession } from './factories';
import { DEFAULT_PROJECT_ID, IMPORT_PROJECT_ID, type ProjectData, type SessionData } from '@/types';

export interface BootResult {
  storage: StorageAdapter;
  root: RootManager;
  runtime: SessionRuntime;
  projects: Record<string, ProjectData>;
  activeProjectId: string;
  /** 非激活 Session（磁盘权威副本；激活 Session 的唯一权威在 runtime，无副本） */
  sessions: Record<string, SessionData>;
  active: SessionData;
}

/**
 * 执行启动序列
 *
 * :return: 三级 Manager 实例与首屏状态（供 useCanvasStore 一次性 set）
 */
export async function bootstrapCanvasStore(): Promise<BootResult> {
  const storage = await getStorageAdapter();
  // 1) 旧 localStorage → state.json（Phase 1 迁移；localstorage 兜底适配器同样走，统一出口）
  await migrateLocalStorageBlob(storage);
  // 2) state.json → 三级文件拆分（Phase 2 文件级迁移；index.json 存在则跳过）
  await splitStateBlobToFiles(storage);
  // 3) 装载 MBR（index.json 缺失时建默认注册表）
  const root = await RootManager.load(storage);
  // 4) 不变量自愈：固定项目存在且 pinned、项目文件夹 / project.json 存在、activeProjectId 有效
  await healProjects(storage, root);
  // 5) 全量装载 Session 文件（按文件夹归属为权威，projectId 字段不一致顺带自愈）
  const sessions: Record<string, SessionData> = {};
  for (const pid of root.projectIds) {
    const pm = await ProjectManager.load(storage, pid);
    if (!pm) continue;
    for (const sid of pm.sessionIds) {
      const sess = await pm.readSession(sid);
      if (!sess) continue;
      if (sess.projectId !== pid) {
        sess.projectId = pid;
        await pm.writeSession(sess);
      }
      sessions[sid] = sess;
    }
  }
  // 6) 激活 Session：项目 activeSessionId 优先，否则项目内最近编辑，空项目补空 Session
  const activePid = root.activeProjectId;
  const activePm = await ProjectManager.load(storage, activePid);
  let active: SessionData | null = null;
  const preferredSid = activePm?.activeSessionId;
  if (preferredSid && sessions[preferredSid]) {
    active = sessions[preferredSid];
  } else {
    const inProject = Object.values(sessions)
      .filter((s) => s.projectId === activePid)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    active = inProject[0] ?? null;
  }
  if (!active) {
    active = makeSession(activePid);
    if (activePm) {
      await activePm.writeSession(active);
      await activePm.registerSession(active.id, true);
    }
  }
  if (activePm && activePm.activeSessionId !== active.id) {
    await activePm.setActiveSession(active.id);
  }
  // 激活 Session 的唯一权威在 runtime，字典只放非激活 Session（无副本）
  delete sessions[active.id];

  const runtime = new SessionRuntime(storage, active);
  return {
    storage,
    root,
    runtime,
    projects: root.projects,
    activeProjectId: activePid,
    sessions,
    active,
  };
}

/**
 * 项目层不变量自愈（每次启动执行）
 *
 * :param storage: 存储适配器
 * :param root: 已装载的 RootManager
 */
async function healProjects(storage: StorageAdapter, root: RootManager): Promise<void> {
  // 固定项目「默认项目」/「导入的 Sessions」：不存在则重建，pinned 丢失则补回
  await root.ensurePinned(DEFAULT_PROJECT_ID, '默认项目');
  await root.ensurePinned(IMPORT_PROJECT_ID, '导入的 Sessions');
  // 注册表内项目的文件夹 / project.json 存在性
  const projects = root.projects;
  for (const pid of root.projectIds) {
    const pm = await ProjectManager.load(storage, pid);
    if (!pm) await ProjectManager.create(storage, projects[pid]);
  }
  // activeProjectId 有效
  if (!root.has(root.activeProjectId)) await root.setActiveProject(DEFAULT_PROJECT_ID);
}
