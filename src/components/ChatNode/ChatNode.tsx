/**
 * src/components/ChatNode/ChatNode.tsx
 * 画布上的聊天卡片节点。
 * v0.3: 消息级分支(⊕) + 选中术语递归追问 + 卡片级 system prompt 编辑。
 */
import { useState, useRef, useEffect, useCallback, memo } from 'react';
import { Handle, Position, NodeProps, NodeResizer } from '@xyflow/react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import remarkSupersub from 'remark-supersub';
import rehypeMathjax from 'rehype-mathjax/svg';
import { useChatStore } from '@/store/useChatStore';
import { useCanvasStore } from '@/store/useCanvasStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { streamChat } from '@/lib/llm';
import { mockStream } from '@/lib/mockStream';
import { buildContext } from '@/lib/contextBuilder';
import { cn, formatTime, mathjaxTexOptions, normalizeMathDelimiters, shallowSkipPosition } from '@/lib/utils';
import { GraphNode, ChatMessage, ContentPart, MessageContent } from '@/types';
import { SettingsIcon, PencilIcon, CopyIcon, ImageIcon } from '@/components/icons';
import 'highlight.js/styles/github-dark.css';

interface ChatNodeData extends GraphNode {
  selected?: boolean;
}

export const ChatNode = memo(function ChatNode({ id, data, selected }: NodeProps) {
  const node = (data ?? {}) as unknown as ChatNodeData;
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  const [images, setImages] = useState<{ id: string; url: string; preview: string }[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [showPromptEditor, setShowPromptEditor] = useState(false);
  const [promptDraft, setPromptDraft] = useState('');
  const [flashMsgIds, setFlashMsgIds] = useState<Record<string, number>>({});

  const getNodeMessages = useChatStore((s) => s.getNodeMessages);
  const messages = getNodeMessages(id);

  const addU = useChatStore((s) => s.addUserMessage);
  const startS = useChatStore((s) => s.startStreaming);
  const onStart = useChatStore((s) => s.onStreamStart);
  const append = useChatStore((s) => s.appendStreamToken);
  const finish = useChatStore((s) => s.finishStreaming);
  const setErr = useChatStore((s) => s.setError);
  const editMsg = useChatStore((s) => s.editUserMessage);

  const updateNode = useCanvasStore((s) => s.updateNode);
  const addNode = useCanvasStore((s) => s.addNode);
  const addEdge = useCanvasStore((s) => s.addEdge);
  const duplicateNode = useCanvasStore((s) => s.duplicateNode);

  const settings = useSettingsStore();
  const modelId = node.model || settings.defaultModel;
  const currentProvider = settings.getProviderByModel(modelId);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  /* ===== 发送 ===== */

  async function handleSend(promptText: string) {
    if (!promptText.trim() || isSending) return;
    let content: MessageContent = promptText;
    if (images.length > 0) {
      const parts: ContentPart[] = [];
      if (promptText.trim()) parts.push({ type: 'text', text: promptText });
      for (const img of images) parts.push({ type: 'image_url', image_url: { url: img.url } });
      content = parts;
    }
    setInput(''); setImages([]); setIsSending(true);
    addU(id, content as string);
    const assistantId = startS(id);
    const controller = new AbortController();
    abortRef.current = controller;

    const callbacks = {
      onStart: () => onStart(id, assistantId),
      onToken: (delta: string) => append(id, assistantId, delta),
      onDone: () => {
        finish(id, assistantId);
        setFlashMsgIds((prev) => ({ ...prev, [assistantId]: Date.now() }));
        window.setTimeout(() => {
          setFlashMsgIds((prev) => {
            const next = { ...prev };
            delete next[assistantId];
            return next;
          });
        }, 1200);
        setIsSending(false);
        abortRef.current = null;
      },
      onError: (err: Error) => {
        if (err.message === 'UserAbort') finish(id, assistantId);
        else setErr(id, assistantId, err.message);
        setIsSending(false); abortRef.current = null;
      },
    };

    try {
      const session = useCanvasStore.getState().session;
      const contextMsgs = buildContext(id, session);
      const nodeHistory = (session.nodes[id]?.messages ?? []).filter((m) => m.status === 'done' && m.id !== assistantId);
      const allMessages: ChatMessage[] = [
        ...contextMsgs,
        ...nodeHistory,
        { id: 'current', role: 'user' as const, content, createdAt: Date.now(), status: 'done' as const },
      ];
      if (currentProvider?.apiKey) {
        await streamChat(allMessages, { baseURL: currentProvider.baseURL, apiKey: currentProvider.apiKey, model: modelId }, callbacks, controller.signal);
      } else {
        await mockStream(content, callbacks, controller.signal);
      }
    } catch (err) {
      if ((err as Error).message !== 'UserAbort') setErr(id, assistantId, (err as Error).message);
      else finish(id, assistantId);
      setIsSending(false);
    }
  }

  function handleStop() { abortRef.current?.abort(); }
  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(input); }
  }

  /* ===== 编辑消息 ===== */

  function startEdit(msg: ChatMessage) {
    if (isSending) return;
    setEditingMsgId(msg.id);
    setEditText(typeof msg.content === 'string' ? msg.content : '');
  }
  function confirmEdit() {
    if (!editingMsgId) return;
    const newText = editText.trim();
    if (!newText) { cancelEdit(); return; }
    editMsg(id, editingMsgId, newText);
    setEditingMsgId(null);
    handleSend(newText);
  }
  function cancelEdit() { setEditingMsgId(null); setEditText(''); }
  function copyMessage(content: MessageContent) {
    navigator.clipboard.writeText(typeof content === 'string' ? content : JSON.stringify(content));
  }

  /* ===== 图片 ===== */

  function handleImageFile(file: File) {
    if (!file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => setImages((prev) => [...prev, { id: Math.random().toString(36).slice(2), url: reader.result as string, preview: reader.result as string }]);
    reader.readAsDataURL(file);
  }
  function handlePaste(e: React.ClipboardEvent) {
    for (let i = 0; i < e.clipboardData.items.length; i++) {
      if (e.clipboardData.items[i].type.startsWith('image/')) { e.preventDefault(); handleImageFile(e.clipboardData.items[i].getAsFile()!); break; }
    }
  }
  function handleDrop(e: React.DragEvent) { e.preventDefault(); if (e.dataTransfer.files[0]) handleImageFile(e.dataTransfer.files[0]); }

  /* ===== ★ 消息级分支 (⊕ 从此分叉) ===== */

  function forkFromMessage(msgIndex: number) {
    const srcNode = useCanvasStore.getState().session.nodes[id];
    if (!srcNode) return;
    // 截取到该消息为止的消息列表
    const forkMessages = messages.slice(0, msgIndex + 1);
    const pos = { x: srcNode.position.x + 400, y: srcNode.position.y + 80 };
    const newId = addNode(pos, { title: `${srcNode.title} ·分支` });
    // 将截取的消息注入新卡片
    useCanvasStore.getState().updateNode(newId, { messages: JSON.parse(JSON.stringify(forkMessages)) });
    // 自动连线
    addEdge(id, newId, 'inherit', `分叉于 消息 #${msgIndex + 1}`);
  }

  /* ===== ★ 选中术语 → 递归追问 ===== */

  function handleContextMenu(e: React.MouseEvent, msg: ChatMessage) {
    const selectedText = window.getSelection()?.toString().trim();
    if (!selectedText || selectedText.length < 2) return;
    e.preventDefault();
    const srcNode = useCanvasStore.getState().session.nodes[id];
    if (!srcNode) return;
    // 概念去重: 检查是否已有标题匹配的卡片
    const existing = Object.values(useCanvasStore.getState().session.nodes).find(
      (n) => n.title === selectedText
    );
    if (existing) {
      const useExisting = window.confirm(`该概念已有卡片「${existing.title}」，是否直接连线到已有卡片？\n\n确定 = 连线到已有卡片\n取消 = 创建新卡片`);
      if (useExisting) {
        addEdge(id, existing.id, 'inherit', selectedText);
        return;
      }
    }
    const pos = { x: srcNode.position.x + 400, y: srcNode.position.y + 60 };
    const newId = addNode(pos, { title: selectedText });
    addEdge(id, newId, 'inherit', selectedText);
    // 预填追问
    useCanvasStore.getState().updateNode(newId, { forkLabel: `请详细解释 ${selectedText}` });
  }

  /* ===== 系统提示编辑 ===== */

  function openPromptEditor() {
    setPromptDraft(node.systemPrompt ?? '');
    setShowPromptEditor(true);
  }
  function savePromptEditor() {
    updateNode(id, { systemPrompt: promptDraft.trim() || undefined });
    setShowPromptEditor(false);
  }

  /* ===== 渲染辅助 ===== */

  const hasActiveStream = messages.some((m) => m.status === 'streaming' || m.status === 'pending');
  const inputDisabled = isSending || hasActiveStream;
  const isSelected = selected;
  const effectivePrompt = node.systemPrompt ?? settings.globalSystemPrompt;
  const hasCustomPrompt = !!node.systemPrompt;
  const isFreshNode = Date.now() - node.createdAt < 1800;

  function renderMessageStatus(msg: ChatMessage) {
    if (msg.role === 'user') {
      return '你';
    }
    if (msg.role === 'system') {
      return '上下文';
    }
    if (msg.status === 'streaming') {
      return (
        <span className="ai-breathing-status">
          <span className="ai-breathing-dot" />
          <span>AI · 生成中...</span>
        </span>
      );
    }
    if (msg.status === 'pending') {
      return (
        <span className="ai-breathing-status">
          <span className="ai-breathing-dot" />
          <span>AI · 排队中...</span>
        </span>
      );
    }
    if (msg.status === 'error') {
      return 'AI · 错误';
    }
    return 'AI';
  }

  return (
    <>
      {/* ★ 拖拽调整大小 */}
      <NodeResizer
        isVisible={isSelected}
        minWidth={500}
        minHeight={200}
        maxWidth={1200}
        maxHeight={1600}
        onResizeEnd={(_e, params) => {
          updateNode(id, { width: params.width, height: params.height });
        }}
      />
      <div className={cn(
        'rounded-[10px] border bg-white dark:bg-zinc-800',
        'chat-node-card transition-shadow duration-300',
        isFreshNode && 'chat-node-enter',
        isSelected && 'border-[#d97757]/80 dark:border-violet-300/80 chat-node-selected-glow',
        !isSelected && 'border-zinc-200 dark:border-zinc-700',
        'flex flex-col overflow-hidden',
        isSending && 'nodrag',
      )} style={{
        width: node.width ? `${node.width}px` : '500px',
        height: node.collapsed ? '44px' : (node.height ? `${node.height}px` : undefined),
        maxHeight: node.collapsed ? '44px' : undefined,
        minWidth: '500px',
      }}>
      <Handle type="target" position={Position.Top} className="!h-3 !w-3 !rounded-full !border-2 !border-zinc-400 !bg-white dark:!bg-zinc-700" />
      <div className="flex items-center gap-2 border-b px-3 py-2 border-zinc-200 dark:border-zinc-700">
        {/* 标题：本地草稿（defaultValue 非受控），Enter/失焦才提交 store。
            避免拼音 composition 被 store 回写打断，也避免每击键全量深拷贝 session */}
        <input
          key={node.title}
          defaultValue={node.title ?? ''}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v && v !== node.title) updateNode(id, { title: v });
            else e.target.value = node.title ?? '';
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return; // 拼音组词期间不响应按键
            if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
            if (e.key === 'Escape') { (e.target as HTMLInputElement).value = node.title ?? ''; (e.target as HTMLInputElement).blur(); }
          }}
          className="flex-1 bg-transparent text-sm font-medium outline-none text-zinc-900 dark:text-zinc-100"
        />
        <button onClick={openPromptEditor} className={cn('text-[10px] px-1.5 py-0.5 rounded border transition-colors', hasCustomPrompt ? 'border-blue-400 text-blue-500 bg-blue-50 dark:bg-blue-900/20' : 'border-zinc-200 dark:border-zinc-600 text-zinc-400 hover:text-zinc-600')} title={hasCustomPrompt ? '卡片级提示已设置' : '设置卡片提示'}>
          {hasCustomPrompt ? <PencilIcon className="h-3 w-3" /> : <SettingsIcon className="h-3 w-3" />}
        </button>
        <select value={node.model ?? ''} onChange={(e) => updateNode(id, { model: e.target.value })} className="rounded-md border px-2 py-0.5 text-xs border-zinc-200 dark:border-zinc-600 bg-white dark:bg-zinc-900 text-zinc-600 dark:text-zinc-400">
          <option value="">默认 ({settings.defaultModel})</option>
          {settings.providers.filter((p) => p.isEnabled).map((p) => (
            <optgroup key={p.id} label={p.name}>{p.models.map((m) => <option key={`${p.id}_${m.id}`} value={m.id}>{m.label}</option>)}</optgroup>
          ))}
        </select>
        <button onClick={() => updateNode(id, { collapsed: !node.collapsed })} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200">
          {node.collapsed ? '▸' : '▾'}
        </button>
      </div>
      {effectivePrompt && !node.collapsed && (
        <div className="border-b px-3 py-1 text-[10px] text-blue-500 dark:text-blue-400 border-zinc-100 dark:border-zinc-700/50">
          提示: {effectivePrompt.length > 50 ? effectivePrompt.slice(0, 50) + '…' : effectivePrompt}
        </div>
      )}
      {!node.collapsed && (<>
        <div ref={messagesContainerRef} className="flex-1 overflow-y-auto px-3 py-2" style={{ maxHeight: node.height ? `${node.height - 120}px` : '420px' }}>
          {messages.length === 0 && <div className="py-8 text-center text-xs text-zinc-400">{currentProvider?.apiKey ? '输入消息开始对话' : '未配置 API Key，使用 Mock 模式'}</div>}
          {messages.map((msg, msgIdx) => {
            const isEditing = editingMsgId === msg.id;
            const shouldHighlightSuccess = msg.role === 'assistant' && !!flashMsgIds[msg.id];
            return (
              <div key={msg.id} onContextMenu={(e) => handleContextMenu(e, msg)} className={cn('mb-3 rounded-lg px-3 py-2 text-sm group relative transition-shadow duration-300', shouldHighlightSuccess && 'message-success-highlight', msg.role === 'user' ? 'bg-zinc-100 dark:bg-zinc-700/50 ml-4' : msg.role === 'assistant' ? 'bg-white dark:bg-zinc-800/50 mr-4 border border-zinc-100 dark:border-zinc-700/50' : 'bg-blue-50 dark:bg-blue-900/20 text-xs mr-4')}>
                <div className="flex items-center justify-between mb-1">
                  <div className={cn('text-[10px] font-medium uppercase tracking-wide', msg.role === 'user' ? 'text-zinc-500' : msg.role === 'assistant' ? (msg.status === 'streaming' ? 'text-zinc-400' : msg.status === 'pending' ? 'text-zinc-400' : msg.status === 'error' ? 'text-red-500' : 'text-zinc-400') : 'text-blue-500')}>
                    {renderMessageStatus(msg)}
                    <span className="ml-2 font-normal opacity-60">{formatTime(msg.createdAt)}</span>
                  </div>
                  <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    {msg.role === 'assistant' && msg.status === 'done' && (
                      <button onClick={() => forkFromMessage(msgIdx)} className="text-zinc-400 hover:text-green-500 text-xs" title="从此分叉">⊕</button>
                    )}
                    {msg.role === 'user' && msg.status === 'done' && !isSending && (
                      <button onClick={() => startEdit(msg)} className="text-zinc-400 hover:text-zinc-600 text-xs" title="编辑"><PencilIcon className="h-3 w-3" /></button>
                    )}
                    {msg.role === 'assistant' && msg.status === 'done' && (
                      <button onClick={() => copyMessage(msg.content)} className="text-zinc-400 hover:text-zinc-600 text-xs" title="复制"><CopyIcon className="h-3 w-3" /></button>
                    )}
                  </div>
                </div>
                {isEditing ? (
                  <div className="flex gap-2">
                    <textarea value={editText} onChange={(e) => setEditText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); confirmEdit(); } if (e.key === 'Escape') cancelEdit(); }} className="flex-1 resize-none rounded border border-zinc-300 dark:border-zinc-600 px-2 py-1 text-sm bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 outline-none" rows={3} autoFocus />
                    <div className="flex flex-col gap-1"><button onClick={confirmEdit} className="text-green-500 text-xs hover:text-green-600">✓</button><button onClick={cancelEdit} className="text-red-400 text-xs hover:text-red-500">✕</button></div>
                  </div>
                ) : msg.role === 'assistant' || msg.role === 'system' ? (
                  <div className="prose prose-sm dark:prose-invert max-w-none break-words prose-pre:p-0 prose-pre:bg-transparent">
                    <ReactMarkdown remarkPlugins={[remarkMath, remarkGfm, remarkSupersub]} rehypePlugins={[[rehypeMathjax, mathjaxTexOptions], rehypeHighlight]}>{normalizeMathDelimiters((typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)) || (msg.status === 'streaming' ? '▋' : msg.status === 'pending' ? '⏳ 排队中...' : ''))}</ReactMarkdown>
                  </div>
                ) : (
                  <div className="whitespace-pre-wrap break-words text-zinc-700 dark:text-zinc-300">{(typeof msg.content === 'string' ? msg.content : (msg.content as any[]).filter((p: any) => p.type === 'text').map((p: any) => p.text).join(''))}</div>
                )}
              </div>
            );
          })}
          <div ref={messagesEndRef} />
        </div>
        {images.length > 0 && (<div className="flex gap-2 px-3 py-2 overflow-x-auto">{images.map((img) => (<div key={img.id} className="relative shrink-0"><img src={img.preview} alt="preview" className="h-16 w-16 rounded object-cover" /><button onClick={() => setImages((prev) => prev.filter((x) => x.id !== img.id))} className="absolute -top-1 -right-1 h-4 w-4 rounded-full bg-zinc-600 text-white text-[10px] flex items-center justify-center">✕</button></div>))}</div>)}
        <div className="border-t p-2 border-zinc-200 dark:border-zinc-700">
          {node.forkLabel && (
            <div className="mb-1 px-2 py-1 rounded bg-blue-50 dark:bg-blue-900/20 text-[10px] text-blue-500">
              {node.forkLabel}
            </div>
          )}
          <div className="flex gap-2" onPaste={handlePaste} onDrop={handleDrop} onDragOver={(e) => e.preventDefault()}>
            <textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown} placeholder={inputDisabled ? '生成中...' : '输入消息... (Enter 发送 / Shift+Enter 换行)'} disabled={inputDisabled} rows={2} className={cn('flex-1 resize-none rounded-lg border px-3 py-2 text-sm outline-none', 'border-zinc-200 dark:border-zinc-600', 'bg-zinc-50 dark:bg-zinc-900', 'text-zinc-900 dark:text-zinc-100', 'placeholder:text-zinc-400', 'focus:ring-2 focus:ring-zinc-300 dark:focus:ring-zinc-600')} />
            <button onClick={() => fileInputRef.current?.click()} className="rounded-lg border border-zinc-200 dark:border-zinc-600 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-700" title="上传图片"><ImageIcon className="h-3.5 w-3.5" /></button>
            <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={(e) => { if (e.target.files?.[0]) handleImageFile(e.target.files[0]); e.target.value = ''; }} />
            {inputDisabled ? (
              <button
                onClick={handleStop}
                className="flex items-center gap-2 rounded-lg border border-orange-300/70 bg-orange-50 px-3 py-2 text-sm font-medium text-orange-600 transition-colors hover:bg-orange-100 dark:border-red-400/40 dark:bg-red-900/20 dark:text-red-300 dark:hover:bg-red-900/30"
              >
                <span className="relative flex h-3.5 w-3.5 items-center justify-center">
                  <span className="absolute h-3.5 w-3.5 rounded-full border border-current" />
                  <span className="h-1.5 w-1.5 rounded-full bg-current" />
                </span>
                停止
              </button>
            ) : (
              <button
                onClick={() => handleSend(input)}
                disabled={!input.trim()}
                className={cn(
                  'rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                  input.trim()
                    ? 'bg-[#d97757] text-white hover:bg-[#c15f3c] dark:bg-violet-500 dark:hover:bg-violet-400 dark:text-zinc-950'
                    : 'bg-zinc-200 text-zinc-400 dark:bg-zinc-700 dark:text-zinc-500 cursor-not-allowed'
                )}
              >
                发送
              </button>
            )}
          </div>
        </div>
      </>)}

      {/* 系统提示编辑弹窗 */}
      {showPromptEditor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={() => setShowPromptEditor(false)}>
          <div className="w-[400px] rounded-xl border bg-white border-zinc-200 dark:bg-zinc-900 dark:border-zinc-700 p-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-2">卡片级系统提示</h3>
            <textarea value={promptDraft} onChange={(e) => setPromptDraft(e.target.value)} rows={4} placeholder="输入 system prompt，留空则跟随全局..." className="w-full resize-none rounded border border-zinc-200 dark:border-zinc-600 px-3 py-2 text-sm bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 outline-none" />
            <div className="flex gap-2 mt-3">
              <button onClick={savePromptEditor} className="flex-1 rounded-lg bg-zinc-900 text-white px-3 py-1.5 text-xs font-medium hover:bg-zinc-700">保存</button>
              <button onClick={() => { updateNode(id, { systemPrompt: undefined }); setShowPromptEditor(false); }} className="rounded-lg bg-zinc-100 text-zinc-600 px-3 py-1.5 text-xs hover:bg-zinc-200">清除</button>
            </div>
          </div>
        </div>
      )}

      <Handle type="source" position={Position.Bottom} className="!h-3 !w-3 !rounded-full !border-2 !border-zinc-400 !bg-white dark:!bg-zinc-700" />
      </div>
    </>
  );
}, shallowSkipPosition);
