/**
 * src/lib/contextBuilder.ts
 * 根据连线关系回溯上游消息，拼接成 LLM 的 messages 数组。
 *
 * v0.3: D-04 三种回溯策略 + D-06 system prompt 注入。
 */
import { ChatMessage, SessionData, ContextStrategy } from '@/types';
import { useSettingsStore } from '@/store/useSettingsStore';

/**
 * 获取目标节点发送请求时的上游上下文消息列表
 * @param targetNodeId 目标节点 ID
 * @param session      当前 SessionData
 */
export function buildContext(targetNodeId: string, session: SessionData): ChatMessage[] {
  const settings = useSettingsStore.getState();
  const strategy = settings.contextStrategy;
  // full（完整多轮）一直追溯到根节点；last/depth 受回溯深度限制
  const maxDepth = settings.contextDepth === 'root' || strategy === 'full' ? 100 : settings.contextDepth;

  const visited = new Set<string>();
  const messages: ChatMessage[] = [];

  const incomingEdges = Object.values(session.edges).filter(
    (e) => e.target === targetNodeId && e.edgeType === 'inherit'
  );

  for (const edge of incomingEdges) {
    if (visited.has(edge.source)) continue;
    visited.add(edge.source);
    collectSourceMessages(edge.source, session, messages, strategy);
    recurseCollect(edge.source, session, visited, 1, maxDepth, messages, strategy);
  }

  messages.sort((a, b) => a.createdAt - b.createdAt);

  // ★ D-06: 注入 system prompt（全局 + 卡片级）
  const globalPrompt = settings.globalSystemPrompt.trim();
  const nodePrompt = session.nodes[targetNodeId]?.systemPrompt?.trim();
  if (globalPrompt) {
    messages.unshift({
      id: 'sys_global', role: 'system', content: globalPrompt,
      createdAt: 0, status: 'done',
    });
  }
  if (nodePrompt) {
    messages.unshift({
      id: 'sys_node', role: 'system', content: nodePrompt,
      createdAt: 1, status: 'done',
    });
  }

  return messages;
}

function collectSourceMessages(
  sourceId: string,
  session: SessionData,
  out: ChatMessage[],
  strategy: ContextStrategy
): void {
  const sourceNode = session.nodes[sourceId];
  if (!sourceNode) return;

  if (strategy === 'last') {
    // 仅最后一条 assistant
    const lastAssistant = [...sourceNode.messages].reverse().find((m) => m.role === 'assistant' && m.status === 'done');
    if (lastAssistant) {
      out.push({
        id: `ctx_${lastAssistant.id}`, role: 'system',
        content: `[上游节点「${sourceNode.title}」的回复]:\n${lastAssistant.content}`,
        createdAt: lastAssistant.createdAt, status: 'done',
      });
    }
  } else {
    // 完整多轮 或 按深度回溯
    const allMsgs = sourceNode.messages.filter((m) => m.status === 'done');
    for (const msg of allMsgs) {
      out.push({
        ...msg,
        id: `ctx_${msg.id}`,
      });
    }
  }
}

function recurseCollect(
  nodeId: string,
  session: SessionData,
  visited: Set<string>,
  currentDepth: number,
  maxDepth: number,
  out: ChatMessage[],
  strategy: ContextStrategy
): void {
  // 当前节点深度已达上限则不再向上收集（深度语义：1 = 仅直接上游，N = 共 N 层祖先）
  if (currentDepth >= maxDepth) return;
  const incoming = Object.values(session.edges).filter(
    (e) => e.target === nodeId && e.edgeType === 'inherit'
  );
  for (const edge of incoming) {
    if (visited.has(edge.source)) continue;
    visited.add(edge.source);
    collectSourceMessages(edge.source, session, out, strategy);
    recurseCollect(edge.source, session, visited, currentDepth + 1, maxDepth, out, strategy);
  }
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
