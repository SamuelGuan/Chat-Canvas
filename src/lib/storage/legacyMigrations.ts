/**
 * src/lib/storage/legacyMigrations.ts
 * 旧 localStorage 整包 blob（zustand persist 信封内 state）的版本号门控变换流水线（v0 → v3）。
 * 原 useCanvasStore persist.migrate 逻辑平移；仅用于 state.json 拆分为三级文件前的格式对齐。
 */
import { nanoid } from 'nanoid';
import { DEFAULT_PROJECT_ID, IMPORT_PROJECT_ID } from '@/types';

/**
 * 按 blob 版本依次执行迁移（越过的版本不再重跑，不变量兜底由启动自愈负责）
 *
 * :param state: persist 信封内的 state 部分（原地修改后返回）
 * :param version: persist 信封版本号
 * :return: 迁移后的 state（v3 结构）
 */
export function migrateLegacyBlob(state: any, version: number): any {
  if (version === 0) {
    // v0 -> v1: 更新各卡片中过时的模型名
    const MODEL_MAP: Record<string, string> = {
      'deepseek-chat': 'deepseek-v4-flash',
      'deepseek-reasoner': 'deepseek-v4-pro',
      'moonshot-v1-8k': 'kimi-k3',
      'moonshot-v1-128k': 'kimi-k2.6',
      'glm-4-flash': 'glm-5.2',
      'glm-4-plus': 'glm-5.1',
    };
    const migrateNodesInSession = (session: any) => {
      if (!session?.nodes) return;
      for (const nid of Object.keys(session.nodes)) {
        const node = session.nodes[nid];
        if (node?.model && MODEL_MAP[node.model]) node.model = MODEL_MAP[node.model];
      }
    };
    if (state.session) migrateNodesInSession(state.session);
    if (state.sessions) {
      for (const sid of Object.keys(state.sessions)) migrateNodesInSession(state.sessions[sid]);
    }
  }
  if (version < 2) {
    // v1 -> v2: 引入 Project，所有现存 Session 归入默认项目
    if (!state.projects || Object.keys(state.projects).length === 0) {
      const pid = nanoid(8);
      const now = Date.now();
      state.projects = { [pid]: { id: pid, name: '默认项目', createdAt: now, updatedAt: now } };
      state.activeProjectId = pid;
    }
    const pid = state.activeProjectId;
    if (state.sessions) {
      for (const s of Object.values(state.sessions) as any[]) {
        if (!s.projectId) s.projectId = pid;
      }
    }
    if (state.session && !state.session.projectId) state.session.projectId = pid;
  }
  if (version < 3) {
    // v2 -> v3: 默认项目与「导入的 Sessions」改为固定 ID + pinned 不可删除
    const now = Date.now();
    const projects = state.projects ?? {};
    // v2 迁移产生的默认项目是随机 id，需改挂到固定 id 并同步引用
    if (!projects[DEFAULT_PROJECT_ID]) {
      const legacy = Object.values(projects).find((p: any) => p?.name === '默认项目') as any;
      if (legacy) {
        const oldId = legacy.id;
        delete projects[oldId];
        projects[DEFAULT_PROJECT_ID] = { ...legacy, id: DEFAULT_PROJECT_ID, pinned: true };
        for (const s of Object.values(state.sessions ?? {}) as any[]) {
          if (s.projectId === oldId) s.projectId = DEFAULT_PROJECT_ID;
        }
        if (state.session?.projectId === oldId) state.session.projectId = DEFAULT_PROJECT_ID;
        if (state.activeProjectId === oldId) state.activeProjectId = DEFAULT_PROJECT_ID;
      } else {
        projects[DEFAULT_PROJECT_ID] = { id: DEFAULT_PROJECT_ID, name: '默认项目', pinned: true, createdAt: now, updatedAt: now };
      }
    } else {
      projects[DEFAULT_PROJECT_ID].pinned = true;
    }
    if (!projects[IMPORT_PROJECT_ID]) {
      projects[IMPORT_PROJECT_ID] = { id: IMPORT_PROJECT_ID, name: '导入的 Sessions', pinned: true, createdAt: now, updatedAt: now };
    } else {
      projects[IMPORT_PROJECT_ID].pinned = true;
    }
    state.projects = projects;
    if (!state.activeProjectId || !projects[state.activeProjectId]) {
      state.activeProjectId = DEFAULT_PROJECT_ID;
    }
  }
  return state;
}
