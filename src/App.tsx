/**
 * src/App.tsx
 * 主应用：左侧侧边栏 + 画布 + 设置面板 + Session 管理 + 搜索 + 大纲面板。
 * v0.3: Session 切换 + Cmd+K 搜索 + 大纲面板 + 拼装模式 + D-09。
 * v0.3.1: 顶部工具栏改为左侧侧边栏，Session 按创建时间倒序。
 */
import { useState, useEffect, useMemo } from 'react';
import { Canvas } from '@/components/Canvas/Canvas';
import { SettingsDialog } from '@/components/Settings/SettingsDialog';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useCanvasStore } from '@/store/useCanvasStore';
import { useElectron, secureGet } from '@/hooks/useElectron';
import { getStorageAdapter } from '@/lib/storage/adapter';
import { subscribeStoreEvents } from '@/lib/storage/events';
import { SearchIcon, OutlineIcon, AssembleIcon, SettingsIcon } from '@/components/icons';
import { cn } from '@/lib/utils';
import { DEFAULT_PROJECT_ID } from '@/types';
import '@/cards/builtin/register';
import { matchCardSearch } from '@/cards/communicateAdapter';

/* ===== 大纲面板组件 ===== */
function OutlinePanel() {
  const session = useCanvasStore((s) => s.session);
  const selectedNodeId = useCanvasStore((s) => s.selectedNodeId);
  const setSelectedNode = useCanvasStore((s) => s.setSelectedNode);

  const nodes = useMemo(() => Object.values(session.nodes), [session.nodes]);
  const edges = useMemo(() => Object.values(session.edges), [session.edges]);

  // 构建父子关系
  const childrenOf = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const e of edges) {
      if (!map.has(e.source)) map.set(e.source, []);
      map.get(e.source)!.push(e.target);
    }
    return map;
  }, [edges]);

  const parentsOf = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const e of edges) {
      if (!map.has(e.target)) map.set(e.target, []);
      map.get(e.target)!.push(e.source);
    }
    return map;
  }, [edges]);

  if (!selectedNodeId || !session.nodes[selectedNodeId]) return null;
  const current = session.nodes[selectedNodeId];

  // 面包屑: 沿父链向上回溯
  const breadcrumb: string[] = [selectedNodeId];
  let cursor = selectedNodeId;
  const visited = new Set<string>();
  while (true) {
    const parents = parentsOf.get(cursor);
    if (!parents || parents.length === 0 || visited.has(cursor)) break;
    cursor = parents[0];
    if (!session.nodes[cursor]) break;
    visited.add(cursor);
    breadcrumb.unshift(cursor);
  }

  return (
    <div className="absolute right-2 top-2 z-40 w-64 rounded-lg border bg-white dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700 shadow-lg max-h-[80vh] overflow-y-auto">
      {/* 面包屑 */}
      <div className="border-b px-3 py-2 border-zinc-200 dark:border-zinc-700">
        <div className="text-[10px] text-zinc-400 mb-1">路径</div>
        <div className="flex flex-wrap gap-1 text-xs">
          {breadcrumb.map((nid, i) => (
            <span key={nid} className="flex items-center gap-1">
              {i > 0 && <span className="text-zinc-300">→</span>}
              <button onClick={() => setSelectedNode(nid)} className={cn('rounded px-1.5 py-0.5 hover:bg-zinc-100 dark:hover:bg-zinc-700', nid === selectedNodeId ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900' : 'text-zinc-600 dark:text-zinc-400')}>
                {session.nodes[nid]?.title?.slice(0, 12) ?? nid}
              </button>
            </span>
          ))}
        </div>
      </div>
      {/* 当前节点 */}
      <div className="px-3 py-2">
        <div className="text-[10px] text-zinc-400 mb-1">当前</div>
        <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{current.title}</div>
      </div>
      {/* 上游 */}
      <div className="px-3 py-2 border-t border-zinc-100 dark:border-zinc-700/50">
        <div className="text-[10px] text-zinc-400 mb-1">上游 ({parentsOf.get(selectedNodeId)?.length ?? 0})</div>
        {(parentsOf.get(selectedNodeId) ?? []).map((pid) => {
          const p = session.nodes[pid];
          const e = edges.find((x) => x.source === pid && x.target === selectedNodeId);
          return (
            <button key={pid} onClick={() => setSelectedNode(pid)} className="block w-full text-left rounded px-2 py-1 text-xs text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-700 mb-0.5">
              ← {p?.title} {e?.label && <span className="text-zinc-400">[{e.label}]</span>}
            </button>
          );
        })}
      </div>
      {/* 下游 */}
      <div className="px-3 py-2 border-t border-zinc-100 dark:border-zinc-700/50">
        <div className="text-[10px] text-zinc-400 mb-1">下游 ({childrenOf.get(selectedNodeId)?.length ?? 0})</div>
        {(childrenOf.get(selectedNodeId) ?? []).map((cid) => {
          const c = session.nodes[cid];
          const e = edges.find((x) => x.source === selectedNodeId && x.target === cid);
          return (
            <button key={cid} onClick={() => setSelectedNode(cid)} className="block w-full text-left rounded px-2 py-1 text-xs text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-700 mb-0.5">
              → {c?.title} {e?.label && <span className="text-zinc-400">[{e.label}]</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ===== 搜索面板组件 ===== */
function SearchPanel({ onClose }: { onClose: () => void }) {
  const session = useCanvasStore((s) => s.session);
  const setSelectedNode = useCanvasStore((s) => s.setSelectedNode);
  const [query, setQuery] = useState('');

  const results = useMemo(() => {
    if (!query.trim()) return [];
    const q = query.toLowerCase();
    return Object.values(session.nodes)
      .filter((n) => {
        // v0.5: 委托 cardComm 按卡片类型感知搜索
        return matchCardSearch(n, q);
      })
      .slice(0, 10)
      .map((n) => {
        // 搜索预览：chat 取首条 user 消息，其他类型取 title
        const hasMessages = 'messages' in n && Array.isArray(n.messages);
        const firstUser = hasMessages ? n.messages.find((m: { role: string; content: unknown }) => m.role === 'user') : undefined;
        return {
          id: n.id,
          title: n.title,
          preview: firstUser ? (typeof firstUser.content === 'string' ? firstUser.content : '').slice(0, 60) : `(${n.type} 卡片)`,
        };
      });
  }, [query, session.nodes]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]" onClick={onClose}>
      <div className="w-[480px] rounded-xl border bg-white border-zinc-200 dark:bg-zinc-800 dark:border-zinc-700 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索卡片标题或消息内容..."
          className="w-full border-b px-4 py-3 text-sm outline-none border-zinc-200 dark:border-zinc-700 bg-transparent text-zinc-900 dark:text-zinc-100"
          autoFocus
        />
        {results.length > 0 && (
          <div className="max-h-[300px] overflow-y-auto">
            {results.map((r) => (
              <button
                key={r.id}
                onClick={() => { setSelectedNode(r.id); onClose(); }}
                className="w-full text-left px-4 py-2.5 hover:bg-zinc-50 dark:hover:bg-zinc-700/50 border-b border-zinc-100 dark:border-zinc-700/50 last:border-0"
              >
                <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{r.title}</div>
                <div className="text-xs text-zinc-400 mt-0.5 truncate">{r.preview}</div>
              </button>
            ))}
          </div>
        )}
        {query && results.length === 0 && (
          <div className="px-4 py-3 text-xs text-zinc-400">无匹配结果</div>
        )}
      </div>
    </div>
  );
}

/* ===== 主应用 ===== */
export default function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  // 待确认的删除操作（原生 confirm/alert 在 Electron 中不可靠，改用应用内确认弹窗）
  const [pendingDelete, setPendingDelete] = useState<
    | { kind: 'session'; id: string; name: string }
    | { kind: 'project'; id: string; name: string; blocked: boolean }
    | null
  >(null);
  // 待移动的 Session（选择目标项目弹窗）
  const [pendingMove, setPendingMove] = useState<{ id: string; name: string; fromPid: string } | null>(null);
  // 项目展开状态（未设置时默认展开当前项目）
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});

  const initialize = useSettingsStore((s) => s.initialize);
  const providers = useSettingsStore((s) => s.providers);
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const sidebarScale = useSettingsStore((s) => s.sidebarScale);
  const activeProviderId = useSettingsStore((s) => s.activeProviderId);

  const session = useCanvasStore((s) => s.session);
  const sessions = useCanvasStore((s) => s.sessions);
  const activeSessionId = useCanvasStore((s) => s.activeSessionId);
  const addNode = useCanvasStore((s) => s.addNode);
  const switchSession = useCanvasStore((s) => s.switchSession);
  const createSession = useCanvasStore((s) => s.createSession);
  const renameSession = useCanvasStore((s) => s.renameSession);
  const deleteSession = useCanvasStore((s) => s.deleteSession);
  const duplicateSession = useCanvasStore((s) => s.duplicateSession);
  const moveSession = useCanvasStore((s) => s.moveSession);
  const projects = useCanvasStore((s) => s.projects);
  const activeProjectId = useCanvasStore((s) => s.activeProjectId);
  const createProject = useCanvasStore((s) => s.createProject);
  const renameProject = useCanvasStore((s) => s.renameProject);
  const deleteProject = useCanvasStore((s) => s.deleteProject);
  const switchProject = useCanvasStore((s) => s.switchProject);
  const toggleAssembleMode = useCanvasStore((s) => s.toggleAssembleMode);
  const assembleMode = useCanvasStore((s) => s.assembleMode);
  const undo = useCanvasStore((s) => s.undo);
  const redo = useCanvasStore((s) => s.redo);
  const externalConflict = useCanvasStore((s) => s.externalConflict);
  const resolveExternalConflict = useCanvasStore((s) => s.resolveExternalConflict);

  const { isElectron } = useElectron();
  const activeProvider = providers.find((p) => p.id === activeProviderId);
  const hasApiKey = !!activeProvider?.apiKey;

  // Session 列表按创建时间倒序（越晚越靠上）
  // v0.4：sessions 字典只含非激活 Session（无副本），列表视图合成时补上激活 Session
  const sortedSessions = useMemo(() => {
    return [session, ...Object.values(sessions)].sort((a, b) => b.createdAt - a.createdAt);
  }, [sessions, session]);

  // 项目按创建时间倒序
  const sortedProjects = useMemo(() => {
    return Object.values(projects).sort((a, b) => b.createdAt - a.createdAt);
  }, [projects]);

  // Session 按项目分组（沿用已排序的 sortedSessions，组内保持倒序）
  // 兜底归入默认项目而非当前激活项目，否则切换项目时无 projectId 的 Session 会跟着跳动
  const sessionsByProject = useMemo(() => {
    const map = new Map<string, typeof sortedSessions>();
    for (const s of sortedSessions) {
      const pid = s.projectId ?? DEFAULT_PROJECT_ID;
      if (!map.has(pid)) map.set(pid, []);
      map.get(pid)!.push(s);
    }
    return map;
  }, [sortedSessions]);

  // D-09: API Key 外部加载
  useEffect(() => {
    async function init() {
      initialize();
      const currentProviders = useSettingsStore.getState().providers;
      for (const p of currentProviders) {
        const stored = await secureGet(`apikey_${p.id}`);
        if (stored) useSettingsStore.getState().updateProvider(p.id, { apiKey: stored });
      }
    }
    init();
  }, [initialize]);

  // Cmd+K 搜索
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // 删除确认 / 移动弹窗：Esc 取消
  useEffect(() => {
    if (!pendingDelete && !pendingMove) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') { setPendingDelete(null); setPendingMove(null); }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [pendingDelete, pendingMove]);

  // v0.4：订阅数据目录外部变更（文件监听 → 一致性收敛 → SSE/IPC 推送 → 联动重载）
  useEffect(() => {
    let unsub = () => {};
    void (async () => {
      try {
        const adapter = await getStorageAdapter();
        unsub = subscribeStoreEvents(adapter, () => {
          void useCanvasStore.getState().reconvergeFromDisk();
        });
      } catch {
        // 无文件存储后端（静态部署）：无推送通道可订阅
      }
    })();
    return () => unsub();
  }, []);

  // Electron 菜单
  useEffect(() => {
    if (!isElectron) return;
    const api = window.electronAPI!;
    api.onMenuOpenSettings(() => setSettingsOpen(true));
    api.onMenuNewCard(() => {
      const centerX = window.innerWidth / 2;
      const centerY = window.innerHeight / 2;
      addNode({ x: centerX - 250, y: centerY - 100 });
    });
    api.onMenuImport(() => {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = 'application/json';
      input.onchange = async () => {
        const file = input.files?.[0]; if (!file) return;
        try {
          const data = JSON.parse(await file.text());
          const { imported, skipped } = await useCanvasStore.getState().importSessions(data);
          if (imported === 0 && skipped > 0) alert('导入被忽略：文件内容与现有 Session 完全相同');
        } catch { alert('导入失败'); }
      };
      input.click();
    });
    api.onMenuExport(() => {
      void (async () => {
        const json = await useCanvasStore.getState().exportSessionJson();
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = `chat-canvas-${Date.now()}.json`; a.click(); URL.revokeObjectURL(url);
      })();
    });
    api.onMenuToggleTheme(() => setTheme(theme === 'dark' ? 'light' : 'dark'));
  }, [isElectron, addNode, theme, setTheme]);

  return (
    <div className="h-screen w-screen flex flex-row overflow-hidden bg-[#f5f4ed] dark:bg-zinc-900">
      {/* ===== 左侧侧边栏 ===== */}
      <aside className={cn(
        'flex flex-col border-r bg-white dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700',
        'transition-all duration-200',
        sidebarCollapsed ? 'w-12' : 'w-52',
      )} style={{ zoom: sidebarScale }}>
        {/* Logo 区域（仅展开时显示；折叠态的 CC 图标已移除，展开按钮在下方） */}
        {!sidebarCollapsed && (
          <div className="flex items-center justify-between border-b border-zinc-200 dark:border-zinc-700 px-2 py-2.5">
            <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100 truncate">Chat Canvas</span>
            <button
              onClick={() => setSidebarCollapsed(true)}
              className="rounded px-1.5 py-1 text-base leading-none text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-700 flex-shrink-0"
              title="折叠侧边栏"
            >
              &laquo;
            </button>
          </div>
        )}

        {/* 展开时显示标题行，折叠时显示展开按钮 */}
        {sidebarCollapsed && (
          <button
            onClick={() => setSidebarCollapsed(false)}
            className="mx-auto mt-2 flex h-7 w-7 items-center justify-center rounded text-base leading-none text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-700"
            title="展开侧边栏"
          >
            &raquo;
          </button>
        )}

        {/* 项目 > Session 两级列表 */}
        <div className={cn('flex-1 overflow-y-auto', sidebarCollapsed ? 'px-1 mt-2' : 'px-2 mt-2')}>
          {!sidebarCollapsed && (
            <div className="flex items-center justify-between mb-1.5 px-1">
              <span className="text-[9px] text-zinc-400 uppercase tracking-wider">Project</span>
              <button onClick={() => createProject()} className="text-[10px] text-zinc-400 hover:text-blue-500 dark:hover:text-blue-400 transition-colors" title="新建项目">+ 项目</button>
            </div>
          )}
          {/* 折叠态：仅显示当前项目的 Session 图标 */}
          {sidebarCollapsed && (sessionsByProject.get(activeProjectId) ?? []).map((s) => (
            <div
              key={s.id}
              className={cn(
                'group relative rounded-md transition-colors',
                s.id === activeSessionId
                  ? 'bg-zinc-100 dark:bg-zinc-700'
                  : 'hover:bg-zinc-50 dark:hover:bg-zinc-700/50',
                'flex justify-center py-1.5 mb-0.5',
              )}
            >
              <button
                onClick={() => switchSession(s.id)}
                className={cn(
                  'h-7 w-7 rounded-md flex items-center justify-center text-[10px] font-medium',
                  s.id === activeSessionId
                    ? 'bg-[#D97757] text-white'
                    : 'text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100',
                )}
                title={s.name}
              >
                {s.name.slice(0, 2)}
              </button>
            </div>
          ))}
          {/* 折叠态：当前项目下新建 Session */}
          {sidebarCollapsed && (
            <button
              onClick={() => createSession()}
              className="w-full flex justify-center py-1.5 text-sm font-bold text-zinc-400 hover:text-blue-500 dark:hover:text-blue-400 transition-colors"
              title="新建 Session"
            >+</button>
          )}

          {/* 展开态：项目树（项目 > 其内 Session） */}
          {!sidebarCollapsed && sortedProjects.map((p) => {
            const expanded = expandedProjects[p.id] ?? p.id === activeProjectId;
            const pSessions = sessionsByProject.get(p.id) ?? [];
            return (
              <div key={p.id} className="mb-1">
                {/* 项目行 */}
                <div className={cn('group relative flex items-center rounded-md transition-colors', p.id === activeProjectId ? 'bg-zinc-100 dark:bg-zinc-700' : 'hover:bg-zinc-50 dark:hover:bg-zinc-700/50')}>
                  <button
                    onClick={() => setExpandedProjects((prev) => ({ ...prev, [p.id]: !expanded }))}
                    className="px-1 py-1 text-[9px] text-zinc-400 hover:text-zinc-600 flex-shrink-0"
                    title={expanded ? '收起' : '展开'}
                  >{expanded ? '▾' : '▸'}</button>
                  {editingProjectId === p.id ? (
                    /* 内联改名：与 Session 相同的交互（Enter/失焦提交，Esc 取消） */
                    <input
                      key={p.id}
                      defaultValue={p.name}
                      autoFocus
                      onFocus={(e) => e.target.select()}
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        if (v && v !== p.name) renameProject(p.id, v);
                        setEditingProjectId(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.nativeEvent.isComposing) return; // 拼音组词期间不响应按键
                        if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
                        if (e.key === 'Escape') { (e.target as HTMLInputElement).value = p.name; (e.target as HTMLInputElement).blur(); }
                      }}
                      onClick={(e) => e.stopPropagation()}
                      className="flex-1 min-w-0 rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-1 py-0.5 text-xs text-zinc-900 dark:text-zinc-100 outline-none"
                    />
                  ) : (
                    <button
                      onClick={() => { switchProject(p.id); setExpandedProjects((prev) => ({ ...prev, [p.id]: true })); }}
                      className={cn('flex-1 text-left text-xs truncate py-1', p.id === activeProjectId ? 'font-semibold text-zinc-900 dark:text-zinc-100' : 'text-zinc-600 dark:text-zinc-400')}
                    >{p.name}</button>
                  )}
                  <span className="text-[9px] text-zinc-300 dark:text-zinc-500 px-1 flex-shrink-0">{pSessions.length}</span>
                  {/* hover 操作按钮 */}
                  <div className="absolute right-1 top-1/2 -translate-y-1/2 hidden group-hover:flex gap-0.5 bg-white dark:bg-zinc-800 px-1 rounded">
                    <button onClick={() => setEditingProjectId(p.id)} className="text-[9px] text-zinc-400 hover:text-zinc-600 px-0.5" title="改名">改</button>
                    {/* 固定项目（默认项目/导入的 Sessions）不可删除：置灰，点击时弹应用内提示；store 层 deleteProject 有硬拦截兜底 */}
                    <button
                      onClick={() => setPendingDelete({ kind: 'project', id: p.id, name: p.name, blocked: !!p.pinned })}
                      className={cn('text-[9px] px-0.5', p.pinned ? 'text-zinc-300 dark:text-zinc-600' : 'text-red-400 hover:text-red-600')}
                      title={p.pinned ? '固定项目不可删除' : '删除'}
                    >删</button>
                  </div>
                </div>
                {/* 项目内 Session 列表 */}
                {expanded && (
                  <div className="ml-3 border-l border-zinc-100 dark:border-zinc-700/60 pl-1">
                    {pSessions.map((s) => (
                      <div
                        key={s.id}
                        className={cn(
                          'group relative rounded-md transition-colors px-1.5 py-1',
                          s.id === activeSessionId
                            ? 'bg-zinc-100 dark:bg-zinc-700'
                            : 'hover:bg-zinc-50 dark:hover:bg-zinc-700/50',
                        )}
                      >
                        {editingSessionId === s.id ? (
                          /* 内联改名：Electron 不支持 window.prompt()，改用 input 草稿，Enter/失焦提交，Esc 取消 */
                          <input
                            key={s.id}
                            defaultValue={s.name}
                            autoFocus
                            onFocus={(e) => e.target.select()}
                            onBlur={(e) => {
                              const v = e.target.value.trim();
                              if (v && v !== s.name) renameSession(s.id, v);
                              setEditingSessionId(null);
                            }}
                            onKeyDown={(e) => {
                              if (e.nativeEvent.isComposing) return; // 拼音组词期间不响应按键
                              if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
                              if (e.key === 'Escape') { (e.target as HTMLInputElement).value = s.name; (e.target as HTMLInputElement).blur(); }
                            }}
                            onClick={(e) => e.stopPropagation()}
                            className="w-full rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-1 py-0.5 text-xs text-zinc-900 dark:text-zinc-100 outline-none"
                          />
                        ) : (
                          <button
                            onClick={() => switchSession(s.id)}
                            className={cn(
                              'flex-1 text-left text-xs truncate block w-full',
                              s.id === activeSessionId
                                ? 'font-semibold text-zinc-900 dark:text-zinc-100'
                                : 'text-zinc-600 dark:text-zinc-400',
                            )}
                          >
                            {s.name}
                          </button>
                        )}
                        {/* hover 操作按钮 */}
                        <div className="absolute right-1 top-1/2 -translate-y-1/2 hidden group-hover:flex gap-0.5 bg-white dark:bg-zinc-800 px-1 rounded">
                          <button onClick={() => setEditingSessionId(s.id)} className="text-[9px] text-zinc-400 hover:text-zinc-600 px-0.5" title="改名">改</button>
                          <button onClick={() => duplicateSession(s.id)} className="text-[9px] text-zinc-400 hover:text-zinc-600 px-0.5" title="复制">复</button>
                          <button onClick={() => setPendingMove({ id: s.id, name: s.name, fromPid: s.projectId ?? DEFAULT_PROJECT_ID })} className="text-[9px] text-zinc-400 hover:text-zinc-600 px-0.5" title="移动到其他项目">移</button>
                          <button onClick={() => setPendingDelete({ kind: 'session', id: s.id, name: s.name })} className="text-[9px] text-red-400 hover:text-red-600 px-0.5" title="删除">删</button>
                        </div>
                      </div>
                    ))}
                    <button
                      onClick={() => createSession(undefined, p.id)}
                      className="w-full text-left px-1.5 py-1 text-[10px] mt-0.5 rounded text-zinc-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 dark:hover:text-blue-400 transition-colors"
                      title="在此项目下新建 Session"
                    >+ 新建 Session</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* 底部工具栏 */}
        <div className={cn(
          'border-t border-zinc-200 dark:border-zinc-700',
          sidebarCollapsed ? 'px-1 py-2 flex flex-col items-center gap-1.5' : 'px-2 py-2 flex flex-col gap-1',
        )}>
          {sidebarCollapsed ? (
            <>
              <button onClick={undo} className="rounded p-1 text-xs text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-700" title="撤销">↩</button>
              <button onClick={redo} className="rounded p-1 text-xs text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-700" title="重做">↪</button>
              <button onClick={() => setSearchOpen(true)} className="rounded p-1 text-xs text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-700" title="搜索"><SearchIcon className="h-3.5 w-3.5" /></button>
              <button onClick={() => setOutlineOpen(!outlineOpen)} className={cn('rounded p-1 text-xs', outlineOpen ? 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400' : 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-700')} title="大纲"><OutlineIcon className="h-3.5 w-3.5" /></button>
              <button onClick={toggleAssembleMode} className={cn('rounded p-1 text-xs', assembleMode ? 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400' : 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-700')} title="拼装"><AssembleIcon className="h-3.5 w-3.5" /></button>
              <button onClick={() => setSettingsOpen(true)} className="rounded p-1 text-xs text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-700" title="设置"><SettingsIcon className="h-3.5 w-3.5" /></button>
            </>
          ) : (
            <>
              <div className="flex items-center gap-1">
                <button onClick={undo} className="flex-1 rounded px-1.5 py-1 text-[10px] text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-700 text-left" title="撤销 (Ctrl+Z)">撤销</button>
                <button onClick={redo} className="flex-1 rounded px-1.5 py-1 text-[10px] text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-700 text-left" title="重做 (Ctrl+Shift+Z)">重做</button>
              </div>
              <div className="flex items-center gap-1">
                <button onClick={() => setSearchOpen(true)} className="flex-1 flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-700 text-left" title="搜索 (Cmd+K)"><SearchIcon className="h-3 w-3" /> 搜索</button>
                <button onClick={() => setOutlineOpen(!outlineOpen)} className={cn('flex-1 flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-left', outlineOpen ? 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400' : 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-700')} title="大纲面板"><OutlineIcon className="h-3 w-3" /> 大纲</button>
              </div>
              <div className="flex items-center gap-1">
                <button onClick={toggleAssembleMode} className={cn('flex-1 flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-left', assembleMode ? 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400' : 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-700')} title="拼装模式"><AssembleIcon className="h-3 w-3" /> 拼装</button>
                <button onClick={() => setSettingsOpen(true)} className="flex-1 flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-700 text-left" title="设置"><SettingsIcon className="h-3 w-3" /> 设置</button>
              </div>
            </>
          )}
          {/* API 状态 */}
          <div className={cn('flex justify-center', sidebarCollapsed ? '' : 'pt-1')}>
            <span className={cn(
              'rounded-full px-1.5 py-0.5 text-[8px] font-medium',
              hasApiKey ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
              sidebarCollapsed && 'px-1',
            )}>
              {sidebarCollapsed ? (hasApiKey ? 'OK' : '--') : (hasApiKey ? 'API 已配置' : 'Mock 模式')}
            </span>
          </div>
          {!sidebarCollapsed && isElectron && (
            <span className="text-center text-[9px] text-green-600 dark:text-green-400 font-medium">Desktop</span>
          )}
        </div>
      </aside>

      {/* ===== 主画布 ===== */}
      <main className="flex-1 relative">
        <Canvas />
        {outlineOpen && <OutlinePanel />}
      </main>

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      {searchOpen && <SearchPanel onClose={() => setSearchOpen(false)} />}

      {/* Q6：激活 Session 被外部修改/删除时的确认弹窗（不自动 reload，避免打断进行中的编辑） */}
      {externalConflict && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20">
          <div className="w-80 rounded-xl border bg-white border-zinc-200 dark:bg-zinc-800 dark:border-zinc-700 shadow-xl p-4">
            <div className="text-sm text-zinc-900 dark:text-zinc-100">
              {externalConflict.kind === 'deleted'
                ? '激活 Session 的文件已被外部删除。保留当前编辑将重新写回文件。'
                : '激活 Session 已被外部修改。重新载入磁盘版本将覆盖当前未落盘的编辑。'}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => resolveExternalConflict(false)}
                className="rounded px-3 py-1 text-xs text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-700"
              >保留当前编辑</button>
              {externalConflict.kind === 'modified' && (
                <button
                  autoFocus
                  onClick={() => resolveExternalConflict(true)}
                  className="rounded px-3 py-1 text-xs bg-blue-500 text-white hover:bg-blue-600"
                >重新载入</button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 移动 Session：选择目标项目（排除当前所在项目） */}
      {pendingMove && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20" onClick={() => setPendingMove(null)}>
          <div className="w-72 rounded-xl border bg-white border-zinc-200 dark:bg-zinc-800 dark:border-zinc-700 shadow-xl p-4" onClick={(e) => e.stopPropagation()}>
            <div className="text-sm text-zinc-900 dark:text-zinc-100">移动「{pendingMove.name}」到项目：</div>
            <div className="mt-2 max-h-60 overflow-y-auto">
              {sortedProjects.filter((p) => p.id !== pendingMove.fromPid).map((p) => (
                <button
                  key={p.id}
                  autoFocus={p.id === sortedProjects.find((x) => x.id !== pendingMove.fromPid)?.id}
                  onClick={() => { moveSession(pendingMove.id, p.id); setPendingMove(null); }}
                  className="block w-full text-left rounded px-2 py-1.5 text-xs text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-700"
                >{p.name}</button>
              ))}
              {sortedProjects.filter((p) => p.id !== pendingMove.fromPid).length === 0 && (
                <div className="px-2 py-1.5 text-xs text-zinc-400">无其他项目可移动</div>
              )}
            </div>
            <div className="mt-3 flex justify-end">
              <button onClick={() => setPendingMove(null)} className="rounded px-3 py-1 text-xs text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-700">取消</button>
            </div>
          </div>
        </div>
      )}

      {/* 删除确认弹窗（替代原生 confirm/alert，Electron 中不可靠） */}
      {pendingDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20" onClick={() => setPendingDelete(null)}>
          <div className="w-72 rounded-xl border bg-white border-zinc-200 dark:bg-zinc-800 dark:border-zinc-700 shadow-xl p-4" onClick={(e) => e.stopPropagation()}>
            {pendingDelete.kind === 'project' && pendingDelete.blocked ? (
              <>
                <div className="text-sm text-zinc-900 dark:text-zinc-100">「{pendingDelete.name}」为固定项目，不可删除</div>
                <div className="mt-4 flex justify-end">
                  <button autoFocus onClick={() => setPendingDelete(null)} className="rounded px-3 py-1 text-xs text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-700">知道了</button>
                </div>
              </>
            ) : (
              <>
                <div className="text-sm text-zinc-900 dark:text-zinc-100">
                  {pendingDelete.kind === 'project'
                    ? `删除项目「${pendingDelete.name}」及其所有 Session?`
                    : `删除 Session「${pendingDelete.name}」?`}
                </div>
                <div className="mt-4 flex justify-end gap-2">
                  <button onClick={() => setPendingDelete(null)} className="rounded px-3 py-1 text-xs text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-700">取消</button>
                  <button
                    autoFocus
                    onClick={() => {
                      if (pendingDelete.kind === 'project') deleteProject(pendingDelete.id);
                      else deleteSession(pendingDelete.id);
                      setPendingDelete(null);
                    }}
                    className="rounded px-3 py-1 text-xs bg-red-500 text-white hover:bg-red-600"
                  >删除</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
