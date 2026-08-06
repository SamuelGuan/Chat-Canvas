/**
 * src/cards/communicateAdapter.ts
 * 自治有向图路由器：BFS 收集上游 → 折叠同层链 → 打包 → 交给目标卡片的 input()。
 * v0.5: 替代 contextBuilder.ts 中的 collectSourceMessages 硬编码逻辑。
 */
import type { SessionData, GraphNode, ChatMessage, ContextStrategy } from '@/types';
import type { CardPlugin, CardInputPackage, FoldedChainPackage, CardOutput } from './types';
import type { CardRegistry } from './registry';
import { useSettingsStore } from '@/store/useSettingsStore';

export function createCardComm(registry: CardRegistry) {

  function buildContext(targetNodeId: string, session: SessionData): ChatMessage[] {
    const targetNode = session.nodes[targetNodeId];
    if (!targetNode) return [];

    const targetPlugin = registry.get(targetNode.type);
    if (!targetPlugin?.input) return [];

    const settings = useSettingsStore.getState();
    const strategy = settings.contextStrategy;
    const maxDepth = settings.contextDepth === 'root' || strategy === 'full' ? 100 : settings.contextDepth;

    const packages = collectFoldedInputs(targetNodeId, session, registry, maxDepth);

    const messages = targetPlugin.input(packages, strategy);
    messages.sort((a, b) => a.createdAt - b.createdAt);

    // 注入 system prompt（全局 + 卡片级）
    const globalPrompt = settings.globalSystemPrompt.trim();
    const nodePrompt = targetNode.systemPrompt?.trim();
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

  function matchSearch(node: GraphNode, query: string): boolean {
    const plugin = registry.get(node.type);
    if (!plugin) return false;
    return plugin.matchSearch(node, query);
  }

  function exportContent(node: GraphNode): string {
    const plugin = registry.get(node.type);
    if (!plugin) return '';
    return plugin.exportContent(node);
  }

  return { buildContext, matchSearch, exportContent };
}

/** BFS 收集上游输入并折叠同层链 */
function collectFoldedInputs(
  targetId: string,
  session: SessionData,
  registry: CardRegistry,
  maxDepth: number,
): CardInputPackage[] {
  const visited = new Set<string>();
  const result: CardInputPackage[] = [];

  function traverse(nodeId: string, depth: number): void {
    if (depth >= maxDepth) return;
    for (const e of Object.values(session.edges)) {
      if (e.target !== nodeId || e.edgeType !== 'inherit') continue;
      if (visited.has(e.source)) continue;
      visited.add(e.source);

      const srcNode = session.nodes[e.source];
      if (!srcNode) continue;
      const srcPlugin = registry.get(srcNode.type);
      if (!srcPlugin) continue;

      if (srcPlugin.allowIntraLayer) {
        const chain = collectIntraLayerChain(e.source, srcNode.type, session, visited);
        result.push(foldChain(chain, srcPlugin));
      } else {
        result.push({
          output: srcPlugin.output(srcNode),
          source: srcNode,
          edgeLabel: e.label,
          folded: false,
        });
      }
      traverse(e.source, depth + 1);
    }
  }
  traverse(targetId, 0);
  return result;
}

/** 沿同层链向上游收集直到跨层或末端 */
function collectIntraLayerChain(
  startId: string,
  layerType: string,
  session: SessionData,
  visited: Set<string>,
): GraphNode[] {
  const chain: GraphNode[] = [session.nodes[startId]];
  let cursor = startId;
  while (true) {
    let next: string | null = null;
    for (const e of Object.values(session.edges)) {
      if (e.target === cursor && e.edgeType === 'inherit' && !visited.has(e.source)) {
        const node = session.nodes[e.source];
        if (node && node.type === layerType) {
          visited.add(e.source);
          next = e.source;
          break;
        }
      }
    }
    if (!next) break;
    chain.unshift(session.nodes[next]);
    cursor = next;
  }
  return chain;
}

/** 折叠同层链为等效节点包 */
function foldChain(chain: GraphNode[], plugin: CardPlugin): FoldedChainPackage {
  const outputs = chain.map((n) => plugin.output(n));
  return {
    folded: true,
    output: outputs[outputs.length - 1],
    entry: outputs[0],
    exit: outputs[outputs.length - 1],
    chain: outputs,
    source: chain[chain.length - 1],
    edgeLabel: undefined,
  };
}

/* ===== 延迟初始化单例 (由 register.ts 调用 initCardComm 注入) ===== */

let _cardComm: ReturnType<typeof createCardComm> | null = null;

export function initCardComm(registry: CardRegistry): void {
  _cardComm = createCardComm(registry);
}

function mustCardComm(): ReturnType<typeof createCardComm> {
  if (!_cardComm) throw new Error('cardComm 未初始化（请先 import 卡片注册入口）');
  return _cardComm;
}

/** 构建目标节点的 LLM 上下文消息列表 */
export function buildCardContext(targetNodeId: string, session: SessionData): ChatMessage[] {
  return mustCardComm().buildContext(targetNodeId, session);
}

/** 搜索节点是否匹配查询 */
export function matchCardSearch(node: GraphNode, query: string): boolean {
  return mustCardComm().matchSearch(node, query);
}

/** 导出节点内容为 Markdown */
export function exportCardContent(node: GraphNode): string {
  return mustCardComm().exportContent(node);
}
