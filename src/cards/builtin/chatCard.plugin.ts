/**
 * src/cards/builtin/chatCard.plugin.ts
 * ChatCardPlugin：对话卡片。
 * v0.5: 从 contextBuilder.ts 提取 output/input/matchSearch/exportContent。
 */
import type { CardPlugin, CardInputPackage, CardOutput } from '../types';
import type { GraphNode, ChatMessage, ContextStrategy } from '@/types';
import { ChatNode } from '@/components/ChatNode/ChatNode';

function output(node: GraphNode): CardOutput {
  const messages = node.messages ?? [];
  return {
    sourceType: 'chat',
    sourceTitle: node.title ?? '',
    sourceId: node.id,
    payload: {
      messages,
      model: node.model ?? '',
    },
  };
}

function input(packages: CardInputPackage[], strategy: ContextStrategy): ChatMessage[] {
  const messages: ChatMessage[] = [];

  for (const pkg of packages) {
    const { output: out, edgeLabel } = pkg;

    if (out.sourceType === 'chat') {
      const msgs = (out.payload.messages as ChatMessage[]) ?? [];
      if (strategy === 'last') {
        const lastAssistant = [...msgs].reverse().find(
          (m) => m.role === 'assistant' && m.status === 'done'
        );
        if (lastAssistant) {
          const srcTitle = out.sourceTitle || out.sourceId;
          messages.push({
            id: `ctx_${lastAssistant.id}`,
            role: 'system',
            content: `[上游节点「${srcTitle}」的回复]:\n${lastAssistant.content}`,
            createdAt: lastAssistant.createdAt,
            status: 'done',
          });
        }
      } else {
        const doneMsgs = msgs.filter((m) => m.status === 'done');
        for (const msg of doneMsgs) {
          messages.push({ ...msg, id: `ctx_${msg.id}` });
        }
      }
    } else if (out.sourceType === 'note') {
      const content = out.payload.content as string;
      if (content) {
        messages.push({
          id: `ctx_note_${out.sourceId}`,
          role: 'system',
          content: `[笔记「${out.sourceTitle}」的内容]:\n${content}`,
          createdAt: Date.now(),
          status: 'done',
        });
      }
    }
    // pdf 节点无 input 语义，跳过
  }

  return messages;
}

function matchSearch(node: GraphNode, query: string): boolean {
  const q = query.toLowerCase();
  if (node.title?.toLowerCase().includes(q)) return true;
  if (!node.messages) return false;
  return node.messages.some(
    (m) => typeof m.content === 'string' && m.content.toLowerCase().includes(q)
  );
}

function exportContent(node: GraphNode): string {
  let md = '';
  if (!node.messages) return md;
  for (const m of node.messages) {
    if (m.status !== 'done') continue;
    if (m.role === 'user') md += `**问**: ${m.content}\n\n`;
    else if (m.role === 'assistant') md += `${m.content}\n\n`;
  }
  return md;
}

export const chatCardPlugin: CardPlugin = {
  type: 'chat',
  label: '对话卡片',
  defaults: {
    type: 'chat' as const,
    model: '',
    messages: [],
    collapsed: false,
  },
  allowIntraLayer: true,
  component: ChatNode,
  output,
  input,
  matchSearch,
  exportContent,
};
