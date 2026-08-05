/**
 * src/store/factories.ts
 * Project / Session 实体构造，供 useCanvasStore 与 bootstrap 共用。
 */
import { nanoid } from 'nanoid';
import { CanvasViewport, ProjectData, SessionData } from '@/types';

const defaultViewport: CanvasViewport = { x: 0, y: 0, zoom: 1 };

/** 构造项目（id 即文件夹名；pinned 为固定项目不可删除） */
export function makeProject(name?: string, id?: string, pinned = false): ProjectData {
  const now = Date.now();
  return { id: id ?? nanoid(8), name: name ?? '默认项目', pinned, createdAt: now, updatedAt: now };
}

/** 构造空 Session（无卡片，对齐旧版首启行为；新建 Session 附卡片是 createSession 的职责） */
export function makeSession(projectId: string, id?: string, name?: string): SessionData {
  const now = Date.now();
  return {
    id: id ?? nanoid(8),
    name: name ?? '未命名 Session',
    projectId,
    createdAt: now,
    updatedAt: now,
    nodes: {},
    edges: {},
    viewport: defaultViewport,
  };
}
