/**
 * src/cards/builtin/noteCard.plugin.ts
 * NoteCardPlugin：笔记卡片。
 * v0.5: Markdown 编辑+预览，非 LLM 消费者（无 input）。
 */
import type { CardPlugin, CardOutput } from '../types';
import type { GraphNode } from '@/types';
import { NoteNode } from '@/components/NoteNode/NoteNode';

function output(node: GraphNode): CardOutput {
  const content = node.markdownContent ?? '';
  return {
    sourceType: 'note',
    sourceTitle: node.title ?? '',
    sourceId: node.id,
    payload: {
      content,
      lineCount: content ? content.split('\n').length : 0,
    },
  };
}

function matchSearch(node: GraphNode, query: string): boolean {
  const q = query.toLowerCase();
  if (node.title?.toLowerCase().includes(q)) return true;
  const md = node.markdownContent ?? '';
  return md.toLowerCase().includes(q);
}

function exportContent(node: GraphNode): string {
  const md = node.markdownContent ?? '';
  if (!md.trim()) return '';
  return `${md}\n\n`;
}

export const noteCardPlugin: CardPlugin = {
  type: 'note',
  label: '笔记卡片',
  defaults: {
    type: 'note' as const,
    markdownContent: '',
    collapsed: false,
    width: 1200,
    height: 1000,
  },
  allowIntraLayer: false,
  component: NoteNode,
  output,
  // note 无 input（非 LLM 消费者）
  matchSearch,
  exportContent,
};
