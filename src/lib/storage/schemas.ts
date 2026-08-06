/**
 * src/lib/storage/schemas.ts
 * 三级文件 JSON Schema（唯一权威格式定义，v0.4 第 12 节开放扩展点）。
 * 启动时写入 chat-canvas-data/schema/：Python 照 schema 实现读写无需读 TS 源码，agent 的操作手册。
 * schema 内容变更需同步 STORE_FILE_VERSION 与 docs/store-protocol.md。
 */
import type { StorageAdapter } from './protocol';
import { STORE_FILE_VERSION } from '@/types';

const JSON_SCHEMA_DRAFT = 'http://json-schema.org/draft-07/schema#';

/** index.json（MBR）：根索引 */
export const INDEX_SCHEMA = {
  $schema: JSON_SCHEMA_DRAFT,
  $id: 'chat-canvas/schema/index.schema.json',
  title: 'ChatCanvas RootIndex (MBR)',
  type: 'object',
  required: ['version', 'activeProjectId', 'projects'],
  properties: {
    version: { type: 'integer', const: STORE_FILE_VERSION, description: '文件格式版本（按文件粒度懒升级）' },
    activeProjectId: { type: 'string', description: '激活项目 id（= projects/ 下文件夹名）' },
    projects: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'name', 'createdAt', 'updatedAt'],
        properties: {
          id: { type: 'string', description: '项目 id = 文件夹名' },
          name: { type: 'string' },
          pinned: { type: 'boolean', description: '固定项目（proj_default / proj_imported）不可删除' },
          createdAt: { type: 'integer', description: 'Unix 毫秒时间戳' },
          updatedAt: { type: 'integer' },
        },
        additionalProperties: true,
      },
    },
  },
  additionalProperties: false,
} as const;

/** projects/<pid>/project.json（PBR）：项目内 Session 注册表 */
export const PROJECT_SCHEMA = {
  $schema: JSON_SCHEMA_DRAFT,
  $id: 'chat-canvas/schema/project.schema.json',
  title: 'ChatCanvas ProjectFile (PBR)',
  type: 'object',
  required: ['version', 'id', 'name', 'activeSessionId', 'sessionIds'],
  properties: {
    version: { type: 'integer', const: STORE_FILE_VERSION },
    id: { type: 'string', description: '项目 id = 所在文件夹名' },
    name: { type: 'string' },
    activeSessionId: { type: ['string', 'null'], description: '项目内激活 Session id' },
    sessionIds: { type: 'array', items: { type: 'string' }, description: 'Session 注册表（id = sessions/ 下文件名去 .json）' },
    sessionMeta: {
      type: 'object',
      description: 'Session 元信息缓存（懒加载支撑；可选，缺失/过期由一致性校验重建）',
      additionalProperties: {
        type: 'object',
        required: ['name', 'createdAt', 'updatedAt'],
        properties: {
          name: { type: 'string' },
          createdAt: { type: 'integer' },
          updatedAt: { type: 'integer' },
        },
        additionalProperties: true,
      },
    },
  },
  additionalProperties: false,
} as const;

/** projects/<pid>/sessions/<sid>.json（分区数据区）：SessionData + 文件版本 */
export const SESSION_SCHEMA = {
  $schema: JSON_SCHEMA_DRAFT,
  $id: 'chat-canvas/schema/session.schema.json',
  title: 'ChatCanvas SessionFile',
  type: 'object',
  required: ['version', 'id', 'name', 'projectId', 'createdAt', 'updatedAt', 'nodes', 'edges', 'viewport'],
  properties: {
    version: { type: 'integer', const: STORE_FILE_VERSION },
    id: { type: 'string', description: 'Session id = 文件名去 .json' },
    name: { type: 'string' },
    projectId: { type: 'string', description: '所属项目 id（与所在文件夹一致，不一致时以文件夹为准并自愈）' },
    createdAt: { type: 'integer' },
    updatedAt: { type: 'integer' },
    nodes: {
      type: 'object',
      description: '图节点字典（键 = 节点 id）',
      additionalProperties: {
        type: 'object',
        required: ['id', 'type', 'position', 'title', 'collapsed', 'createdAt', 'updatedAt'],
        properties: {
          id: { type: 'string' },
          type: { type: 'string', enum: ['chat', 'note', 'pdf'] },
          position: {
            type: 'object',
            required: ['x', 'y'],
            properties: { x: { type: 'number' }, y: { type: 'number' } },
            additionalProperties: false,
          },
          title: { type: 'string' },
          model: { type: 'string' },
          collapsed: { type: 'boolean' },
          createdAt: { type: 'integer' },
          updatedAt: { type: 'integer' },
          messages: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'role', 'content', 'createdAt', 'status'],
              properties: {
                id: { type: 'string' },
                role: { type: 'string', enum: ['user', 'assistant', 'system'] },
                content: {
                  description: '纯文本字符串，或多模态 ContentPart 数组（text / image_url）',
                  oneOf: [
                    { type: 'string' },
                    {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: ['type'],
                        properties: {
                          type: { type: 'string', enum: ['text', 'image_url'] },
                          text: { type: 'string' },
                          image_url: {
                            type: 'object',
                            required: ['url'],
                            properties: { url: { type: 'string', description: 'data URL 或 assets/ 相对路径引用' } },
                            additionalProperties: false,
                          },
                        },
                        additionalProperties: false,
                      },
                    },
                  ],
                },
                createdAt: { type: 'integer' },
                status: { type: 'string', enum: ['pending', 'streaming', 'done', 'error'] },
              },
              additionalProperties: false,
            },
          },
          systemPrompt: { type: 'string', description: '卡片级 system prompt（覆盖全局）' },
          isAssemble: { type: 'boolean' },
          forkLabel: { type: 'string', description: '消息分叉/术语追问时的来源标签' },
          width: { type: 'number' },
          height: { type: 'number' },
        },
        additionalProperties: false,
      },
    },
    edges: {
      type: 'object',
      description: '图边字典（键 = 边 id）',
      additionalProperties: {
        type: 'object',
        required: ['id', 'source', 'target', 'edgeType'],
        properties: {
          id: { type: 'string' },
          source: { type: 'string' },
          target: { type: 'string' },
          edgeType: { type: 'string', enum: ['inherit', 'reference'] },
          label: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
    viewport: {
      type: 'object',
      required: ['x', 'y', 'zoom'],
      properties: { x: { type: 'number' }, y: { type: 'number' }, zoom: { type: 'number' } },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const;

/** schema 文件清单（相对数据目录根） */
const SCHEMA_FILES: Record<string, unknown> = {
  'schema/index.schema.json': INDEX_SCHEMA,
  'schema/project.schema.json': PROJECT_SCHEMA,
  'schema/session.schema.json': SESSION_SCHEMA,
};

/**
 * 确保 schema/ 三个文件存在（总是覆盖：schema 跟代码版本走）
 *
 * :param adapter: 存储适配器
 */
export async function ensureSchemas(adapter: StorageAdapter): Promise<void> {
  for (const [path, schema] of Object.entries(SCHEMA_FILES)) {
    await adapter.writeJson(path, schema);
  }
}
