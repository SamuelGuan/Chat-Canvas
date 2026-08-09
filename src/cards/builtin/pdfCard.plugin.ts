/**
 * src/cards/builtin/pdfCard.plugin.ts
 * PdfCardPlugin：PDF 阅读卡片。
 * v0.5: 二进制存储到 assets/，iframe 渲染。
 */
import type { CardPlugin, CardOutput } from '../types';
import type { GraphNode } from '@/types';
import { PdfNode } from '@/components/PdfNode/PdfNode';

function output(node: GraphNode): CardOutput {
  return {
    sourceType: 'pdf',
    sourceTitle: node.title ?? '',
    sourceId: node.id,
    payload: {
      fileName: node.title ?? '',
      pdfPath: node.pdfPath ?? '',
      currentPage: node.pdfCurrentPage ?? 1,
      totalPages: node.pdfTotalPages ?? 0,
    },
  };
}

function matchSearch(node: GraphNode, query: string): boolean {
  const q = query.toLowerCase();
  if (node.title?.toLowerCase().includes(q)) return true;
  return false;
}

function exportContent(_node: GraphNode): string {
  // PDF 不导出内容
  return '';
}

export const pdfCardPlugin: CardPlugin = {
  type: 'pdf',
  label: 'PDF 卡片',
  defaults: {
    type: 'pdf' as const,
    collapsed: false,
    width: 1400,
    height: 1100,
  },
  allowIntraLayer: true,
  component: PdfNode,
  output,
  // pdf 无 input（非 LLM 消费者）
  matchSearch,
  exportContent,
};
