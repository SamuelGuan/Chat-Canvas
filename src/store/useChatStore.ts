/**
 * src/store/useChatStore.ts
 * 聊天消息流式状态机：streamingNodeId / streamingText + 消息操作方法。
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
  streamingText: string;

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

/** 写节点消息到 CanvasStore */
function writeMsgs(nodeId: string, msgs: ChatMessage[]) {
  useCanvasStore.getState().updateNode(nodeId, { messages: msgs });
}

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      streamingNodeId: null,
      streamingText: '',

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
        ]);
        set({ streamingNodeId: nodeId, streamingText: '' });
        return id;
      },

      onStreamStart: (nodeId, msgId) => {
        const msgs = readMsgs(nodeId);
        const updated = msgs.map((m) =>
          m.id === msgId ? { ...m, status: 'streaming' as const } : m
        );
        writeMsgs(nodeId, updated);
      },

      appendStreamToken: (nodeId, msgId, token) => {
        const msgs = readMsgs(nodeId);
        const updated = msgs.map((m) =>
          m.id === msgId
            ? { ...m, content: (m.content as string) + token }
            : m
        );
        writeMsgs(nodeId, updated);
        set((s) => ({ streamingText: s.streamingText + token }));
      },

      finishStreaming: (nodeId, msgId) => {
        const msgs = readMsgs(nodeId);
        const updated = msgs.map((m) =>
          m.id === msgId ? { ...m, status: 'done' as const } : m
        );
        writeMsgs(nodeId, updated);
        set({ streamingNodeId: null, streamingText: '' });
      },

      setError: (nodeId, msgId, error) => {
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
        writeMsgs(nodeId, updated);
        set({ streamingNodeId: null, streamingText: '' });
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
