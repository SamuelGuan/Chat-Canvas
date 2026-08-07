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
import { GraphNode, GraphEdge, SessionData, ProjectData, CanvasViewport, DEFAULT_PROJECT_ID, IMPORT_PROJECT_ID, type SessionBundleAsset, type SessionBundleFile, type SessionMeta } from '@/types';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useChatStore } from '@/store/useChatStore';
import { canonicalStringify, cloneSession, sessionContentHash } from '@/lib/utils';
import type { StorageAdapter } from '@/lib/storage/protocol';
import { getStorageAdapter } from '@/lib/storage/adapter';
import { projectDir } from '@/lib/storage/paths';
import { buildNodeResourceRefs, sameResourceRefs } from '@/lib/resourceIndex';
import { base64ToArrayBuffer, buildSessionBundle, collectSessionAssetPaths, encodeBundleAsset, isSessionBundleFile, remapSessionBundleAssets } from '@/lib/sessionBundle';
import { reconcileData } from '@/lib/storage/consistency';
import { RootManager } from '@/store/rootManager';
import { ProjectManager } from '@/store/projectManager';
import { SessionRuntime } from '@/store/sessionRuntime';
import { bootstrapCanvasStore, makeSessionStub } from '@/store/bootstrap';
import { makeProject, makeSession } from '@/store/factories';
import { cardRegistry } from '@/cards/registry';

/* ===== 三级 Manager 实例（非响应式，bootstrap 后可用） ===== */
let storage: StorageAdapter | null = null;
let root: RootManager | null = null;
let runtime: SessionRuntime | null = null;
/** 懒加载 stub 标记：字典中这些 id 的内容（nodes/edges/messages）尚未读盘 */
let stubIds = new Set<string>();

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

async function deleteOrphanAssets(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const adapter = await getStorageAdapter();
  await Promise.all(paths.map(async (path) => {
    try {
      await adapter.delete(path);
    } catch {
      // 孤儿资源删除失败不阻断主流程，下一次清理仍可重试
    }
  }));
}

/** 后台落盘任务串行执行（保证 create → register 等顺序）；失败仅记录，权威状态 = 磁盘 + 校验收敛 */
let bgQueue: Promise<void> = Promise.resolve();
function bg(task: () => Promise<unknown>): void {
  bgQueue = bgQueue.then(async () => { await task(); }).catch((e) => console.error('[store] 后台落盘失败', e));
}

/** SessionData → project.json 元信息缓存 */
function metaOf(s: SessionData): SessionMeta {
  return { name: s.name, createdAt: s.createdAt, updatedAt: s.updatedAt };
}

function normalizeSessionResourceRefs(session: SessionData): SessionData {
  const nextNodes: Record<string, GraphNode> = {};
  let changed = false;
  for (const [nodeId, node] of Object.entries(session.nodes)) {
    const refs = buildNodeResourceRefs(node);
    nextNodes[nodeId] = sameResourceRefs(node.resourceRefs, refs)
      ? node
      : { ...node, resourceRefs: refs };
    if (!sameResourceRefs(node.resourceRefs, refs)) changed = true;
  }
  return changed ? { ...session, nodes: nextNodes } : session;
}

function bundleAssetTargetPath(sourcePath: string, targetProjectId: string): string {
  const fileName = sourcePath.split('/').pop() ?? sourcePath;
  return `projects/${targetProjectId}/assets/${fileName}`;
}

/** 装载项目 Manager（不存在则按 state.projects 元数据创建） */
async function ensureProjectManager(pid: string): Promise<ProjectManager> {
  const pm = await ProjectManager.load(mustStorage(), pid);
  if (pm) return pm;
  const meta = useCanvasStore.getState().projects[pid] ?? makeProject('默认项目', pid, pid === DEFAULT_PROJECT_ID || pid === IMPORT_PROJECT_ID);
  return ProjectManager.create(mustStorage(), meta);
}

/**
 * 按需装载 Session 完整内容（懒加载）：stub → 读盘替换字典条目；
 * 已装载直接返回；文件缺失返回 null（由一致性校验兜底剔除登记）。
 */
async function loadFullSession(sid: string): Promise<SessionData | null> {
  const stub = useCanvasStore.getState().sessions[sid];
  if (!stub) return null;
  if (!stubIds.has(sid)) return stub;
  const pm = await ProjectManager.load(mustStorage(), stub.projectId);
  const full = (await pm?.readSession(sid)) ?? null;
  if (!full) return null;
  stubIds.delete(sid);
  useCanvasStore.setState((prev) => ({ sessions: { ...prev.sessions, [sid]: full } }));
  return full;
}

