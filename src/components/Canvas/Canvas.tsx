/**
 * src/components/Canvas/Canvas.tsx
 * 画布容器：React Flow 初始化、节点/边注册、交互事件。
 * v0.3: 拼装模式 + 右键菜单 + label 边 + session edges 适配。
 */
import { useCallback, useMemo, useEffect, useState, useRef } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, Controls,
  useReactFlow, useNodesState, useEdgesState,
  Connection, Edge, Node, BackgroundVariant, NodeChange, EdgeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCanvasStore } from '@/store/useCanvasStore';
import { useChatStore } from '@/store/useChatStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { ChatNode } from '@/components/ChatNode/ChatNode';
import { bfsCanReach } from '@/lib/contextBuilder';
import { cn } from '@/lib/utils';
import { useElectron } from '@/hooks/useElectron';
import { SearchIcon, CopyIcon, TrashIcon } from '@/components/icons';

const nodeTypes = { chat: ChatNode };

function Toast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  useEffect(() => { const t = setTimeout(onDismiss, 3000); return () => clearTimeout(t); }, [onDismiss]);
  return (<div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white shadow-lg dark:bg-zinc-100 dark:text-zinc-900">{message}</div>);
}

interface ContextMenuState {
  x: number; y: number;
  selectedText: string;
  sourceNodeId: string;
}

interface PaneMenuState {
  x: number; y: number;
  flowPos: { x: number; y: number };
}

interface NodeMenuState {
  x: number; y: number;
  nodeId: string;
}

