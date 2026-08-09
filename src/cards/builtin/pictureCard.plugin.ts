import type { CardPlugin, CardOutput } from '../types';
import type { GraphNode } from '@/types';
import { PictureNode } from '@/components/PictureNode/PictureNode';

function output(node: GraphNode): CardOutput {
  return {
    sourceType: 'picture',
    sourceTitle: node.title ?? '',
    sourceId: node.id,
    payload: {
      picturePath: node.picturePath ?? '',
      fileName: node.title ?? '',
    },
  };
}

function matchSearch(node: GraphNode, query: string): boolean {
  const q = query.toLowerCase();
  if (node.title?.toLowerCase().includes(q)) return true;
  return false;
}

function exportContent(node: GraphNode): string {
  if (!node.picturePath) return '';
  return `![${node.title ?? 'image'}](${node.picturePath})\n\n`;
}

export const pictureCardPlugin: CardPlugin = {
  type: 'picture',
  label: '图片卡片',
  defaults: {
    type: 'picture' as const,
    collapsed: false,
    width: 900,
    height: 700,
  },
  allowIntraLayer: true,
  component: PictureNode,
  output,
  matchSearch,
  exportContent,
};
