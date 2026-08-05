/**
 * src/store/useCanvasStore.ts
 * 画布状态管理：v0.4 Phase 2 —— 两级 Manager（MBR/PBR 分层）+ SessionRuntime 重构。
 *
 * 与 v0.3 的差异：
 * - session + sessions 字典双份状态 → SessionRuntime 是激活 Session 的唯一权威状态（无副本）；
 *   state.sessions 只放非激活 Session（磁盘权威副本），UI 取全量列表用 [session, ...Object.values(sessions)]
 * - undo 历史在全局 store → undo 栈挂在 SessionRuntime 上，随实例销毁自然清理
 * - zustand persist 单 blob → 三级文件落盘（index.json / project.json / sessions/<sid>.json）
 *
 * 落盘策略：SessionRuntime 内容变化防抖 500ms 写本 session 文件；元数据变化立即写对应 json。
 * 动作保持同步签名（UI 零改动），文件写后台串行执行，失败由下次启动自愈/校验兜底。
 */
import { create } from 'zustand';
import { nanoid } from 'nanoid';
import { GraphNode, GraphEdge, SessionData, ProjectData, CanvasViewport, DEFAULT_PROJECT_ID, IMPORT_PROJECT_ID } from '@/types';
import { useSettingsStore } from '@/store/useSettingsStore';
import { cloneSession, sessionContentHash } from '@/lib/utils';
import type { StorageAdapter } from '@/lib/storage/protocol';
import { projectDir } from '@/lib/storage/paths';
import { RootManager } from '@/store/rootManager';
import { ProjectManager } from '@/store/projectManager';
import { SessionRuntime } from '@/store/sessionRuntime';
import { bootstrapCanvasStore } from '@/store/bootstrap';
import { makeProject, makeSession } from '@/store/factories';

/* ===== 三级 Manager 实例（非响应式，bootstrap 后可用） ===== */
let storage: StorageAdapter | null = null;
let root: RootManager | null = null;
let runtime: SessionRuntime | null = null;

function mustStorage(): StorageAdapter {
  if (!storage) throw new Error('存储层未初始化（bootstrap 未完成）');
  return storage;
}
function mustRoot(): RootManager {
  if (!root) throw new Error('RootManager 未初始化（bootstrap 未完成）');
  return root;
}
function mustRuntime(): SessionRuntime {
  if (!runtime) throw new Error('SessionRuntime 未初始化（bootstrap 未完成）');
  return runtime;
}

/** 后台落盘任务串行执行（保证 create → register 等顺序）；失败仅记录，权威状态 = 磁盘 + 校验收敛 */
let bgQueue: Promise<void> = Promise.resolve();
function bg(task: () => Promise<unknown>): void {
  bgQueue = bgQueue.then(async () => { await task(); }).catch((e) => console.error('[store] 后台落盘失败', e));
}

/** 装载项目 Manager（不存在则按 state.projects 元数据创建） */
async function ensureProjectManager(pid: string): Promise<ProjectManager> {
  const pm = await ProjectManager.load(mustStorage(), pid);
  if (pm) return pm;
  const meta = useCanvasStore.getState().projects[pid] ?? makeProject('默认项目', pid, pid === DEFAULT_PROJECT_ID || pid === IMPORT_PROJECT_ID);
  return ProjectManager.create(mustStorage(), meta);
}

interface CanvasState {
  session: SessionData;
  sessions: Record<string, SessionData>;    // ★ 非激活 Session 字典（磁盘权威副本，不含激活 Session）
  activeSessionId: string;
  projects: Record<string, ProjectData>;
  activeProjectId: string;
  selectedNodeId: string | null;
  assembleMode: boolean;
  assembleNodeIds: string[];

  // ===== 启动 =====
  bootstrap: () => Promise<void>;

  // ===== 节点 =====
  addNode: (position: { x: number; y: number }, title?: string, model?: string) => string;
  updateNode: (id: string, patch: Partial<GraphNode>) => void;
  deleteNode: (id: string) => void;
  duplicateNode: (id: string, offsetX?: number, offsetY?: number) => string | null;
  setSelectedNode: (id: string | null) => void;