function CanvasInner() {
  const session = useCanvasStore((s) => s.session);
  const addNode = useCanvasStore((s) => s.addNode);
  const addEdge = useCanvasStore((s) => s.addEdge);
  const updateEdge = useCanvasStore((s) => s.updateEdge);
  const deleteNodeFn = useCanvasStore((s) => s.deleteNode);
  const duplicateNode = useCanvasStore((s) => s.duplicateNode);
  const setViewport = useCanvasStore((s) => s.setViewport);
  const undo = useCanvasStore((s) => s.undo);
  const redo = useCanvasStore((s) => s.redo);
  const setSelectedNode = useCanvasStore((s) => s.setSelectedNode);
  const selectedNodeId = useCanvasStore((s) => s.selectedNodeId);
  const updateNode = useCanvasStore((s) => s.updateNode);
  const clearNodeMessages = useChatStore((s) => s.clearNodeMessages);
  const assembleMode = useCanvasStore((s) => s.assembleMode);
  const assembleNodeIds = useCanvasStore((s) => s.assembleNodeIds);
  const addToAssemble = useCanvasStore((s) => s.addToAssemble);
  const removeFromAssemble = useCanvasStore((s) => s.removeFromAssemble);

  const { isElectron } = useElectron();
  const { screenToFlowPosition } = useReactFlow();
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [copiedNodeId, setCopiedNodeId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [paneMenu, setPaneMenu] = useState<PaneMenuState | null>(null);
  const [nodeMenu, setNodeMenu] = useState<NodeMenuState | null>(null);
  const mousePosRef = useRef({ x: 0, y: 0 });

  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node>([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // 主题感知：连线颜色需区分深浅色
  const theme = useSettingsStore((s) => s.theme);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  const isDark = theme === 'dark' || (theme === 'system' && systemDark);

  const nodesArray = useMemo(() => Object.values(session.nodes), [session.nodes]);
  useEffect(() => {
    setRfNodes(nodesArray.map((n) => ({
      id: n.id, type: 'chat', position: n.position,
      data: { ...n, isAssemble: assembleNodeIds.includes(n.id) },
      selected: selectedNodeId === n.id,
    })));
  }, [nodesArray, selectedNodeId, assembleNodeIds, setRfNodes]);

  const edgesArray = useMemo(() => Object.values(session.edges), [session.edges]);
  useEffect(() => {
    // 浅色模式：连线使用 Claude 橙色系；深色模式保持原锌灰色
    const inheritStroke = isDark ? '#71717A' : '#D97757';
    const referenceStroke = isDark ? '#A1A1AA' : '#E0A88D';
    setRfEdges(edgesArray.map((e) => ({
      id: e.id, source: e.source, target: e.target, type: 'smoothstep',
      style: { stroke: e.edgeType === 'reference' ? referenceStroke : inheritStroke, strokeDasharray: e.edgeType === 'reference' ? '5 5' : undefined, strokeWidth: 2 },
      label: e.label ?? (e.edgeType === 'reference' ? '引用' : undefined),
      labelStyle: { fontSize: 10, fill: isDark ? '#A1A1AA' : '#C9836A' },
    })));
  }, [edgesArray, isDark, setRfEdges]);

  const relatedSets = useMemo(() => {
    if (!selectedNodeId) return { upstream: new Set<string>(), downstream: new Set<string>() };
    const upstream = new Set<string>(), downstream = new Set<string>();
    const inAdj = new Map<string, string[]>();
    for (const e of edgesArray) { if (!inAdj.has(e.target)) inAdj.set(e.target, []); inAdj.get(e.target)!.push(e.source); }
    const q1 = [selectedNodeId]; const v1 = new Set(q1);
    while (q1.length > 0) { const cur = q1.shift()!; for (const src of inAdj.get(cur) ?? []) { if (!v1.has(src)) { v1.add(src); upstream.add(src); q1.push(src); } } }
    const outAdj = new Map<string, string[]>();
    for (const e of edgesArray) { if (!outAdj.has(e.source)) outAdj.set(e.source, []); outAdj.get(e.source)!.push(e.target); }
    const q2 = [selectedNodeId]; const v2 = new Set(q2);
    while (q2.length > 0) { const cur = q2.shift()!; for (const tgt of outAdj.get(cur) ?? []) { if (!v2.has(tgt)) { v2.add(tgt); downstream.add(tgt); q2.push(tgt); } } }
    return { upstream, downstream };
  }, [selectedNodeId, edgesArray]);

  const handleNodesChange = useCallback((changes: NodeChange<Node>[]) => {
    onNodesChange(changes);
    for (const ch of changes) {
      if (ch.type === 'remove') { deleteNodeFn(ch.id); clearNodeMessages(ch.id); }
      // 拖动中 (dragging=true) 仅更新 React Flow 本地状态，避免每帧深拷贝 session + 写 localStorage；
      // 拖拽结束 (dragging=false) 或非拖拽的位置变更才一次性写入 store
      if (ch.type === 'position' && ch.position && !ch.dragging) updateNode(ch.id, { position: ch.position });
      if (ch.type === 'select' && ch.selected) setSelectedNode(ch.id);
    }
  }, [onNodesChange, deleteNodeFn, clearNodeMessages, updateNode, setSelectedNode]);

  const handleEdgesChange = useCallback((changes: EdgeChange<Edge>[]) => { onEdgesChange(changes); }, [onEdgesChange]);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('.react-flow__node') || target.closest('.react-flow__edge')) return;
    const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    addNode({ x: position.x - 250, y: position.y - 100 });
  }, [addNode, screenToFlowPosition]);

  const handleConnect = useCallback((conn: Connection) => {
    if (!conn.source || !conn.target) return;
    if (bfsCanReach(useCanvasStore.getState().session.edges, conn.source, conn.target)) {
      setToastMsg('禁止聊天消息流自环'); return;
    }
    addEdge(conn.source, conn.target, 'inherit');
  }, [addEdge]);

  const handleEdgeClick = useCallback((_e: React.MouseEvent, edge: Edge) => {
    const original = session.edges[edge.id];
    if (!original) return;
    updateEdge(edge.id, { edgeType: original.edgeType === 'inherit' ? 'reference' : 'inherit' });
  }, [session.edges, updateEdge]);

  // ★ 右键菜单: 区分空白处 / 卡片 / 选中术语
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    const selectedText = window.getSelection()?.toString().trim();
    const nodeEl = (e.target as HTMLElement).closest('.react-flow__node');

    if (nodeEl) {
      // 右键卡片
      e.preventDefault();
      const nodeId = nodeEl.getAttribute('data-id') ?? '';
      if (!nodeId) return;

      if (selectedText && selectedText.length >= 2) {
        // 有选中文字 → 显示术语追问菜单
        setContextMenu({ x: e.clientX, y: e.clientY, selectedText, sourceNodeId: nodeId });
      } else {
        // 无选中文字 → 显示卡片操作菜单
        setNodeMenu({ x: e.clientX, y: e.clientY, nodeId });
      }
      return;
    }

    // 右键空白处
    e.preventDefault();
    const flowPos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    setPaneMenu({ x: e.clientX, y: e.clientY, flowPos });
  }, [screenToFlowPosition]);

  // 拼装模式: 点击卡片加入/移出拼装列表
  const handleNodeClick = useCallback((_e: React.MouseEvent, node: Node) => {
    if (assembleMode) {
      if (assembleNodeIds.includes(node.id)) removeFromAssemble(node.id);
      else addToAssemble(node.id);
    } else {
      setSelectedNode(node.id);
    }
  }, [assembleMode, assembleNodeIds, addToAssemble, removeFromAssemble, setSelectedNode]);

  useEffect(() => {
    const h = (e: MouseEvent) => { mousePosRef.current = { x: e.clientX, y: e.clientY }; };
    window.addEventListener('mousemove', h); return () => window.removeEventListener('mousemove', h);
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return;
      if (e.metaKey || e.ctrlKey) {
        if (e.key === 'c' && !e.shiftKey && selectedNodeId) { e.preventDefault(); setCopiedNodeId(selectedNodeId); setToastMsg('已复制卡片'); }
        if (e.key === 'v' && !e.shiftKey && copiedNodeId) { e.preventDefault(); const pos = screenToFlowPosition({ x: mousePosRef.current.x, y: mousePosRef.current.y }); duplicateNode(copiedNodeId, pos.x - 250, pos.y - 100); }
        if (e.key === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
        if (e.key === 's') { e.preventDefault(); void (async () => { const json = await useCanvasStore.getState().exportSessionJson(); const blob = new Blob([json], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `chat-canvas-${Date.now()}.json`; a.click(); URL.revokeObjectURL(url); setToastMsg('已导出全部 Session JSON'); })(); }
      }
    }
    window.addEventListener('keydown', onKeyDown); return () => window.removeEventListener('keydown', onKeyDown);
  }, [undo, redo, selectedNodeId, copiedNodeId, duplicateNode, screenToFlowPosition]);

  useEffect(() => {
    if (!isElectron) return;
    window.electronAPI!.onMenuNewCard(() => {
      const pos = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
      addNode({ x: pos.x - 250, y: pos.y - 100 });
    });
  }, [isElectron, addNode, screenToFlowPosition]);

  // 导出拼装 Markdown
  function exportAssembleMarkdown() {
    const { assembleNodeIds } = useCanvasStore.getState();
    if (assembleNodeIds.length === 0) { setToastMsg('拼装列表为空'); return; }
    const { session } = useCanvasStore.getState();
    let md = '# 拼装导出\n\n';
    for (const nid of assembleNodeIds) {
      const n = session.nodes[nid];
      if (!n) continue;
      md += `## ${n.title}\n\n`;
      for (const m of n.messages) {
        if (m.status !== 'done') continue;
        if (m.role === 'user') md += `**问**: ${m.content}\n\n`;
        else if (m.role === 'assistant') md += `${m.content}\n\n`;
      }
    }
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `assemble-${Date.now()}.md`; a.click();
    URL.revokeObjectURL(url);
    setToastMsg('拼装 Markdown 已导出');
  }

  return (<>
    {toastMsg && <Toast message={toastMsg} onDismiss={() => setToastMsg(null)} />}
    {assembleMode && (
      <div className="absolute top-2 left-2 z-40 rounded-lg bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800 px-3 py-2 text-xs text-blue-600 dark:text-blue-400 flex items-center gap-2">
        <span>拼装模式: 已选 {assembleNodeIds.length} 张卡片</span>
        <button onClick={exportAssembleMarkdown} className="rounded bg-blue-500 text-white px-2 py-0.5 text-[10px]">导出 MD</button>
        <button onClick={() => useCanvasStore.getState().toggleAssembleMode()} className="text-blue-400 hover:text-blue-600">退出</button>
      </div>
    )}
    <ReactFlow nodes={rfNodes} edges={rfEdges} onNodesChange={handleNodesChange} onEdgesChange={handleEdgesChange} nodeTypes={nodeTypes}
      onDoubleClick={handleDoubleClick} onConnect={handleConnect} onEdgeClick={handleEdgeClick}
      onContextMenu={handleContextMenu}
      onMoveEnd={(_, vp) => setViewport({ x: vp.x, y: vp.y, zoom: vp.zoom })}
      onNodeClick={handleNodeClick} onPaneClick={() => setSelectedNode(null)}
      defaultViewport={{ x: session.viewport.x, y: session.viewport.y, zoom: session.viewport.zoom }}
      minZoom={0.1} maxZoom={2} fitView={nodesArray.length === 0}
      proOptions={{ hideAttribution: true }} deleteKeyCode={['Delete', 'Backspace']} multiSelectionKeyCode={['Meta', 'Ctrl']} selectionKeyCode={['Shift']}>
      <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#E2DACD" className="dark:!bg-zinc-900" />
      <Controls className={cn('!bg-white !border-zinc-200 !shadow-sm', 'dark:!bg-zinc-800 dark:!border-zinc-700')} showInteractive={false} />
    </ReactFlow>

    {/* 右键菜单 — 术语追问 */}
    {contextMenu && (
      <div className="fixed z-50 rounded-lg border bg-white dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700 shadow-lg py-1" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={() => setContextMenu(null)}>
        <button className="w-full text-left px-3 py-1.5 text-xs text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700"
          onClick={() => {
            const { selectedText, sourceNodeId } = contextMenu;
            const srcNode = useCanvasStore.getState().session.nodes[sourceNodeId];
            if (!srcNode) return;
            const existing = Object.values(useCanvasStore.getState().session.nodes).find((n) => n.title === selectedText);
            if (existing) {
              addEdge(sourceNodeId, existing.id, 'inherit', selectedText);
              setContextMenu(null);
              return;
            }
            const pos = { x: srcNode.position.x + 400, y: srcNode.position.y + 60 };
            const newId = addNode(pos, selectedText);
            addEdge(sourceNodeId, newId, 'inherit', selectedText);
            useCanvasStore.getState().updateNode(newId, { forkLabel: `请详细解释 ${selectedText}` });
            setContextMenu(null);
          }}>
          <span className="flex items-center gap-1.5"><SearchIcon className="h-3 w-3" /> 追问此概念 "{contextMenu.selectedText.slice(0, 20)}{contextMenu.selectedText.length > 20 ? '…' : ''}"</span>
        </button>
      </div>
    )}

    {/* 右键菜单 — 画布空白处 */}
    {paneMenu && (
      <div className="fixed z-50 rounded-lg border bg-white dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700 shadow-lg py-1" style={{ left: paneMenu.x, top: paneMenu.y }} onClick={() => setPaneMenu(null)}>
        <button className="w-full text-left px-3 py-1.5 text-xs text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700"
          onClick={() => {
            addNode({ x: paneMenu.flowPos.x - 250, y: paneMenu.flowPos.y - 100 });
            setPaneMenu(null);
          }}>
          + 在当前位置新建卡片
        </button>
      </div>
    )}

    {/* 右键菜单 — 卡片 */}
    {nodeMenu && (
      <div className="fixed z-50 rounded-lg border bg-white dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700 shadow-lg py-1" style={{ left: nodeMenu.x, top: nodeMenu.y }} onClick={() => setNodeMenu(null)}>
        <button className="w-full text-left px-3 py-1.5 text-xs text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700"
          onClick={() => {
            duplicateNode(nodeMenu.nodeId, 40, 40);
            setNodeMenu(null);
          }}>
          <span className="flex items-center gap-1.5"><CopyIcon className="h-3 w-3" /> 复制卡片</span>
        </button>
        <button className="w-full text-left px-3 py-1.5 text-xs text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
          onClick={() => {
            deleteNodeFn(nodeMenu.nodeId);
            clearNodeMessages(nodeMenu.nodeId);
            setNodeMenu(null);
          }}>
          <span className="flex items-center gap-1.5"><TrashIcon className="h-3 w-3" /> 删除卡片</span>
        </button>
      </div>
    )}
  </>);
}

export function Canvas() { return (<ReactFlowProvider><CanvasInner /></ReactFlowProvider>); }
