/**
 * src/cards/edgeValidator.ts
 * 连线校验器：基于 Multi-Layer Graph 的层内/层间规则 + BFS 环检测。
 * v0.5: 替代 Canvas.tsx 中的裸 bfsCanReach 调用。
 */
import type { SessionData, GraphNode } from '@/types';
import { cardRegistry } from './registry';
import { bfsCanReach } from '@/lib/contextBuilder';

export interface EdgeValidationResult {
  ok: boolean;
  reason?: string;
}

/**
 * 检查连线是否合法
 *
 * :param sourceId: 源节点 id
 * :param targetId: 目标节点 id
 * :param session: 当前 Session 数据
 * :return: 校验结果
 */
export function canConnect(
  sourceId: string,
  targetId: string,
  session: SessionData,
): EdgeValidationResult {
  const sourceNode = session.nodes[sourceId];
  const targetNode = session.nodes[targetId];
  if (!sourceNode || !targetNode) {
    return { ok: false, reason: '节点不存在' };
  }

  if (sourceId === targetId) {
    return { ok: false, reason: '不能连接自身' };
  }

  const sourceType = sourceNode.type;
  const targetType = targetNode.type;

  // 不同层 → 永远允许
  if (sourceType !== targetType) {
    // 仍需环检测
    if (bfsCanReach(session.edges, sourceId, targetId)) {
      return { ok: false, reason: '不允许形成消息流环' };
    }
    return { ok: true };
  }

  // 同层 → 检查层内规则
  const plugin = cardRegistry.get(sourceType);
  if (!plugin) {
    return { ok: false, reason: `未知卡片类型: ${sourceType}` };
  }

  if (!plugin.allowIntraLayer) {
    return { ok: false, reason: `${plugin.label}不支持同层连线` };
  }

  // 层内允许 → 标准环检测
  if (bfsCanReach(session.edges, sourceId, targetId)) {
    return { ok: false, reason: '不允许形成消息流环' };
  }

  return { ok: true };
}
