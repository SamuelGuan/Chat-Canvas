/**
 * src/types/index.ts
 * 全局类型定义：SessionData / GraphNode / GraphEdge / 多模态消息 / 服务商配置。
 */
export type EdgeType = 'inherit' | 'reference';

/* ===== 多模态消息 ===== */

export interface ContentPartText {
  type: 'text';
  text: string;
}
export interface ContentPartImage {
  type: 'image_url';
  image_url: { url: string };
}
export type ContentPart = ContentPartText | ContentPartImage;
export type MessageContent = string | ContentPart[];

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: MessageContent;
  createdAt: number;
  status: 'pending' | 'streaming' | 'done' | 'error';
}

/* ===== 图节点 ===== */

export interface GraphNode {
  id: string;
  type: 'chat';
  position: { x: number; y: number };
  title: string;
  model: string;
  collapsed: boolean;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  systemPrompt?: string;      // ★ D-06: 卡片级 system prompt (覆盖全局)
  isAssemble?: boolean;       // ★ 拼装模式: 已选中加入导出列表
  forkLabel?: string;         // ★ 消息分叉/术语追问时的来源标签
  width?: number;             // ★ 卡片宽度 (px)
  height?: number;            // ★ 卡片高度 (px)
}

/* ===== 图边 ===== */

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  edgeType: EdgeType;
  label?: string;             // ★ 分叉/追问时的描述标签
}

/* ===== Session 快照 ===== */

export interface SessionData {
  id: string;
  name: string;
  projectId: string;          // ★ 所属项目
  createdAt: number;
  updatedAt: number;
  nodes: Record<string, GraphNode>;
  edges: Record<string, GraphEdge>;
  viewport: CanvasViewport;
}

/* ===== Project：一组相关 Session 的容器 ===== */

export interface ProjectData {
  id: string;
  name: string;
  pinned?: boolean;           // ★ 固定项目（默认项目/导入项目）不可删除
  createdAt: number;
  updatedAt: number;
}

/** 固定项目 ID：默认项目（不可删除） */
export const DEFAULT_PROJECT_ID = 'proj_default';
/** 固定项目 ID：导入的 Sessions（不可删除），导入的 Session 统一归入此项目 */
export const IMPORT_PROJECT_ID = 'proj_imported';

/* ===== v0.4 三级文件格式（MBR / PBR / 分区数据区） ===== */

/** 三级文件当前格式版本（index/project/session 各自携带，支持按文件粒度懒升级） */
export const STORE_FILE_VERSION = 1;

/** 项目注册表条目（index.json 内 projects 数组元素；与 ProjectData 同形） */
export type ProjectMeta = ProjectData;

/** index.json（MBR）：根索引 —— 项目注册表 + activeProjectId */
export interface RootIndex {
  version: number;
  activeProjectId: string;
  projects: ProjectMeta[];
}

/** project.json 内 Session 列表元信息（懒加载支撑：侧边栏列表无需读 session 文件） */
export interface SessionMeta {
  name: string;
  createdAt: number;
  updatedAt: number;
}

/** projects/<pid>/project.json（PBR）：项目内 Session 注册表 + activeSessionId */
export interface ProjectFile {
  version: number;
  id: string;
  name: string;
  activeSessionId: string | null;
  sessionIds: string[];
  /** Session 元信息缓存（键 = sessionId）；可选，缺失/过期由一致性校验重建 */
  sessionMeta?: Record<string, SessionMeta>;
}

/** projects/<pid>/sessions/<sid>.json（分区数据区）：SessionData + 文件版本 */
export type SessionFile = SessionData & { version: number };

/* ===== @deprecated ===== */

/** @deprecated 使用 GraphNode 替代 */
export interface NodeData extends Omit<GraphNode, 'messages'> { }

/** @deprecated 使用 GraphEdge 替代 */
export interface EdgeData {
  id: string;
  source: string;
  target: string;
  edgeType: EdgeType;
}

/** @deprecated 使用 SessionData 替代 */
export interface NodeSnapshot extends GraphNode { }

/** @deprecated 使用 SessionData 替代 */
export interface CanvasSnapshot {
  nodes: NodeSnapshot[];
  edges: EdgeData[];
  viewport: CanvasViewport;
}

/* ===== 视口 ===== */

export interface CanvasViewport {
  x: number;
  y: number;
  zoom: number;
}

/* ===== 上下文回溯策略 (D-04) ===== */

export type ContextStrategy = 'last' | 'full';

/* ===== 服务商与应用设置 ===== */

export interface ProviderModel {
  id: string;
  label: string;
}

export interface ProviderConfig {
  id: string;
  name: string;
  apiKey: string;
  baseURL: string;
  models: ProviderModel[];
  isEnabled: boolean;
  description?: string;
  getKeyUrl?: string;
}

export interface AppSettings {
  providers: ProviderConfig[];
  activeProviderId: string;
  defaultModel: string;
  theme: 'light' | 'dark' | 'system';
  contextDepth: number | 'root';        // D-04: 'root' | 1 | 3 | 5
  contextStrategy: ContextStrategy;     // ★ D-04: 回溯策略
  globalSystemPrompt: string;           // ★ D-06: 全局 system prompt
  sidebarScale: number;                 // 侧边栏缩放倍率（仅影响侧边栏，不影响画布）
}
