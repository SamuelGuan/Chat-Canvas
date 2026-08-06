/**
 * src/cards/types.ts
 * 卡片插件系统类型定义：CardPlugin 自描述接口 + CardOutput/CardInputPackage。
 * v0.5: 卡片系统组件化、插件化，新增卡片类型只需注册一个 CardPlugin。
 */
import type { ComponentType } from 'react';
import type { NodeProps } from '@xyflow/react';
import type { GraphNode, ChatMessage, ContextStrategy } from '@/types';

/** 卡片输出：结构化字典，key 由卡片自定义 */
export interface CardOutput {
  sourceType: string;
  sourceTitle: string;
  sourceId: string;
  payload: Record<string, unknown>;
}

/** 卡片输入：从上游收集来的输出包 */
export interface CardInputPackage {
  output: CardOutput;
  source: GraphNode;
  edgeLabel?: string;
  folded?: boolean;
}

/** 折叠链包：连续同层节点合并为等效节点 */
export interface FoldedChainPackage extends CardInputPackage {
  folded: true;
  entry: CardOutput;
  exit: CardOutput;
  chain: CardOutput[];
}

export interface CardPlugin {
  /** 唯一标识 (对应 GraphNode.type，也定义层名) */
  type: string;
  /** 显示名称 (右键菜单用) */
  label: string;
  /** 新节点默认字段 (不含 id/position/createdAt) */
  defaults: Partial<GraphNode>;
  /** 同层内是否允许互连 */
  allowIntraLayer: boolean;
  /** React Flow 节点组件 */
  component: ComponentType<NodeProps>;

  /**
   * 输出系统: 将卡片自身状态导出为字典。
   * 调用时机: 上下文构建时、下游卡片索要数据时。
   */
  output: (node: GraphNode) => CardOutput;

  /**
   * 输入系统: 处理来自上游卡片的数据包，转化为 LLM context messages。
   * 可选: 非 LLM 消费者不实现 (input 为空 → 不可作为上下文目标)。
   */
  input?: (packages: CardInputPackage[], strategy: ContextStrategy) => ChatMessage[];

  /** 搜索匹配 */
  matchSearch: (node: GraphNode, query: string) => boolean;
  /** 导出 Markdown */
  exportContent: (node: GraphNode) => string;
}
