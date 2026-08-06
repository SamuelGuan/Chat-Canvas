/**
 * src/components/NoteNode/NoteNode.tsx
 * 笔记卡片：支持新建笔记 / 导入 .md 文件两种模式，markdown 编辑 + 实时预览。
 * v0.5: 左编辑区(textarea) / 右预览区(react-markdown)，Ctrl+S 立即落盘。
 */
import { useState, useEffect, useCallback, useRef, memo } from 'react';
import { Handle, Position, NodeProps, NodeResizer } from '@xyflow/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkSupersub from 'remark-supersub';
import rehypeMathjax from 'rehype-mathjax/browser';
import rehypeHighlight from 'rehype-highlight';
import { useCanvasStore } from '@/store/useCanvasStore';
import { GraphNode } from '@/types';
import { formatTime, normalizeMathDelimiters, shallowSkipPosition } from '@/lib/utils';
import 'highlight.js/styles/github-dark.css';

interface NoteNodeData extends GraphNode {
  selected?: boolean;
}

type NoteMode = 'select' | 'edit';

export const NoteNode = memo(function NoteNode({ id, data, selected }: NodeProps) {
  const node = (data ?? {}) as unknown as NoteNodeData;
  const updateNode = useCanvasStore((s) => s.updateNode);
  const hasContent = !!(node.markdownContent ?? '').trim();
  const [content, setContent] = useState(node.markdownContent ?? '');
  const [preview, setPreview] = useState(false);
  const [mode, setMode] = useState<NoteMode>(hasContent ? 'edit' : 'select');
  const previewRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // MathJax 重新排版：预览区渲染新公式后触发
  useEffect(() => {
    if (!preview || !previewRef.current) return;
    const win = window as any;
    if (win.MathJax?.typesetPromise) {
      win.MathJax.typesetPromise([previewRef.current]).catch(() => {});
    }
  }, [preview, content]);

  // 外部更新时同步（如 undo/redo），不在依赖中包含 content 避免输入时回写旧值
  useEffect(() => {
    const s = useCanvasStore.getState();
    const current = s.session.nodes[id];
    if (current?.markdownContent !== undefined && current.markdownContent !== content) {
      setContent(current.markdownContent);
    }
    // content 不在依赖中：只在外部 store 变更时同步，用户输入不受影响
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.markdownContent, id]);

  const handleChange = useCallback((val: string) => {
    setContent(val);
  }, []);

  // 阻止滚轮事件冒泡到 ReactFlow，区隔卡片内滚动与画布缩放
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.stopPropagation();
  }, []);

  /** 落盘：Ctrl+S 或失焦时自动保存 */
  const save = useCallback(() => {
    updateNode(id, { markdownContent: content });
  }, [id, content, updateNode]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        save();
      }
    },
    [save]
  );

  /** 导入 .md 文件 */
  const handleImportMd = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const text = reader.result as string;
        setContent(text);
        setMode('edit');
        // 用文件名更新标题
        const name = file.name.replace(/\.md$/i, '');
        if (!node.title?.trim() || node.title === '笔记卡片 1') {
          updateNode(id, { title: name });
        }
        updateNode(id, { markdownContent: text });
      };
      reader.readAsText(file);
      // 清空 input 以允许重新选择同一文件
      e.target.value = '';
    },
    [id, node.title, updateNode]
  );

  return (
    <div
      className="relative rounded-lg border shadow-md bg-[#FFFDF7] dark:bg-zinc-800 border-amber-200 dark:border-amber-800 min-w-[400px]"
      style={{ width: node.width || 1200, height: node.height || 1000 }}
    >
      <NodeResizer minWidth={300} minHeight={200} isVisible={selected} lineStyle={{ borderColor: '#D97757' }} />

      {/* 标题栏 */}
      <div className="flex items-center justify-between border-b border-amber-200 dark:border-amber-800 px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-amber-600 dark:text-amber-400 text-xs shrink-0">[Note]</span>
          <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100 truncate">{node.title}</span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => setPreview(!preview)}
            className="text-[10px] px-1.5 py-0.5 rounded text-zinc-400 hover:text-zinc-600 hover:bg-amber-100 dark:hover:bg-amber-900/30"
            title={preview ? '编辑' : '预览'}
          >
            {preview ? 'Edit' : 'Preview'}
          </button>
          <span className="text-[9px] text-zinc-400">{formatTime(node.createdAt)}</span>
        </div>
      </div>

      {/* 内容区 (nodrag: 拖动仅由标题栏或卡片边缘触发, onWheel stopPropagation 隔离卡片滚动与画布缩放) */}
      <div className="flex h-[calc(100%-40px)] nodrag" onWheel={handleWheel}>
        {mode === 'select' ? (
          /* 模式选择：新建笔记 or 导入 .md */
          <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8">
            <div className="text-5xl opacity-15">&#x1F4DD;</div>
            <p className="text-sm text-zinc-400">选择笔记来源</p>
            <div className="flex gap-3">
              <button
                onClick={() => setMode('edit')}
                className="px-5 py-2.5 rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 text-sm text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/40 transition-colors"
              >
                &#x270E; 新建笔记
              </button>
              <button
                onClick={handleImportMd}
                className="px-5 py-2.5 rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 text-sm text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/40 transition-colors"
              >
                &#x1F4C2; 导入 .md
              </button>
            </div>
            <span className="text-[10px] text-zinc-300 dark:text-zinc-600">支持 GFM 表格、代码高亮、MathJax 数学公式</span>
          </div>
        ) : preview ? (
          <div ref={previewRef} className="flex-1 overflow-y-auto p-3 prose prose-sm dark:prose-invert max-w-none font-medium">
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkMath, remarkSupersub]}
              rehypePlugins={[[rehypeMathjax, { tex: { inlineMath: [['$', '$']], displayMath: [['$$', '$$']] } }], rehypeHighlight]}
            >
              {content ? normalizeMathDelimiters(content) : '*无内容*'}
            </ReactMarkdown>
          </div>
        ) : (
          <>
            <textarea
              className="flex-1 w-full resize-none bg-transparent p-3 text-sm text-zinc-800 dark:text-zinc-200 outline-none font-mono leading-relaxed"
              value={content}
              onChange={(e) => handleChange(e.target.value)}
              onBlur={save}
              onKeyDown={handleKeyDown}
              placeholder="在此编写 Markdown 笔记...&#10;&#10;支持 GFM 表格、代码高亮、MathJax 数学公式&#10;Ctrl+S 立即保存"
              spellCheck={false}
            />
            {/* 导入按钮（编辑模式下也可导入） */}
            <button
              onClick={handleImportMd}
              className="absolute bottom-2 right-2 text-[10px] px-2 py-1 rounded text-zinc-400 hover:text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/20"
              title="导入 .md 文件（覆盖当前内容）"
            >
              &#x1F4C2; 导入
            </button>
          </>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".md,.markdown,.txt"
        className="hidden"
        onChange={handleFileChange}
      />

      {/* Handle: 顶部入，底部出 */}
      <Handle type="target" position={Position.Top} className="!bg-amber-400 !w-2.5 !h-2.5" />
      <Handle type="source" position={Position.Bottom} className="!bg-amber-400 !w-2.5 !h-2.5" />
    </div>
  );
}, shallowSkipPosition);

