/**
 * src/cards/registry.ts
 * CardRegistry 注册中心：统一管理所有 CardPlugin。
 * v0.5: 新增卡片类型只需 register 一行，其他层自动适配。
 */
import type { ComponentType } from 'react';
import type { NodeProps } from '@xyflow/react';
import type { CardPlugin } from './types';

export class CardRegistry {
  private plugins = new Map<string, CardPlugin>();

  register(...plugins: CardPlugin[]): void {
    for (const p of plugins) {
      if (this.plugins.has(p.type)) {
        console.warn(`[CardRegistry] 类型 "${p.type}" 已注册，将被覆盖`);
      }
      this.plugins.set(p.type, p);
    }
  }

  get(type: string): CardPlugin | undefined {
    return this.plugins.get(type);
  }

  /** Canvas.tsx 的 ReactFlow nodeTypes 直接使用 */
  nodeTypes(): Record<string, ComponentType<NodeProps>> {
    const result: Record<string, ComponentType<NodeProps>> = {};
    for (const [type, plugin] of this.plugins) {
      result[type] = plugin.component;
    }
    return result;
  }

  /** 右键菜单列出可选卡片类型 */
  creatableTypes(): { type: string; label: string }[] {
    return Array.from(this.plugins.values()).map((p) => ({
      type: p.type,
      label: p.label,
    }));
  }

  /** 所有已注册的层名 */
  layerTypes(): string[] {
    return Array.from(this.plugins.keys());
  }
}

export const cardRegistry = new CardRegistry();
