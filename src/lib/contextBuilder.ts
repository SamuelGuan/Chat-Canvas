/**
 * src/lib/contextBuilder.ts
 * 上下文构建器（向后兼容层）：委托给 CardPlugin 系统的 cardComm.buildContext()。
 * v0.5: 原 collectSourceMessages 逻辑迁移至 chatCardPlugin.input()，
 *       本文件保留 buildContext 作为外部接口（委托） + BFS 环检测工具函数。
 */
import { ChatMessage, SessionData } from '@/types';
import { buildCardContext } from '@/cards/communicateAdapter';

/**
 * 获取目标节点发送请求时的上游上下文消息列表
 * 委托给 CardPlugin 系统处理，实现类型感知
 *
 * :param targetNodeId: 目标节点 ID
 * :param session: 当前 SessionData
 */
export function buildContext(targetNodeId: string, session: SessionData): ChatMessage[] {
  return buildCardContext(targetNodeId, session);
}

/* ===== BFS 可达检测 ===== */

export function bfsCanReach(
  edges: Record<string, { source: string; target: string }>,
  source: string,
  target: string
): boolean {
  const adj = new Map<string, string[]>();
  for (const e of Object.values(edges)) {
    if (!adj.has(e.source)) adj.set(e.source, []);
    adj.get(e.source)!.push(e.target);
  }
  const visited = new Set<string>();
  const queue = [target];
  visited.add(target);
  while (queue.length > 0) {
    const current = queue.shift()!;
    const neighbors = adj.get(current) ?? [];
    for (const neighbor of neighbors) {
      if (neighbor === source) return true;
      if (!visited.has(neighbor)) { visited.add(neighbor); queue.push(neighbor); }
    }
  }
  return false;
}

/* ===== DFS 环检测 ===== */

export function detectCycle(
  edges: Record<string, { source: string; target: string }>
): boolean {
  const adj = new Map<string, string[]>();
  for (const e of Object.values(edges)) {
    if (!adj.has(e.source)) adj.set(e.source, []);
    adj.get(e.source)!.push(e.target);
  }
  const visited = new Set<string>();
  const recStack = new Set<string>();

  function dfs(node: string): boolean {
    visited.add(node);
    recStack.add(node);
    const neighbors = adj.get(node) ?? [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        if (dfs(neighbor)) return true;
      } else if (recStack.has(neighbor)) {
        return true;
      }
    }
    recStack.delete(node);
    return false;
  }

  for (const node of adj.keys()) {
    if (!visited.has(node)) {
      if (dfs(node)) return true;
    }
  }
  return false;
}
