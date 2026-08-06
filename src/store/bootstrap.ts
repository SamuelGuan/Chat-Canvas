/**
 * src/store/bootstrap.ts
 * v0.4 启动序列：适配器选择 → localStorage 迁移 → state.json 拆分 → schema 落地
 * → 一致性校验收敛 → 装载三级 Manager（懒加载）。
 * 启动只读 index + 各 project.json + 激活 session 文件；其余 Session 以元信息 stub 入字典，
 * 切换/复制/导出时才读目标文件（v0.4 第 10 节）。
 */
import { getStorageAdapter } from '@/lib/storage/adapter';
import type { StorageAdapter } from '@/lib/storage/protocol';
import { migrateLocalStorageBlob, migrateSimulatedLocalStorage, splitStateBlobToFiles } from '@/lib/storage/migrateToFiles';
import { ensureSchemas } from '@/lib/storage/schemas';
import { reconcileData } from '@/lib/storage/consistency';
import { RootManager } from './rootManager';
import { ProjectManager } from './projectManager';
import { SessionRuntime } from './sessionRuntime';
import { makeSession } from './factories';
import { type ProjectData, type SessionData, type SessionMeta } from '@/types';

export interface BootResult {
  storage: StorageAdapter;
  root: RootManager;
  runtime: SessionRuntime;
  projects: Record<string, ProjectData>;
  activeProjectId: string;
  /** 非激活 Session 字典（元信息 stub：nodes/edges 为空，首次访问时按需读盘） */
  sessions: Record<string, SessionData>;
  /** stub 标记集合（字典中这些 id 的内容尚未装载） */
  stubIds: string[];
  active: SessionData;
}

/**
 * 由元信息构造懒加载 stub（仅列表展示用；内容首次访问时才读盘）
 *
 * :param sid: Session id
 * :param pid: 所属项目 id
 * :param meta: project.json 内的元信息缓存（缺失时以 sid 兜底名称）
 */
export function makeSessionStub(sid: string, pid: string, meta?: SessionMeta): SessionData {
  return {
    id: sid,
    name: meta?.name ?? sid,
    projectId: pid,
    createdAt: meta?.createdAt ?? 0,
    updatedAt: meta?.updatedAt ?? 0,
    nodes: {},
    edges: {},
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

/**
 * 执行启动序列
 *
 * :return: 三级 Manager 实例与首屏状态（供 useCanvasStore 一次性 set）
 */
export async function bootstrapCanvasStore(): Promise<BootResult> {
  const storage = await getStorageAdapter();
  // 1a) 旧 localStorage 整包 blob → state.json（Phase 1 迁移）
  await migrateLocalStorageBlob(storage);
  // 1b) localStorage 兜底期遗留的模拟文件（chat-canvas-data:* keys）→ 真实文件布局
  await migrateSimulatedLocalStorage(storage);
  // 2) state.json → 三级文件拆分（Phase 2 文件级迁移；index.json 存在则跳过）
  await splitStateBlobToFiles(storage);
  // 3) schema/ 落地（开放扩展位：Python / agent 的格式手册）
  await ensureSchemas(storage);
  // 4) 启动一致性校验（幂等收敛：索引剔除/挂载、sessionIds 剔除/收录、孤儿归拢、固定项目、激活指针）
  await reconcileData(storage);
  // 5) 装载 MBR
  const root = await RootManager.load(storage);
  // 6) 激活 Session：项目 activeSessionId 优先，否则项目内最近编辑（按元信息），空项目补空 Session
  const activePid = root.activeProjectId;
  const activePm = await ProjectManager.load(storage, activePid);
  let active: SessionData | null = null;
  if (activePm?.activeSessionId) {
    active = await activePm.readSession(activePm.activeSessionId);
  }
  if (!active && activePm) {
    const byRecent = Object.entries(activePm.sessionMetaMap).sort((a, b) => b[1].updatedAt - a[1].updatedAt);
    for (const [sid] of byRecent) {
      active = await activePm.readSession(sid);
      if (active) break;
    }
  }
  if (!active) {
    active = makeSession(activePid);
    if (activePm) {
      await activePm.writeSession(active);
      await activePm.registerSession(active.id, true, { name: active.name, createdAt: active.createdAt, updatedAt: active.updatedAt });
    }
  }
  if (activePm && activePm.activeSessionId !== active.id) {
    await activePm.setActiveSession(active.id);
  }
  // 7) 懒加载字典：其余 Session 一律 stub（仅激活 Session 读文件）
  const sessions: Record<string, SessionData> = {};
  const stubIds: string[] = [];
  for (const pid of root.projectIds) {
    const pm = await ProjectManager.load(storage, pid);
    if (!pm) continue;
    for (const sid of pm.sessionIds) {
      if (sid === active.id) continue;
      sessions[sid] = makeSessionStub(sid, pid, pm.getSessionMeta(sid));
      stubIds.push(sid);
    }
  }

  const runtime = new SessionRuntime(storage, active);
  return {
    storage,
    root,
    runtime,
    projects: root.projects,
    activeProjectId: activePid,
    sessions,
    stubIds,
    active,
  };
}
