/**
 * src/store/useCanvasStore.ts
 * 画布状态管理：SessionData 自包含容器（节点/边/消息/视口）。
 * v0.3: Session 管理 + 拼装模式 + forkLabel。
 */
import { create } from 'zustand';
import { persist, createJSONStorage, type StateStorage } from 'zustand/middleware';
import { nanoid } from 'nanoid';
import { GraphNode, GraphEdge, SessionData, ProjectData, CanvasViewport, DEFAULT_PROJECT_ID, IMPORT_PROJECT_ID } from '@/types';
import { useSettingsStore } from '@/store/useSettingsStore';
import { sessionContentHash } from '@/lib/utils';
import { getStorageAdapter } from '@/lib/storage/adapter';
import { migrateLocalStorageBlob } from '@/lib/storage/migrateToFiles';
import { LEGACY_STORAGE_KEY, STATE_FILE } from '@/lib/storage/protocol';

/**
 * v0.4 Phase 1：persist 落盘由 localStorage 换成 StorageAdapter（整包 blob → state.json）。
 * store 结构不动、行为不变；旧 localStorage 数据在首次读取时一次性迁移，
 * 迁移失败回退读旧 key（保留重试机会），写路径仍走适配器。
 */
const adapterStorage: StateStorage = {
  getItem: async () => {
    const adapter = await getStorageAdapter();
    if (adapter.kind !== 'localstorage') {
      const result = await migrateLocalStorageBlob(adapter);
      if (result === 'failed') return localStorage.getItem(LEGACY_STORAGE_KEY);
    }
    const data = await adapter.readJson(STATE_FILE);
    return data ? JSON.stringify(data) : null;
  },
  setItem: async (_name, value) => {
    const adapter = await getStorageAdapter();
    await adapter.writeJson(STATE_FILE, JSON.parse(value));
  },
  removeItem: async () => {
    const adapter = await getStorageAdapter();
    await adapter.delete(STATE_FILE);
  },
};

const defaultViewport: CanvasViewport = { x: 0, y: 0, zoom: 1 };

function makeProject(name?: string, id?: string, pinned = false): ProjectData {
  const now = Date.now();
  return { id: id ?? nanoid(8), name: name ?? '默认项目', pinned, createdAt: now, updatedAt: now };
}

function makeSession(projectId: string, id?: string, name?: string): SessionData {
  const now = Date.now();
  return {
    id: id ?? nanoid(8),
    name: name ?? '未命名 Session',
    projectId,
    createdAt: now,
    updatedAt: now,
    nodes: {} as Record<string, GraphNode>,
    edges: {} as Record<string, GraphEdge>,
    viewport: defaultViewport,
  };
}

function cloneSession(src: SessionData): SessionData {
  return JSON.parse(JSON.stringify(src));
}

function pushHistory(state: CanvasState): { past: SessionData[] } {
  return { past: [...state.past, cloneSession(state.session)].slice(-50) };
}

