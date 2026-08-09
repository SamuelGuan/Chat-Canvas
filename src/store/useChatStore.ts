/**
 * src/store/useChatStore.ts
 * 聊天消息流式状态机：streamingNodeId + 消息操作方法。
 * 流式 token 经内存缓冲节流落库（STREAM_FLUSH_MS），且流式全程不进 undo 栈。
 *
 * v0.2.1 简化：messagesByNode 移除，消息存储统一由
 *   useCanvasStore.session.nodes[id].messages 承载。
 * 所有消息操作内部委托给 CanvasStore.updateNode()。
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { nanoid } from 'nanoid';
import { ChatMessage } from '@/types';
import { useCanvasStore } from '@/store/useCanvasStore';

interface ChatState {
  streamingNodeId: string | null;

  addUserMessage: (nodeId: string, content: string) => string;
  startStreaming: (nodeId: string) => string;
  onStreamStart: (nodeId: string, msgId: string) => void;
  appendStreamToken: (nodeId: string, msgId: string, token: string) => void;
  finishStreaming: (nodeId: string, msgId: string) => void;
  setError: (nodeId: string, msgId: string, error: string) => void;
  editUserMessage: (nodeId: string, msgId: string, newContent: string) => void;
  deleteMessage: (nodeId: string, msgId: string) => void;
  clearNodeMessages: (nodeId: string) => void;
  initNodeMessages: (nodeId: string) => void;
  getNodeMessages: (nodeId: string) => ChatMessage[];
  setNodeMessages: (nodeId: string, messages: ChatMessage[]) => void;
}

/** 从 CanvasStore 读节点消息（内部辅助） */
function readMsgs(nodeId: string): ChatMessage[] {
  return (
    useCanvasStore.getState().session.nodes[nodeId]?.messages ?? []
  );
}

/** 写节点消息到 CanvasStore（opts.history=false 时不进 undo 栈，用于流式高频写） */
function writeMsgs(nodeId: string, msgs: ChatMessage[], opts?: { history?: boolean }) {
  useCanvasStore.getState().updateNode(nodeId, { messages: msgs }, opts);
}

/* ===== 流式 token 缓冲：token 先进内存，节流批量落库，避免每 token 全量提交 ===== */

/** 流式落库节流间隔（ms） */
const STREAM_FLUSH_MS = 50;
/** msgId -> 未落库的 token 串 */
const tokenBuffers = new Map<string, string>();
/** msgId -> 待执行的 flush 定时器 */
const flushTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** 把缓冲 token 一次性追加到消息内容并落库（不进 undo 栈） */
function flushStreamTokens(nodeId: string, msgId: string): void {
  const pending = tokenBuffers.get(msgId);
  if (!pending) return;
  tokenBuffers.delete(msgId);
  const msgs = readMsgs(nodeId);
  writeMsgs(
    nodeId,
    msgs.map((m) => (m.id === msgId ? { ...m, content: (m.content as string) + pending } : m)),
    { history: false }
  );
}

/** 调度一次节流 flush（同一条消息在间隔内只触发一次） */
function scheduleFlush(nodeId: string, msgId: string): void {
  if (flushTimers.has(msgId)) return;
  flushTimers.set(
    msgId,
    setTimeout(() => {
      flushTimers.delete(msgId);
      flushStreamTokens(nodeId, msgId);
    }, STREAM_FLUSH_MS)
  );
}

/** 取消待执行的 flush 并丢弃定时器（结束/出错时先调用，再手动 flush 或清空缓冲） */
function cancelFlush(msgId: string): void {
  const timer = flushTimers.get(msgId);
  if (timer) {
    clearTimeout(timer);
    flushTimers.delete(msgId);
  }
}

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      streamingNodeId: null,

      addUserMessage: (nodeId, content) => {
        const id = nanoid(8);
        const existing = readMsgs(nodeId);
        writeMsgs(nodeId, [
          ...existing,
          {
            id,
            role: 'user',
            content,
            createdAt: Date.now(),
            status: 'done' as const,
          },
        ]);
        return id;
      },

      // 流式生命周期（start/token/finish/error）均不进 undo 栈：
      // 一次对话只由 addUserMessage 产生一个 undo 步，Ctrl+Z 整体撤回本轮问答
      startStreaming: (nodeId) => {
        const id = nanoid(8);
        const existing = readMsgs(nodeId);
        writeMsgs(nodeId, [
          ...existing,
          {
            id,
            role: 'assistant',
            content: '',
            createdAt: Date.now(),
            status: 'pending' as const,
          },
        ], { history: false });
        set({ streamingNodeId: nodeId });
        return id;
      },

      onStreamStart: (nodeId, msgId) => {
        const msgs = readMsgs(nodeId);
        const updated = msgs.map((m) =>
          m.id === msgId ? { ...m, status: 'streaming' as const } : m
        );
        writeMsgs(nodeId, updated, { history: false });
      },

      // token 只进缓冲，由节流 flush 批量落库（消除每 token 的 store 提交与 O(n^2) 字符串拼接）
      appendStreamToken: (nodeId, msgId, token) => {
        tokenBuffers.set(msgId, (tokenBuffers.get(msgId) ?? '') + token);
        scheduleFlush(nodeId, msgId);
      },

      finishStreaming: (nodeId, msgId) => {
        cancelFlush(msgId);
        flushStreamTokens(nodeId, msgId);
        const msgs = readMsgs(nodeId);
        const updated = msgs.map((m) =>
          m.id === msgId ? { ...m, status: 'done' as const } : m
        );
        writeMsgs(nodeId, updated, { history: false });
        set({ streamingNodeId: null });
      },

      setError: (nodeId, msgId, error) => {
        cancelFlush(msgId);
        tokenBuffers.delete(msgId);
        const msgs = readMsgs(nodeId);
        const updated = msgs.map((m) =>
          m.id === msgId
            ? {
                ...m,
                status: 'error' as const,
                content: `[错误] ${error}`,
              }
            : m
        );
        writeMsgs(nodeId, updated, { history: false });
        set({ streamingNodeId: null });
      },

      editUserMessage: (nodeId, msgId, newContent) => {
        const msgs = readMsgs(nodeId);
        const idx = msgs.findIndex((m) => m.id === msgId);
        if (idx === -1) return;
        // 截断该消息之后的全部消息
        const before = msgs.slice(0, idx);
        const edited: ChatMessage = {
          ...msgs[idx],
          content: newContent,
          createdAt: Date.now(),
        };
        writeMsgs(nodeId, [...before, edited]);
      },

      deleteMessage: (nodeId, msgId) => {
        const msgs = readMsgs(nodeId);
        writeMsgs(
          nodeId,
          msgs.filter((m) => m.id !== msgId)
        );
      },

      clearNodeMessages: (nodeId) => {
        useCanvasStore.getState().updateNode(nodeId, { messages: [] });
      },

      initNodeMessages: (nodeId) => {
        if (!readMsgs(nodeId).length) {
          useCanvasStore.getState().updateNode(nodeId, { messages: [] });
        }
      },

      getNodeMessages: (nodeId) => readMsgs(nodeId),

      setNodeMessages: (nodeId, messages) => {
        useCanvasStore.getState().updateNode(nodeId, { messages });
      },
    }),
    {
      name: 'chat-canvas-chat',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        streamingNodeId: state.streamingNodeId,
      }),
    }
  )
);