interface CanvasState {
  session: SessionData;
  sessions: Record<string, SessionData>;    // ★ 非激活 Session 字典（懒加载 stub / 磁盘权威副本，不含激活 Session）
  activeSessionId: string;
  projects: Record<string, ProjectData>;
  activeProjectId: string;
  selectedNodeId: string | null;
  assembleMode: boolean;
  assembleNodeIds: string[];
  /** Q6：文件监听发现激活 Session 被外部修改/删除时的待确认冲突 */
  externalConflict: { sessionId: string; kind: 'modified' | 'deleted' } | null;

  // ===== 启动 =====
  bootstrap: () => Promise<void>;

  // ===== 外部变更联动 =====
  reconvergeFromDisk: () => Promise<void>;
  resolveExternalConflict: (reload: boolean) => void;

  // ===== 节点 =====
  addNode: (position: { x: number; y: number }, opts?: { type?: string; title?: string; model?: string }) => string;
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
  moveSession: (id: string, targetProjectId: string) => void;
  exportSessionJson: (sessionId?: string) => Promise<string>;
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

  /** 卸载当前 runtime：先落盘（并刷新元信息缓存）再丢弃（切换 Session/项目时的统一步骤） */
  const unloadRuntime = (): SessionData => {
    const old = mustRuntime();
    const oldSession = old.session;
    bg(async () => {
      await old.flush();
      const pm = await ProjectManager.load(mustStorage(), oldSession.projectId);
      await pm?.updateSessionMeta(oldSession.id, metaOf(oldSession));
    });
    old.dispose();
    return oldSession;
  };

