/**
 * src/lib/storage/consistency.ts
 * 索引一致性校验（v0.4 第 9 节）：内存索引与磁盘两个事实来源的收敛。
 * 纯 StorageAdapter 实现（不触 fs），渲染层启动自愈 / check-data CLI / 文件监听三方共用
 * —— 这是"多写者"模式（agent / Python sidecar 直改文件）的安全网。
 *
 * 收敛规则：
 * | index.json 的项目 vs projects/ 实际文件夹 | 索引有、磁盘无 → 从索引剔除 |
 * |                                           | 磁盘有、索引无 → 读 project.json 收录进索引（挂载未登记的 PBR） |
 * | project.json 的 sessionIds vs sessions/ 实际文件 | 登记有、磁盘无 → 剔除 |
 * |                                             | 磁盘有、未登记 → 收录 |
 * | 固定项目 | proj_default / proj_imported 缺失或 pinned 丢失 → 重建/补回 |
 * | 孤儿 Session 文件 | 所在文件夹无 project.json → 移动到 proj_imported |
 *
 * 幂等：无差异时不产生任何写盘。
 */
import type { StorageAdapter } from './protocol';
import { INDEX_FILE, projectDir, projectFilePath, sessionFilePath } from './paths';
// 注意：本模块会被 vite.config.ts / Electron 主进程打包（其打包器不解析 '@' 别名），只能用相对路径导入
import {
  DEFAULT_PROJECT_ID,
  IMPORT_PROJECT_ID,
  STORE_FILE_VERSION,
  type ProjectFile,
  type ProjectMeta,
  type RootIndex,
  type SessionFile,
  type SessionMeta,
} from '../../types';

/** 校验报告（CLI 打印 / 调试用） */
export interface ReconcileReport {
  /** 索引有、磁盘无 → 从索引剔除的项目 */
  projectsRemoved: string[];
  /** 磁盘有、索引无 → 收录进索引的项目 */
  projectsAdded: string[];
  /** 登记有、磁盘无 → 从 sessionIds 剔除（'pid/sid'） */
  sessionsRemoved: string[];
  /** 磁盘有、未登记 → 收录进 sessionIds（'pid/sid'） */
  sessionsAdded: string[];
  /** 孤儿 Session 文件 → 移动到 proj_imported（'pid/sid'） */
  sessionsMoved: string[];
  /** 固定项目重建 / pinned 补回 */
  pinnedFixed: string[];
  /** sessionMeta 重建过元信息缓存的 Session（'pid/sid'） */
  metaRebuilt: string[];
}

function emptyReport(): ReconcileReport {
  return { projectsRemoved: [], projectsAdded: [], sessionsRemoved: [], sessionsAdded: [], sessionsMoved: [], pinnedFixed: [], metaRebuilt: [] };
}

function makePinnedMeta(pid: string, name: string): ProjectMeta {
  const now = Date.now();
  return { id: pid, name, pinned: true, createdAt: now, updatedAt: now };
}

/**
 * 执行一致性校验收敛（幂等）
 *
 * :param adapter: 存储适配器（渲染层为运行时适配器，CLI/监听为 Node fs 适配器）
 * :return: 校验报告
 */