  // ===== 边 =====
  addEdge: (source: string, target: string, edgeType?: 'inherit' | 'reference', label?: string) => string;
  updateEdge: (id: string, patch: Partial<GraphEdge>) => void;
  deleteEdge: (id: string) => void;

  // ===== 视口 =====
  setViewport: (vp: CanvasViewport) => void;

  // ===== 撤销/重做 =====
  undo: () => void;
  redo: () => void;

  // ===== Session =====
  loadSession: (data: SessionData) => void;
  switchSession: (id: string) => void;
  createSession: (name?: string, projectId?: string) => string;
  renameSession: (id: string, name: string) => void;
  deleteSession: (id: string) => void;
  duplicateSession: (id: string) => string;
  exportSessionJson: (sessionId?: string) => string;
  importSessions: (data: unknown) => Promise<{ imported: number; skipped: number }>;

  // ===== Project =====
  createProject: (name?: string) => string;
  renameProject: (id: string, name: string) => void;
  deleteProject: (id: string) => void;
  switchProject: (id: string) => void;

  // ===== 拼装 =====
  toggleAssembleMode: () => void;
  addToAssemble: (nodeId: string) => void;
  removeFromAssemble: (nodeId: string) => void;
  clearAssemble: () => void;
}

export const useCanvasStore = create<CanvasState>()((set, get) => {
  const initProject = makeProject('默认项目', DEFAULT_PROJECT_ID, true);
  const importProject = makeProject('导入的 Sessions', IMPORT_PROJECT_ID, true);
  const initSession = makeSession(initProject.id);

  /** 卸载当前 runtime：先落盘再丢弃（切换 Session/项目时的统一步骤） */
  const unloadRuntime = (): SessionData => {
    const old = mustRuntime();
    bg(() => old.flush());
    old.dispose();
    return old.session;
  };

  /** 换装激活 Session：旧实例落盘卸载，新实例驻留，字典只留非激活 Session */
  const activateSession = (target: SessionData, extraSessions: Record<string, SessionData> = {}) => {
    const oldSession = unloadRuntime();
    const rt = new SessionRuntime(mustStorage(), cloneSession(target));
    runtime = rt;
    set((s) => {
      const sessions = { ...s.sessions, ...extraSessions };
      delete sessions[target.id];
      sessions[oldSession.id] = oldSession;
      return { session: rt.session, sessions, activeSessionId: target.id, activeProjectId: target.projectId, selectedNodeId: null };
    });
    bg(async () => {
      const pm = await ensureProjectManager(target.projectId);
      await pm.setActiveSession(target.id);
      if (target.projectId !== get().activeProjectId) await mustRoot().setActiveProject(target.projectId);
    });
  };

  return {
    session: initSession,
    sessions: {},
    activeSessionId: initSession.id,
    projects: { [initProject.id]: initProject, [importProject.id]: importProject },
    activeProjectId: initProject.id,
    selectedNodeId: null,
    assembleMode: false,
    assembleNodeIds: [],

    // -------------------- 启动 --------------------

    bootstrap: async () => {
      const result = await bootstrapCanvasStore();
      storage = result.storage;
      root = result.root;
      runtime = result.runtime;
      set({
        session: result.active,
        sessions: result.sessions,
        activeSessionId: result.active.id,
        projects: result.projects,
        activeProjectId: result.activeProjectId,
        selectedNodeId: null,
      });
    },

    // -------------------- 节点 --------------------

    addNode: (position, title, model) => {
      const rt = mustRuntime();
      const id = nanoid(8);
      const now = Date.now();
      const node: GraphNode = {
        id, type: 'chat', position,
        title: title ?? `对话 ${Object.keys(rt.session.nodes).length + 1}`,
        model: model ?? useSettingsStore.getState().defaultModel,
        collapsed: false,
        messages: [],
        createdAt: now,
        updatedAt: now,
      };
      const session = cloneSession(rt.session);
      session.nodes[id] = node;
      session.updatedAt = now;
      rt.commit(session);
      set({ session: rt.session, selectedNodeId: id });
      return id;
    },

    updateNode: (id, patch) => {
      const rt = mustRuntime();
      if (!rt.session.nodes[id]) return;
      const session = cloneSession(rt.session);
      session.nodes[id] = { ...session.nodes[id], ...patch, updatedAt: Date.now() };
      session.updatedAt = Date.now();
      rt.commit(session);
      set({ session: rt.session });
    },

    deleteNode: (id) => {
      const rt = mustRuntime();
      const session = cloneSession(rt.session);
      delete session.nodes[id];
      for (const eid of Object.keys(session.edges)) {
        const e = session.edges[eid];
        if (e.source === id || e.target === id) delete session.edges[eid];
      }
      session.updatedAt = Date.now();
      rt.commit(session);
      set((s) => ({ session: rt.session, selectedNodeId: s.selectedNodeId === id ? null : s.selectedNodeId }));
    },

    duplicateNode: (id, offsetX = 40, offsetY = 40) => {
      const rt = mustRuntime();
      const src = rt.session.nodes[id];
      if (!src) return null;
      const newId = nanoid(8);
      const now = Date.now();
      const copy: GraphNode = {
        ...JSON.parse(JSON.stringify(src)),
        id: newId,
        position: { x: src.position.x + offsetX, y: src.position.y + offsetY },
        title: `${src.title} (副本)`,
        createdAt: now,
        updatedAt: now,
      };
      const session = cloneSession(rt.session);
      session.nodes[newId] = copy;
      session.updatedAt = now;
      rt.commit(session);
      set({ session: rt.session, selectedNodeId: newId });
      return newId;
    },

    setSelectedNode: (id) => set({ selectedNodeId: id }),

    // -------------------- 边 --------------------

    addEdge: (source, target, edgeType = 'inherit', label) => {
      const rt = mustRuntime();
      if (source === target) return '';
      const existing = Object.values(rt.session.edges).find((e) => e.source === source && e.target === target);
      if (existing) return existing.id;
      const id = nanoid(8);
      const edge: GraphEdge = { id, source, target, edgeType, label };
      const session = cloneSession(rt.session);
      session.edges[id] = edge;
      session.updatedAt = Date.now();
      rt.commit(session);
      set({ session: rt.session });
      return id;
    },

    updateEdge: (id, patch) => {
      const rt = mustRuntime();
      if (!rt.session.edges[id]) return;
      const session = cloneSession(rt.session);
      session.edges[id] = { ...session.edges[id], ...patch };
      session.updatedAt = Date.now();
      rt.commit(session);
      set({ session: rt.session });
    },

    deleteEdge: (id) => {
      const rt = mustRuntime();
      const session = cloneSession(rt.session);
      delete session.edges[id];
      session.updatedAt = Date.now();
      rt.commit(session);
      set({ session: rt.session });
    },

    // -------------------- 视口 --------------------

    setViewport: (vp) => {
      const rt = mustRuntime();
      const session = cloneSession(rt.session);
      session.viewport = vp;
      session.updatedAt = Date.now();
      rt.commit(session, { history: false });
      set({ session: rt.session });
    },

    // -------------------- 撤销/重做 --------------------

    undo: () => {
      const rt = mustRuntime();
      if (rt.undo()) set({ session: rt.session });
    },

    redo: () => {
      const rt = mustRuntime();
      if (rt.redo()) set({ session: rt.session });
    },

    // -------------------- Session --------------------

    loadSession: (data) => {
      const s = get();
      // projectId 失效归拢「导入的 Sessions」（原 merge 不变量平移）
      const pid = s.projects[data.projectId] ? data.projectId : IMPORT_PROJECT_ID;
      const session = { ...data, projectId: pid };
      activateSession(session);
      bg(async () => {
        const pm = await ensureProjectManager(pid);
        await pm.writeSession(session);
        await pm.registerSession(session.id, true);
      });
    },

    switchSession: (id) => {
      const s = get();
      // ★ 点击当前激活 Session 不做任何操作
      if (id === s.activeSessionId) return;
      const target = s.sessions[id];
      if (!target) return;
      activateSession(target);
    },

    createSession: (name, projectId) => {
      const s = get();
      const pid = projectId ?? s.activeProjectId;
      // 自动命名需避开已有名称（含激活 Session；删除中间项后 总数+1 会撞名）
      let autoName = name;
      if (!autoName) {
        const names = new Set([s.session, ...Object.values(s.sessions)].map((x) => x.name));
        let n = Object.keys(s.sessions).length + 2; // 字典不含激活 Session，+1 激活 +1 新建
        autoName = `Session ${n}`;
        while (names.has(autoName)) autoName = `Session ${++n}`;
      }
      const session = makeSession(pid, undefined, autoName);
      // ★ 新建 Session 时自动附带一个会话卡片
      const nodeId = nanoid(8);
      const now = Date.now();
      session.nodes[nodeId] = {
        id: nodeId, type: 'chat',
        position: { x: 400, y: 300 },
        title: '对话 1',
        model: useSettingsStore.getState().defaultModel,
        collapsed: false,
        messages: [],
        createdAt: now,
        updatedAt: now,
      };
      const oldSession = unloadRuntime();
      runtime = new SessionRuntime(mustStorage(), session);
      set((prev) => ({
        session,
        sessions: { ...prev.sessions, [oldSession.id]: oldSession },
        activeSessionId: session.id,
        activeProjectId: pid,
        selectedNodeId: nodeId,
      }));
      bg(async () => {
        const pm = await ensureProjectManager(pid);
        await pm.writeSession(session);
        await pm.registerSession(session.id, true);
        if (pid !== s.activeProjectId) await mustRoot().setActiveProject(pid);
      });
      return session.id;
    },

    renameSession: (id, name) => {
      const s = get();
      if (s.session.id === id) {
        const rt = mustRuntime();
        rt.commit({ ...rt.session, name }, { history: false, immediate: true });
        set({ session: rt.session });
        return;
      }
      const target = s.sessions[id];
      if (!target) return;
      const renamed = { ...target, name };
      set({ sessions: { ...s.sessions, [id]: renamed } });
      bg(async () => {
        const pm = await ensureProjectManager(target.projectId);
        await pm.writeSession(renamed);
      });
    },

    deleteSession: (id) => {
      const s = get();
      const target = id === s.session.id ? s.session : s.sessions[id];
      if (!target) return;
      bg(async () => {
        const pm = await ProjectManager.load(mustStorage(), target.projectId);
        if (pm) {
          await pm.unregisterSession(id);
          await pm.deleteSessionFile(id);
        }
      });
      if (id !== s.session.id) {
        const sessions = { ...s.sessions };
        delete sessions[id];
        set({ sessions });
        return;
      }
      // 删除的是激活 Session：旧实例直接丢弃（不落盘），切到剩余中最近编辑的
      mustRuntime().dispose();
      const rest = Object.values(s.sessions).sort((a, b) => b.updatedAt - a.updatedAt);
      if (rest.length === 0) {
        // 全部删光：在激活项目补一个空 Session
        const fresh = makeSession(s.activeProjectId);
        runtime = new SessionRuntime(mustStorage(), fresh);
        set({ session: fresh, sessions: {}, activeSessionId: fresh.id, selectedNodeId: null });
        bg(async () => {
          const pm = await ensureProjectManager(s.activeProjectId);
          await pm.writeSession(fresh);
          await pm.registerSession(fresh.id, true);
        });
        return;
      }
      const next = rest[0];
      const sessions = { ...s.sessions };
      delete sessions[next.id];
      runtime = new SessionRuntime(mustStorage(), cloneSession(next));
      set({ session: runtime.session, sessions, activeSessionId: next.id, activeProjectId: next.projectId, selectedNodeId: null });
      bg(async () => {
        const pm = await ensureProjectManager(next.projectId);
        await pm.setActiveSession(next.id);
        if (next.projectId !== s.activeProjectId) await mustRoot().setActiveProject(next.projectId);
      });
    },

    duplicateSession: (id) => {
      const s = get();
      // 激活态取 session（runtime 权威），非激活态取字典（磁盘权威副本），均不会过期
      const src = id === s.session.id ? s.session : s.sessions[id];
      if (!src) return '';
      const newId = nanoid(8);
      const now = Date.now();
      const copy = cloneSession(src);
      copy.id = newId;
      copy.name = `${src.name} (副本)`;
      // 副本按创建时间倒序应排在顶部，时间戳需刷新
      copy.createdAt = now;
      copy.updatedAt = now;
      set({ sessions: { ...s.sessions, [newId]: copy } });
      bg(async () => {
        const pm = await ensureProjectManager(copy.projectId);
        await pm.writeSession(copy);
        await pm.registerSession(newId);
      });
      return newId;
    },

    // -------------------- Project --------------------

    createProject: (name) => {
      const id = nanoid(8);
      const now = Date.now();
      const project: ProjectData = {
        id,
        name: name ?? `项目 ${Object.keys(get().projects).length + 1}`,
        createdAt: now,
        updatedAt: now,
      };
      set((s) => ({ projects: { ...s.projects, [id]: project } }));
      bg(async () => {
        await ProjectManager.create(mustStorage(), project);
        await mustRoot().addProject(project);
      });
      // 切到新项目（空项目由 switchProject 自动补一个 Session）
      get().switchProject(id);
      return id;
    },

    renameProject: (id, name) => {
      const s = get();
      if (!s.projects[id]) return;
      set({ projects: { ...s.projects, [id]: { ...s.projects[id], name, updatedAt: Date.now() } } });
      bg(async () => {
        await mustRoot().renameProject(id, name);
        const pm = await ProjectManager.load(mustStorage(), id);
        await pm?.renameProject(name);
      });
    },

    switchProject: (id) => {
      const s = get();
      if (id === s.activeProjectId || !s.projects[id]) return;
      // 目标项目中最近编辑的 Session（含激活 Session 参与比较）
      const candidates = [s.session, ...Object.values(s.sessions)]
        .filter((sess) => sess.projectId === id)
        .sort((a, b) => b.updatedAt - a.updatedAt);
      if (candidates.length === 0) {
        // 空项目：先切项目再走 createSession（自动附带卡片）
        set({ activeProjectId: id });
        bg(() => mustRoot().setActiveProject(id));
        get().createSession();
        return;
      }
      const target = candidates[0];
      if (target.id === s.session.id) {
        // 激活 Session 本就在目标项目（防御分支：不变量下不发生）
        set({ activeProjectId: id });
        bg(() => mustRoot().setActiveProject(id));
        return;
      }
      activateSession(target);
    },

    deleteProject: (id) => {
      const s = get();
      const meta = s.projects[id];
      // ★ 固定项目（默认项目/导入的 Sessions）不可删除
      if (!meta || meta.pinned) return;
      const deletingActive = s.activeProjectId === id;
      if (deletingActive) mustRuntime().dispose(); // 被删项目的激活实例直接丢弃（不落盘）
      bg(async () => {
        await mustRoot().removeProject(id);
        await mustStorage().delete(projectDir(id));
      });
      const projects = { ...s.projects };
      delete projects[id];
      const sessions: Record<string, SessionData> = {};
      for (const [sid, sess] of Object.entries(s.sessions)) {
        if (sess.projectId !== id) sessions[sid] = sess;
      }
      if (!deletingActive) {
        set({ projects, sessions });
        return;
      }
      // 删除的是当前项目：切到剩余最近更新的项目（固定项目不变量保证其存在）
      const nextProject = Object.values(projects).sort((a, b) => b.updatedAt - a.updatedAt)[0];
      const inProject = Object.values(sessions)
        .filter((x) => x.projectId === nextProject.id)
        .sort((a, b) => b.updatedAt - a.updatedAt);
      if (inProject.length > 0) {
        const target = inProject[0];
        const sessions2 = { ...sessions };
        delete sessions2[target.id];
        runtime = new SessionRuntime(mustStorage(), cloneSession(target));
        set({ projects, sessions: sessions2, session: runtime.session, activeSessionId: target.id, activeProjectId: nextProject.id, selectedNodeId: null });
        bg(async () => {
          await mustRoot().setActiveProject(nextProject.id);
          const pm = await ensureProjectManager(nextProject.id);
          await pm.setActiveSession(target.id);
        });
      } else {
        const fresh = makeSession(nextProject.id);
        runtime = new SessionRuntime(mustStorage(), fresh);
        set({ projects, sessions, session: fresh, activeSessionId: fresh.id, activeProjectId: nextProject.id, selectedNodeId: null });
        bg(async () => {
          await mustRoot().setActiveProject(nextProject.id);
          const pm = await ensureProjectManager(nextProject.id);
          await pm.writeSession(fresh);
          await pm.registerSession(fresh.id, true);
        });
      }
    },

    exportSessionJson: (sessionId) => {
      const s = get();
      // 全量视图在导出时临时合成（只读，不是一致性补丁）
      const sessions = { ...s.sessions, [s.session.id]: s.session };
      if (sessionId) {
        return JSON.stringify(sessions[sessionId] ?? s.session, null, 2);
      }
      return JSON.stringify({ sessions, activeSessionId: s.activeSessionId }, null, 2);
    },

    importSessions: async (data) => {
      const state = get();
      // 兼容两种导出格式：完整备份 {sessions, activeSessionId} 或单个 SessionData
      const d = data as Partial<SessionData> & { sessions?: Record<string, SessionData>; activeSessionId?: string };
      let incoming: SessionData[];
      const incomingActiveId = d.activeSessionId ?? null;
      if (d.sessions && typeof d.sessions === 'object') {
        incoming = Object.values(d.sessions);
      } else if (d.id && d.nodes) {
        incoming = [d as SessionData];
      } else {
        throw new Error('无法识别的 Session 文件格式');
      }

      // 现有 Session 内容哈希集合（激活 + 非激活，均权威）
      const existingSessions: Record<string, SessionData> = { ...state.sessions, [state.session.id]: state.session };
      const existingHashes = new Set<string>();
      for (const s of Object.values(existingSessions)) {
        existingHashes.add(await sessionContentHash(s));
      }

      let imported = 0;
      let skipped = 0;
      const toAdd: Record<string, SessionData> = {};
      for (const raw of incoming) {
        if (!raw?.id || !raw.nodes) { skipped++; continue; }
        const hash = await sessionContentHash(raw);
        // ★ SHA-256 内容哈希相同则忽略，避免重复导入造成覆盖
        if (existingHashes.has(hash)) { skipped++; continue; }
        const session = cloneSession(raw);
        // ★ 导入的 Session 统一归入「导入的 Sessions」固定项目
        session.projectId = IMPORT_PROJECT_ID;
        // id 冲突但内容不同：换新 id 并存，避免覆盖现有 Session
        if (existingSessions[session.id] || toAdd[session.id]) {
          session.id = nanoid(8);
          session.name = `${session.name} (导入)`;
        }
        existingHashes.add(hash);
        toAdd[session.id] = session;
        imported++;
      }

      if (imported > 0) {
        const importMeta = state.projects[IMPORT_PROJECT_ID] ?? makeProject('导入的 Sessions', IMPORT_PROJECT_ID, true);
        if (!state.projects[IMPORT_PROJECT_ID]) {
          set((s) => ({ projects: { ...s.projects, [IMPORT_PROJECT_ID]: importMeta } }));
          bg(() => mustRoot().addProject(importMeta));
        }
        // 完整备份导入时优先激活其指定的 Session，否则保持当前
        const target = incomingActiveId ? toAdd[incomingActiveId] ?? null : null;
        if (target) {
          activateSession(target, toAdd);
        } else {
          set((s) => ({ sessions: { ...s.sessions, ...toAdd } }));
        }
        bg(async () => {
          const pm = await ensureProjectManager(IMPORT_PROJECT_ID);
          for (const sess of Object.values(toAdd)) {
            await pm.writeSession(sess);
            await pm.registerSession(sess.id, sess.id === target?.id);
          }
        });
      }
      return { imported, skipped };
    },

    // -------------------- 拼装 --------------------

    toggleAssembleMode: () => {
      set((s) => ({ assembleMode: !s.assembleMode, assembleNodeIds: s.assembleMode ? [] : s.assembleNodeIds }));
    },

    addToAssemble: (nodeId) => {
      set((s) => ({ assembleNodeIds: [...s.assembleNodeIds, nodeId] }));
    },

    removeFromAssemble: (nodeId) => {
      set((s) => ({ assembleNodeIds: s.assembleNodeIds.filter((id) => id !== nodeId) }));
    },

    clearAssemble: () => set({ assembleNodeIds: [] }),
  };
});