  /** 换装激活 Session：旧实例落盘卸载，新实例驻留，字典只留非激活 Session（stub 先读盘再换装） */
  const activateSession = (target: SessionData, extraSessions: Record<string, SessionData> = {}) => {
    if (stubIds.has(target.id)) {
      // 懒加载：stub 先读盘，完成后重走换装
      void (async () => {
        const full = await loadFullSession(target.id);
        if (full) activateSession(full, extraSessions);
      })();
      return;
    }
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
    externalConflict: null,

    // -------------------- 启动 --------------------

    bootstrap: async () => {
      const result = await bootstrapCanvasStore();
      storage = result.storage;
      root = result.root;
      runtime = result.runtime;
      stubIds = new Set(result.stubIds);
      set({
        session: result.active,
        sessions: result.sessions,
        activeSessionId: result.active.id,
        projects: result.projects,
        activeProjectId: result.activeProjectId,
        selectedNodeId: null,
        externalConflict: null,
      });
    },

    // -------------------- 外部变更联动 --------------------

    reconvergeFromDisk: async () => {
      if (!storage || !runtime) return;
      // 幂等校验（watcher 侧已跑过；此处兜底覆盖 CLI 直改后手动同步等场景）
      await reconcileData(mustStorage());
      const freshRoot = await RootManager.load(mustStorage());
      root = freshRoot;
      // 非激活 Session 全部回退为 stub（磁盘权威；已装载副本无写者，丢弃无损失）
      const sessions: Record<string, SessionData> = {};
      const freshStubIds = new Set<string>();
      const activeId = get().session.id;
      for (const pid of freshRoot.projectIds) {
        const pm = await ProjectManager.load(mustStorage(), pid);
        if (!pm) continue;
        for (const sid of pm.sessionIds) {
          if (sid === activeId) continue;
          sessions[sid] = makeSessionStub(sid, pid, pm.getSessionMeta(sid));
          freshStubIds.add(sid);
        }
      }
      stubIds = freshStubIds;
      // 激活 Session 与磁盘比对 → Q6 冲突确认（外部修改提示，不自动 reload）
      const rt = mustRuntime();
      const pm = await ProjectManager.load(mustStorage(), rt.session.projectId);
      const disk = (await pm?.readSession(rt.session.id)) ?? null;
      let conflict = get().externalConflict;
      if (!disk) {
        conflict = { sessionId: rt.session.id, kind: 'deleted' };
      } else if (canonicalStringify(disk) !== canonicalStringify(rt.session)) {
        conflict = { sessionId: rt.session.id, kind: 'modified' };
      }
      set({
        projects: freshRoot.projects,
        sessions,
        activeProjectId: freshRoot.activeProjectId,
        externalConflict: conflict,
      });
    },

    resolveExternalConflict: (reload) => {
      const c = get().externalConflict;
      if (!c) return;
      set({ externalConflict: null });
      if (reload && c.kind === 'modified') {
        // 用户选择磁盘为准：读文件换装 runtime，未落盘编辑被覆盖
        void (async () => {
          const rt = mustRuntime();
          const pm = await ProjectManager.load(mustStorage(), rt.session.projectId);
          const full = (await pm?.readSession(c.sessionId)) ?? null;
          if (!full) return;
          const fresh = new SessionRuntime(mustStorage(), full);
          mustRuntime().dispose();
          runtime = fresh;
          set({ session: full, selectedNodeId: null });
        })();
      } else {
        // 用户选择内存为准（或文件已被外部删除）：立即落盘覆盖/重建
        bg(async () => {
          const rt = mustRuntime();
          await rt.flush();
          const pm = await ensureProjectManager(rt.session.projectId);
          await pm.registerSession(rt.session.id, true, metaOf(rt.session));
        });
      }
    },

    // -------------------- 节点 --------------------

    addNode: (position, opts) => {
      const rt = mustRuntime();
      const id = nanoid(8);
      const now = Date.now();
      const nodeType = opts?.type ?? 'chat';
      const plugin = cardRegistry.get(nodeType);
      if (!plugin) {
        console.warn(`[useCanvasStore] 未知卡片类型 "${nodeType}"，回退为 chat`);
      }
      const defaults = plugin?.defaults ?? {};
      const node: GraphNode = {
        id,
        type: nodeType as GraphNode['type'],
        position,
        title: opts?.title ?? defaults.title ?? `节点 ${Object.keys(rt.session.nodes).length + 1}`,
        model: opts?.model ?? defaults.model ?? useSettingsStore.getState().defaultModel,
        collapsed: defaults.collapsed ?? false,
        messages: [],
        createdAt: now,
        updatedAt: now,
        ...defaults,
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
      const currentNode = rt.session.nodes[id];
      if (!currentNode) return;
      const session = cloneSession(rt.session);
      const nextNode = { ...session.nodes[id], ...patch, updatedAt: Date.now() };
      const nextResourceRefs = buildNodeResourceRefs(nextNode);
      nextNode.resourceRefs = nextResourceRefs;
      session.nodes[id] = nextNode;
      session.updatedAt = Date.now();
      rt.commit(session);
      set({ session: rt.session });
      if (!sameResourceRefs(currentNode.resourceRefs, nextResourceRefs)) {
        bg(async () => {
          const pm = await ensureProjectManager(session.projectId);
          const orphanPaths = await pm.syncNodeResources(session.id, id, nextResourceRefs);
          await deleteOrphanAssets(orphanPaths);
        });
      }
    },

    deleteNode: (id) => {
      const rt = mustRuntime();
      const session = cloneSession(rt.session);
      const node = session.nodes[id];
      if (!node) return;

      // 1. 清理 chatStore 的 streaming 状态
      const chatState = useChatStore.getState();
      if (chatState.streamingNodeId === id) {
        chatState.finishStreaming(id, '');
        useChatStore.setState({ streamingNodeId: null, streamingText: '' });
      }

      delete session.nodes[id];
      for (const eid of Object.keys(session.edges)) {
        const e = session.edges[eid];
        if (e.source === id || e.target === id) delete session.edges[eid];
      }
      session.updatedAt = Date.now();
      rt.commit(session);
      set((s) => ({ session: rt.session, selectedNodeId: s.selectedNodeId === id ? null : s.selectedNodeId }));
      bg(async () => {
        const pm = await ensureProjectManager(session.projectId);
        const orphanPaths = await pm.syncNodeResources(session.id, id, []);
        await deleteOrphanAssets(orphanPaths);
      });
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
      const nextResourceRefs = buildNodeResourceRefs(copy);
      copy.resourceRefs = nextResourceRefs;
      const session = cloneSession(rt.session);
      session.nodes[newId] = copy;
      session.updatedAt = now;
      rt.commit(session);
      set({ session: rt.session, selectedNodeId: newId });
      if (nextResourceRefs.length > 0) {
        bg(async () => {
          const pm = await ensureProjectManager(session.projectId);
          await pm.syncNodeResources(session.id, newId, nextResourceRefs);
        });
      }
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
      const session = normalizeSessionResourceRefs({ ...data, projectId: pid });
      activateSession(session);
      bg(async () => {
        const pm = await ensureProjectManager(pid);
        await pm.writeSession(session);
        await pm.registerSession(session.id, true, metaOf(session));
        for (const node of Object.values(session.nodes)) {
          await pm.syncNodeResources(session.id, node.id, node.resourceRefs ?? []);
        }
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
        await pm.registerSession(session.id, true, metaOf(session));
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
        bg(async () => {
          const pm = await ensureProjectManager(rt.session.projectId);
          await pm.updateSessionMeta(id, metaOf(rt.session));
        });
        return;
      }
      const target = s.sessions[id];
      if (!target) return;
      const renamed = { ...target, name };
      set({ sessions: { ...s.sessions, [id]: renamed } });
      bg(async () => {
        // stub 需先读盘，避免用空内容覆盖真实文件
        const full = (await loadFullSession(id)) ?? target;
        const pm = await ensureProjectManager(full.projectId);
        await pm.writeSession({ ...full, name });
        await pm.updateSessionMeta(id, { name, createdAt: full.createdAt, updatedAt: full.updatedAt });
      });
    },

    deleteSession: (id) => {
      const s = get();
      const target = id === s.session.id ? s.session : s.sessions[id];
      if (!target) return;
      bg(async () => {
        const pm = await ProjectManager.load(mustStorage(), target.projectId);
        if (pm) {
          const orphanPaths = await pm.removeSessionResources(id);
          await pm.unregisterSession(id);
          await pm.deleteSessionFile(id);
          await deleteOrphanAssets(orphanPaths);
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
          await pm.registerSession(fresh.id, true, metaOf(fresh));
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
      // 激活态取 session（runtime 权威），非激活态取字典（stub 先读盘），均不会过期
      const src = id === s.session.id ? s.session : s.sessions[id];
      if (!src) return '';
      const newId = nanoid(8);
      const now = Date.now();
      const finish = (full: SessionData) => {
        const copy = normalizeSessionResourceRefs(cloneSession(full));
        copy.id = newId;
        copy.name = `${full.name} (副本)`;
        // 副本按创建时间倒序应排在顶部，时间戳需刷新
        copy.createdAt = now;
        copy.updatedAt = now;
        stubIds.delete(newId);
        set((prev) => ({ sessions: { ...prev.sessions, [newId]: copy } }));
        bg(async () => {
          const pm = await ensureProjectManager(copy.projectId);
          await pm.writeSession(copy);
          await pm.registerSession(newId, false, metaOf(copy));
          for (const node of Object.values(copy.nodes)) {
            await pm.syncNodeResources(copy.id, node.id, node.resourceRefs ?? []);
          }
        });
      };
      if (id === s.session.id || !stubIds.has(id)) {
        finish(src);
      } else {
        // stub 源：读盘完成后补入字典（一个本地文件读的延迟，避免占位空内容被误切换）
        void (async () => {
          const full = await loadFullSession(id);
          if (full) finish(full);
        })();
      }
      return newId;
    },

    /**
     * 移动 Session 到其他项目：文件物理迁移（写目标项目 → 源项目删文件注销登记）。
     * 激活 Session 走 runtime 权威状态并跟随切换 activeProjectId；非激活 Session（stub 先读盘）后台迁移。
     */
    moveSession: (id, targetProjectId) => {
      const s = get();
      if (!s.projects[targetProjectId]) return;

      if (id === s.session.id) {
        const rt = mustRuntime();
        const sourcePid = rt.session.projectId;
        if (sourcePid === targetProjectId) return;
        rt.commit({ ...rt.session, projectId: targetProjectId }, { history: false, immediate: true });
        set({ session: rt.session, activeProjectId: targetProjectId });
        bg(async () => {
          const srcPm = await ProjectManager.load(mustStorage(), sourcePid);
          if (srcPm) {
            await srcPm.unregisterSession(id);
            await srcPm.deleteSessionFile(id);
          }
          const dstPm = await ensureProjectManager(targetProjectId);
          await dstPm.registerSession(id, true, metaOf(rt.session));
          await mustRoot().setActiveProject(targetProjectId);
        });
        return;
      }

      const entry = s.sessions[id];
      if (!entry || entry.projectId === targetProjectId) return;
      const sourcePid = entry.projectId;
      void (async () => {
        const full = await loadFullSession(id);
        if (!full) return;
        const moved = { ...full, projectId: targetProjectId };
        const srcPm = await ProjectManager.load(mustStorage(), sourcePid);
        const dstPm = await ensureProjectManager(targetProjectId);
        await dstPm.writeSession(moved);
        await dstPm.registerSession(id, false, metaOf(moved));
        if (srcPm) {
          await srcPm.unregisterSession(id);
          await srcPm.deleteSessionFile(id);
        }
        set((prev) => ({ sessions: { ...prev.sessions, [id]: moved } }));
      })();
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
          await pm.registerSession(fresh.id, true, metaOf(fresh));
        });
      }
    },

    exportSessionJson: async (sessionId) => {
      const s = get();
      const sessionsToExport: Record<string, SessionData> = {};
      if (sessionId) {
        if (sessionId === s.session.id) {
          sessionsToExport[s.session.id] = s.session;
        } else {
          const full = await loadFullSession(sessionId);
          sessionsToExport[sessionId] = full ?? s.sessions[sessionId] ?? s.session;
        }
      } else {
        sessionsToExport[s.session.id] = s.session;
        for (const [sid, stub] of Object.entries(get().sessions)) {
          sessionsToExport[sid] = (await loadFullSession(sid)) ?? stub;
        }
      }

      const assetPaths = new Set<string>();
      for (const session of Object.values(sessionsToExport)) {
        for (const path of collectSessionAssetPaths(session)) assetPaths.add(path);
      }

      const adapter = await getStorageAdapter();
      const assets: SessionBundleAsset[] = [];
      for (const path of assetPaths) {
        const buffer = await adapter.readBinary(path);
        if (buffer) assets.push(encodeBundleAsset(path, buffer));
      }

      const bundle = buildSessionBundle(
        sessionsToExport,
        assets,
        sessionId ? sessionId : s.activeSessionId,
      );
      return JSON.stringify(bundle, null, 2);
    },

    importSessions: async (data) => {
      const state = get();
      // 兼容两种导出格式：完整备份 {sessions, activeSessionId} 或单个 SessionData
      const d = data as Partial<SessionData> & { sessions?: Record<string, SessionData>; activeSessionId?: string };
      const bundle = isSessionBundleFile(data) ? data as SessionBundleFile : null;
      let incoming: SessionData[];
      const incomingActiveId = bundle?.activeSessionId ?? d.activeSessionId ?? null;
      if (bundle) {
        incoming = Object.values(bundle.sessions);
      } else if (d.sessions && typeof d.sessions === 'object') {
        incoming = Object.values(d.sessions);
      } else if (d.id && d.nodes) {
        incoming = [d as SessionData];
      } else {
        throw new Error('无法识别的 Session 文件格式');
      }

      const bundlePathMap = new Map<string, string>();
      if (bundle) {
        for (const asset of bundle.assets) {
          const targetPath = bundleAssetTargetPath(asset.path, IMPORT_PROJECT_ID);
          bundlePathMap.set(asset.path, targetPath);
        }
      }

      // 现有 Session 内容哈希集合（激活 + 非激活均权威；stub 逐个读盘计算）
      const existingSessions: Record<string, SessionData> = { ...state.sessions, [state.session.id]: state.session };
      const existingHashes = new Set<string>();
      for (const [sid, sess] of Object.entries(existingSessions)) {
        const full = sid === state.session.id ? sess : (await loadFullSession(sid)) ?? sess;
        existingHashes.add(await sessionContentHash(full));
      }

      let imported = 0;
      let skipped = 0;
      const toAdd: Record<string, SessionData> = {};
      for (const raw of incoming) {
        if (!raw?.id || !raw.nodes) { skipped++; continue; }
        const bundled = bundle
          ? remapSessionBundleAssets(cloneSession(raw), bundlePathMap, IMPORT_PROJECT_ID)
          : cloneSession(raw);
        const hash = await sessionContentHash(bundled);
        // ★ SHA-256 内容哈希相同则忽略，避免重复导入造成覆盖
        if (existingHashes.has(hash)) { skipped++; continue; }
        const session = normalizeSessionResourceRefs(bundled);
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
          const adapter = await getStorageAdapter();
          const requiredAssetPaths = new Set<string>();
          for (const sess of Object.values(toAdd)) {
            for (const path of collectSessionAssetPaths(sess)) requiredAssetPaths.add(path);
          }
          if (bundle) {
            for (const asset of bundle.assets) {
              const targetPath = bundlePathMap.get(asset.path);
              if (!targetPath || !requiredAssetPaths.has(targetPath)) continue;
              const existed = await adapter.exists(targetPath);
              if (!existed) {
                await adapter.writeBinary(targetPath, base64ToArrayBuffer(asset.dataBase64));
              }
            }
          }
          const pm = await ensureProjectManager(IMPORT_PROJECT_ID);
          for (const sess of Object.values(toAdd)) {
            await pm.writeSession(sess);
            await pm.registerSession(sess.id, sess.id === target?.id, metaOf(sess));
            for (const node of Object.values(sess.nodes)) {
              await pm.syncNodeResources(sess.id, node.id, node.resourceRefs ?? []);
            }
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