interface CanvasState {
  session: SessionData;
  sessions: Record<string, SessionData>;    // ★ 全部 Session 字典
  activeSessionId: string;
  projects: Record<string, ProjectData>;    // ★ 全部项目
  activeProjectId: string;                  // ★ 当前项目
  selectedNodeId: string | null;
  assembleMode: boolean;                     // ★ 拼装模式
  assembleNodeIds: string[];                 // ★ 拼装列表 (按顺序)
  past: SessionData[];
  future: SessionData[];

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

export const useCanvasStore = create<CanvasState>()(
  persist(
    (set, get) => {
      const initProject = makeProject('默认项目', DEFAULT_PROJECT_ID, true);
      const importProject = makeProject('导入的 Sessions', IMPORT_PROJECT_ID, true);
      const initSession = makeSession(initProject.id);
      return {
        session: initSession,
        sessions: { [initSession.id]: initSession },
        activeSessionId: initSession.id,
        projects: { [initProject.id]: initProject, [importProject.id]: importProject },
        activeProjectId: initProject.id,
        selectedNodeId: null,
        assembleMode: false,
        assembleNodeIds: [],
        past: [],
        future: [],

        // -------------------- 节点 --------------------

        addNode: (position, title, model) => {
          const id = nanoid(8);
          const now = Date.now();
          const defModel = model ?? useSettingsStore.getState().defaultModel;
          const node: GraphNode = {
            id, type: 'chat', position,
            title: title ?? `对话 ${Object.keys(get().session.nodes).length + 1}`,
            model: defModel,
            collapsed: false,
            messages: [],
            createdAt: now,
            updatedAt: now,
          };
          set((s) => {
            const session = cloneSession(s.session);
            session.nodes[id] = node;
            session.updatedAt = now;
            return { ...pushHistory(s), session, selectedNodeId: id, future: [] };
          });
          return id;
        },

        updateNode: (id, patch) => {
          set((s) => {
            const session = cloneSession(s.session);
            if (session.nodes[id]) {
              session.nodes[id] = { ...session.nodes[id], ...patch, updatedAt: Date.now() };
              session.updatedAt = Date.now();
            }
            return { ...pushHistory(s), session, future: [] };
          });
        },

        deleteNode: (id) => {
          set((s) => {
            const session = cloneSession(s.session);
            delete session.nodes[id];
            for (const eid of Object.keys(session.edges)) {
              const e = session.edges[eid];
              if (e.source === id || e.target === id) delete session.edges[eid];
            }
            session.updatedAt = Date.now();
            return { ...pushHistory(s), session, selectedNodeId: s.selectedNodeId === id ? null : s.selectedNodeId, future: [] };
          });
        },

        duplicateNode: (id, offsetX = 40, offsetY = 40) => {
          const src = get().session.nodes[id];
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
          set((s) => {
            const session = cloneSession(s.session);
            session.nodes[newId] = copy;
            session.updatedAt = now;
            return { ...pushHistory(s), session, selectedNodeId: newId, future: [] };
          });
          return newId;
        },

        setSelectedNode: (id) => set({ selectedNodeId: id }),

        // -------------------- 边 --------------------

        addEdge: (source, target, edgeType = 'inherit', label) => {
          if (source === target) return '';
          const existing = Object.values(get().session.edges).find((e) => e.source === source && e.target === target);
          if (existing) return existing.id;
          const id = nanoid(8);
          const edge: GraphEdge = { id, source, target, edgeType, label };
          set((s) => {
            const session = cloneSession(s.session);
            session.edges[id] = edge;
            session.updatedAt = Date.now();
            return { ...pushHistory(s), session, future: [] };
          });
          return id;
        },

        updateEdge: (id, patch) => {
          set((s) => {
            const session = cloneSession(s.session);
            if (session.edges[id]) { session.edges[id] = { ...session.edges[id], ...patch }; session.updatedAt = Date.now(); }
            return { ...pushHistory(s), session, future: [] };
          });
        },

        deleteEdge: (id) => {
          set((s) => {
            const session = cloneSession(s.session);
            delete session.edges[id];
            session.updatedAt = Date.now();
            return { ...pushHistory(s), session, future: [] };
          });
        },

        // -------------------- 视口 --------------------

        setViewport: (vp) => {
          set((s) => {
            const session = cloneSession(s.session);
            session.viewport = vp;
            session.updatedAt = Date.now();
            return { session };
          });
        },

        // -------------------- 撤销/重做 --------------------

        undo: () => {
          const { past, session } = get();
          if (past.length === 0) return;
          const prev = past[past.length - 1];
          set((s) => ({ past: past.slice(0, -1), future: [...s.future, cloneSession(session)], session: prev }));
        },

        redo: () => {
          const { future, session } = get();
          if (future.length === 0) return;
          const next = future[future.length - 1];
          set((s) => ({ future: future.slice(0, -1), past: [...s.past, cloneSession(session)], session: next }));
        },

        // -------------------- Session --------------------

        loadSession: (data) => {
          set((s) => {
            // 同样先保存当前 Session，避免覆盖丢失
            const sessions = { ...s.sessions, [s.session.id]: s.session, [data.id]: data };
            return { ...pushHistory(s), session: data, sessions, activeSessionId: data.id, selectedNodeId: null, future: [] };
          });
        },

        switchSession: (id) => {
          const current = get();
          // ★ 如果点击的是当前激活的 session，不做任何操作
          if (id === current.activeSessionId) return;
          const target = current.sessions[id];
          if (!target) return;
          // 保存当前 session 到 sessions
          set((s) => ({
            sessions: { ...s.sessions, [s.session.id]: s.session },
            session: cloneSession(target),
            activeSessionId: id,
            activeProjectId: target.projectId,  // 跨项目点击 Session 时联动切换项目
            selectedNodeId: null,
            past: [],  // 切换 session 清空历史
            future: [],
          }));
        },

        createSession: (name, projectId) => {
          const id = nanoid(8);
          const pid = projectId ?? get().activeProjectId;
          // 自动命名需避开已有名称（删除中间项后 总数+1 会撞名）
          let autoName = name;
          if (!autoName) {
            const names = new Set(Object.values(get().sessions).map((s) => s.name));
            let n = Object.keys(get().sessions).length + 1;
            autoName = `Session ${n}`;
            while (names.has(autoName)) autoName = `Session ${++n}`;
          }
          const session = makeSession(pid, id, autoName);
          // ★ 新建 Session 时自动附带一个会话卡片（构造方式与 addNode 保持一致）
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
          set((s) => ({
            // ★ 切换前先把当前 Session 的最新状态写回字典，否则其编辑会被旧快照覆盖丢失
            sessions: { ...s.sessions, [s.session.id]: s.session, [id]: session },
            activeSessionId: id,
            activeProjectId: pid,
            session,
            selectedNodeId: nodeId,
            past: [],
            future: [],
          }));
          return id;
        },

        renameSession: (id, name) => {
          set((s) => ({
            sessions: { ...s.sessions, [id]: { ...s.sessions[id], name } },
            session: s.session.id === id ? { ...s.session, name } : s.session,
          }));
        },

        deleteSession: (id) => {
          set((s) => {
            const sessions = { ...s.sessions };
            delete sessions[id];
            if (Object.keys(sessions).length === 0) {
              const fresh = makeSession(s.activeProjectId);
              return { sessions: { [fresh.id]: fresh }, session: fresh, activeSessionId: fresh.id, selectedNodeId: null, past: [], future: [] };
            }
            if (s.session.id === id) {
              // 切到剩余 Session 中最近编辑的，而非字典插入序的第一个
              const first = Object.values(sessions).sort((a, b) => b.updatedAt - a.updatedAt)[0];
              return { sessions, session: cloneSession(first), activeSessionId: first.id, activeProjectId: first.projectId, selectedNodeId: null, past: [], future: [] };
            }
            return { sessions };
          });
        },

        duplicateSession: (id) => {
          // ★ 激活 Session 的最新状态只在 session 中，sessions 字典里的是过期快照，需优先取前者
          const state = get();
          const src = state.session.id === id ? state.session : state.sessions[id];
          if (!src) return '';
          const newId = nanoid(8);
          const now = Date.now();
          const copy = cloneSession(src);
          copy.id = newId;
          copy.name = `${src.name} (副本)`;
          // 副本按创建时间倒序应排在顶部，时间戳需刷新
          copy.createdAt = now;
          copy.updatedAt = now;
          set((s) => ({ sessions: { ...s.sessions, [newId]: copy } }));
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
          // 切到新项目（空项目由 switchProject 自动补一个 Session）
          get().switchProject(id);
          return id;
        },

        renameProject: (id, name) => {
          set((s) => (s.projects[id]
            ? { projects: { ...s.projects, [id]: { ...s.projects[id], name, updatedAt: Date.now() } } }
            : {}));
        },

        switchProject: (id) => {
          const state = get();
          if (id === state.activeProjectId || !state.projects[id]) return;
          // 保存当前 Session 后，切到目标项目中最近编辑的 Session
          const merged = { ...state.sessions, [state.session.id]: state.session };
          const candidates = Object.values(merged)
            .filter((sess) => sess.projectId === id)
            .sort((a, b) => b.updatedAt - a.updatedAt);
          if (candidates.length > 0) {
            const target = candidates[0];
            set({ sessions: merged, session: cloneSession(target), activeSessionId: target.id, activeProjectId: id, selectedNodeId: null, past: [], future: [] });
          } else {
            // 空项目：先切项目再走 createSession（自动附带卡片）
            set({ sessions: merged, activeProjectId: id });
            get().createSession();
          }
        },

        deleteProject: (id) => {
          set((s) => {
            // ★ 固定项目（默认项目/导入的 Sessions）不可删除
            if (!s.projects[id] || s.projects[id].pinned) return {};
            const projects = { ...s.projects };
            delete projects[id];
            // 项目内 Session 一并删除（先并入当前 Session 的最新状态）
            const merged = { ...s.sessions, [s.session.id]: s.session };
            const sessions: Record<string, SessionData> = {};
            for (const [sid, sess] of Object.entries(merged)) {
              if (sess.projectId !== id) sessions[sid] = sess;
            }
            // 没有剩余项目：重建默认项目与空 Session
            if (Object.keys(projects).length === 0) {
              const p = makeProject();
              const sess = makeSession(p.id);
              return { projects: { [p.id]: p }, activeProjectId: p.id, sessions: { [sess.id]: sess }, session: sess, activeSessionId: sess.id, selectedNodeId: null, past: [], future: [] };
            }
            // 删除的是当前项目：切到剩余最近更新的项目
            if (s.activeProjectId === id) {
              const nextProject = Object.values(projects).sort((a, b) => b.updatedAt - a.updatedAt)[0];
              const inProject = Object.values(sessions).filter((x) => x.projectId === nextProject.id).sort((a, b) => b.updatedAt - a.updatedAt);
              if (inProject.length > 0) {
                return { projects, sessions, activeProjectId: nextProject.id, session: cloneSession(inProject[0]), activeSessionId: inProject[0].id, selectedNodeId: null, past: [], future: [] };
              }
              const sess = makeSession(nextProject.id);
              return { projects, sessions: { ...sessions, [sess.id]: sess }, activeProjectId: nextProject.id, session: sess, activeSessionId: sess.id, selectedNodeId: null, past: [], future: [] };
            }
            return { projects, sessions };
          });
        },

        exportSessionJson: (sessionId) => {
          const s = get();
          // ★ 当前激活 Session 的最新编辑只存在于 s.session，sessions 字典中的副本是过期快照，需先合并
          const sessions = { ...s.sessions, [s.session.id]: s.session };
          // 指定 sessionId 时导出单个 SessionData（与导入逻辑的单 Session 分支对应）
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

          // 现有 Session 内容哈希集合（合并当前激活 Session 的最新状态）
          const existingSessions = { ...state.sessions, [state.session.id]: state.session };
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
            set((s) => {
              // 兜底：保证导入项目存在（正常流程由初始状态/迁移创建）
              const projects = s.projects[IMPORT_PROJECT_ID]
                ? s.projects
                : { ...s.projects, [IMPORT_PROJECT_ID]: makeProject('导入的 Sessions', IMPORT_PROJECT_ID, true) };
              const sessions = { ...s.sessions, [s.session.id]: s.session, ...toAdd };
              // 完整备份导入时优先激活其指定的 Session，否则保持当前
              const target = incomingActiveId ? sessions[incomingActiveId] : null;
              return target
                ? { projects, sessions, session: cloneSession(target), activeSessionId: target.id, activeProjectId: target.projectId, selectedNodeId: null, past: [], future: [] }
                : { projects, sessions };
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
    },
    {
      name: 'chat-canvas-session',
      storage: createJSONStorage(() => adapterStorage),
      version: 3,
      // 自定义合并：在默认浅合并基础上做启动自愈（一次性迁移管不到的场景：旧库删过固定项目、
      // 中间态数据、降级使用等），每次恢复时强制执行不变量
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<CanvasState>;
        // 1) 固定项目「默认项目」/「导入的 Sessions」：不存在则重建，pinned 丢失则补回
        const projects: Record<string, ProjectData> = { ...(p.projects ?? {}) };
        for (const [id, pname] of [[DEFAULT_PROJECT_ID, '默认项目'], [IMPORT_PROJECT_ID, '导入的 Sessions']] as const) {
          if (!projects[id]) projects[id] = makeProject(pname, id, true);
          else if (!projects[id].pinned) projects[id] = { ...projects[id], pinned: true };
        }
        // 2) 孤儿 Session（projectId 指向已不存在的项目）归拢到「导入的 Sessions」，避免数据还在但 UI 不可达
        const sessions = p.sessions ? { ...p.sessions } : undefined;
        if (sessions) {
          for (const [sid, sess] of Object.entries(sessions)) {
            if (!projects[sess.projectId]) sessions[sid] = { ...sess, projectId: IMPORT_PROJECT_ID };
          }
        }
        // 3) 激活 Session 快照同样处理（它的 projectId 可能独立于字典副本失效）
        const session = p.session ?? current.session;
        const fixedSession = projects[session.projectId] ? session : { ...session, projectId: IMPORT_PROJECT_ID };
        // 4) activeProjectId 与激活 Session 的项目保持一致（store 各流程均维持此不变量），不一致时自愈
        const activeProjectId = fixedSession.projectId;
        return { ...current, ...p, projects, ...(sessions ? { sessions } : {}), session: fixedSession, activeProjectId };
      },
      migrate: (persisted: any, version) => {
        if (version === 0) {
          // v0 -> v1: 更新各卡片中过时的模型名（与 settings 迁移保持一致）
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
              if (node?.model && MODEL_MAP[node.model]) {
                node.model = MODEL_MAP[node.model];
              }
            }
          };
          if (persisted.session) migrateNodesInSession(persisted.session);
          if (persisted.sessions) {
            for (const sid of Object.keys(persisted.sessions)) {
              migrateNodesInSession(persisted.sessions[sid]);
            }
          }
        }
        if (version < 2) {
          // v1 -> v2: 引入 Project，所有现存 Session 归入默认项目
          if (!persisted.projects || Object.keys(persisted.projects).length === 0) {
            const pid = nanoid(8);
            const now = Date.now();
            persisted.projects = { [pid]: { id: pid, name: '默认项目', createdAt: now, updatedAt: now } };
            persisted.activeProjectId = pid;
          }
          const pid = persisted.activeProjectId;
          if (persisted.sessions) {
            for (const s of Object.values(persisted.sessions) as any[]) {
              if (!s.projectId) s.projectId = pid;
            }
          }
          if (persisted.session && !persisted.session.projectId) persisted.session.projectId = pid;
        }
        if (version < 3) {
          // v2 -> v3: 默认项目与「导入的 Sessions」改为固定 ID + pinned 不可删除
          const now = Date.now();
          const projects = persisted.projects ?? {};
          // v2 迁移产生的默认项目是随机 id，需改挂到固定 id 并同步引用
          if (!projects[DEFAULT_PROJECT_ID]) {
            const legacy = Object.values(projects).find((p: any) => p?.name === '默认项目') as any;
            if (legacy) {
              const oldId = legacy.id;
              delete projects[oldId];
              projects[DEFAULT_PROJECT_ID] = { ...legacy, id: DEFAULT_PROJECT_ID, pinned: true };
              for (const s of Object.values(persisted.sessions ?? {}) as any[]) {
                if (s.projectId === oldId) s.projectId = DEFAULT_PROJECT_ID;
              }
              if (persisted.session?.projectId === oldId) persisted.session.projectId = DEFAULT_PROJECT_ID;
              if (persisted.activeProjectId === oldId) persisted.activeProjectId = DEFAULT_PROJECT_ID;
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
          persisted.projects = projects;
          if (!persisted.activeProjectId || !projects[persisted.activeProjectId]) {
            persisted.activeProjectId = DEFAULT_PROJECT_ID;
          }
        }
        return persisted;
      },
      partialize: (state) => ({
        session: state.session,
        sessions: state.sessions,
        activeSessionId: state.activeSessionId,
        projects: state.projects,
        activeProjectId: state.activeProjectId,
      }),
    }
  )
);