export async function reconcileData(adapter: StorageAdapter): Promise<ReconcileReport> {
  const report = emptyReport();
  const now = Date.now();

  // ---------- 1) 根索引装载（缺失则建默认） ----------
  let index = (await adapter.readJson(INDEX_FILE)) as RootIndex | null;
  let indexDirty = false;
  if (!index) {
    index = {
      version: STORE_FILE_VERSION,
      activeProjectId: DEFAULT_PROJECT_ID,
      projects: [makePinnedMeta(DEFAULT_PROJECT_ID, '默认项目'), makePinnedMeta(IMPORT_PROJECT_ID, '导入的 Sessions')],
    };
    indexDirty = true;
    report.pinnedFixed.push(DEFAULT_PROJECT_ID, IMPORT_PROJECT_ID);
  }

  // ---------- 2) 固定项目不变量：存在且 pinned ----------
  for (const [pid, pname] of [[DEFAULT_PROJECT_ID, '默认项目'], [IMPORT_PROJECT_ID, '导入的 Sessions']] as const) {
    const meta = index.projects.find((p) => p.id === pid);
    if (!meta) {
      index.projects.push(makePinnedMeta(pid, pname));
      indexDirty = true;
      report.pinnedFixed.push(pid);
    } else if (!meta.pinned) {
      meta.pinned = true;
      indexDirty = true;
      report.pinnedFixed.push(pid);
    }
  }

  // ---------- 3) index 项目 vs projects/ 实际文件夹 ----------
  const diskPids = (await adapter.list('projects')).filter((name) => name !== '.gitkeep');
  const indexedPids = new Set(index.projects.map((p) => p.id));

  // 索引有、磁盘无 → 从索引剔除（数据已丢，引用无意义）
  const kept = index.projects.filter((p) => diskPids.includes(p.id));
  for (const p of index.projects) {
    if (!diskPids.includes(p.id)) report.projectsRemoved.push(p.id);
  }
  if (kept.length !== index.projects.length) {
    index.projects = kept;
    indexDirty = true;
  }

  // 磁盘有、索引无 → 挂载未登记的 PBR / 孤儿归拢
  for (const pid of diskPids) {
    if (indexedPids.has(pid)) continue;
    const pj = (await adapter.readJson(projectFilePath(pid))) as ProjectFile | null;
    if (pj) {
      // 外部拷入的完整项目：收录进索引
      index.projects.push({ id: pid, name: pj.name ?? pid, createdAt: now, updatedAt: now });
      indexDirty = true;
      report.projectsAdded.push(pid);
    } else {
      // 无 project.json 的文件夹：其中 Session 文件视为孤儿，移动到 proj_imported
      const orphanFiles = (await adapter.list(`${projectDir(pid)}/sessions`)).filter((f) => f.endsWith('.json'));
      for (const f of orphanFiles) {
        const sid = f.replace(/\.json$/, '');
        const sf = (await adapter.readJson(`${projectDir(pid)}/sessions/${f}`)) as SessionFile | null;
        if (!sf) continue;
        const { version: _v, ...session } = sf;
        const moved: SessionFile = { ...session, projectId: IMPORT_PROJECT_ID, version: STORE_FILE_VERSION };
        await adapter.writeJson(sessionFilePath(IMPORT_PROJECT_ID, sid), moved);
        await adapter.delete(`${projectDir(pid)}/sessions/${f}`);
        report.sessionsMoved.push(`${pid}/${sid}`);
      }
      // 文件夹本体保守保留（可能含 assets/ 等未知内容），不收录索引
    }
  }

  // ---------- 4) 每个项目：sessionIds vs sessions/ 实际文件 ----------
  for (const meta of index.projects) {
    const pid = meta.id;
    let pj = (await adapter.readJson(projectFilePath(pid))) as ProjectFile | null;
    let dirty = false;
    if (!pj) {
      pj = { version: STORE_FILE_VERSION, id: pid, name: meta.name, activeSessionId: null, sessionIds: [] };
      dirty = true;
    }

    const diskSids = (await adapter.list(`${projectDir(pid)}/sessions`))
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''));
    const diskSet = new Set(diskSids);
    const registeredSet = new Set(pj.sessionIds);

    // 登记有、磁盘无 → 剔除
    const keptSids = pj.sessionIds.filter((sid) => {
      if (diskSet.has(sid)) return true;
      report.sessionsRemoved.push(`${pid}/${sid}`);
      dirty = true;
      return false;
    });
    pj.sessionIds = keptSids;
    // 磁盘有、未登记 → 收录
    for (const sid of diskSids) {
      if (!registeredSet.has(sid)) {
        pj.sessionIds.push(sid);
        report.sessionsAdded.push(`${pid}/${sid}`);
        dirty = true;
      }
    }
    // sessionMeta 缓存重建（仅对缺失项读文件，保住启动懒加载）
    pj.sessionMeta ??= {};
    for (const sid of Object.keys(pj.sessionMeta)) {
      if (!pj.sessionIds.includes(sid)) {
        delete pj.sessionMeta[sid];
        dirty = true;
      }
    }
    for (const sid of pj.sessionIds) {
      const existing = pj.sessionMeta[sid];
      if (existing && typeof existing.name === 'string' && typeof existing.createdAt === 'number') continue;
      const sf = (await adapter.readJson(sessionFilePath(pid, sid))) as SessionFile | null;
      if (!sf) continue;
      const metaRebuild: SessionMeta = { name: sf.name ?? sid, createdAt: sf.createdAt ?? now, updatedAt: sf.updatedAt ?? now };
      pj.sessionMeta[sid] = metaRebuild;
      report.metaRebuilt.push(`${pid}/${sid}`);
      dirty = true;
    }
    // activeSessionId 有效（无效置空，由启动流程按最近编辑补）
    if (pj.activeSessionId && !pj.sessionIds.includes(pj.activeSessionId)) {
      pj.activeSessionId = null;
      dirty = true;
    }
    if (dirty) await adapter.writeJson(projectFilePath(pid), pj);
  }

  // ---------- 5) activeProjectId 有效 ----------
  if (!index.projects.some((p) => p.id === index!.activeProjectId)) {
    index.activeProjectId = DEFAULT_PROJECT_ID;
    indexDirty = true;
  }
  if (indexDirty) await adapter.writeJson(INDEX_FILE, index);

  return report;
}
