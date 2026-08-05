/**
 * src/lib/storage/protocol.ts
 * 《消息服务协议 v1》共享常量与类型（纯定义，Node 侧 / 渲染层均可引用，禁止引入环境专用 API）。
 * 协议任何变更需升 PROTOCOL_VERSION，并同步 docs/store-protocol.md。
 */

/** 协议版本：路由 / 语义 / 错误格式任何变更需升级 */
export const PROTOCOL_VERSION = 1;

/** 数据目录名（相对项目根；Electron 打包后落到 userData 下同名目录） */
export const DATA_DIR_NAME = 'chat-canvas-data';

/** 同源 store API 挂载路径 */
export const STORE_API_BASE = '/api/store';

/** Phase 1 整包状态文件（相对数据目录根） */
export const STATE_FILE = 'state.json';

/** v0.3 及以前的 localStorage 存储 key（一次性迁移源） */
export const LEGACY_STORAGE_KEY = 'chat-canvas-session';

/** health 能力描述（adapter 选择依据） */
export interface StoreHealth {
  kind: string;
  version: number;
  capabilities: string[];
}

/**
 * 存储适配器：渲染层访问持久化的唯一入口。
 * relPath 一律相对数据目录根；穿过适配器的数据必须可 JSON 序列化。
 */
export interface StorageAdapter {
  kind: 'electron-fs' | 'dev-server' | 'http-remote' | 'localstorage';
  /** 读 JSON；路径不存在返回 null（非抛错） */
  readJson(relPath: string): Promise<unknown | null>;
  /** 写 JSON；语义 = 原子替换（tmp + rename 由实现侧负责，调用方无感知） */
  writeJson(relPath: string, data: unknown): Promise<void>;
  /** 删除文件或目录（递归） */
  delete(relPath: string): Promise<void>;
  /** 列目录直接子项名，用于一致性校验；目录不存在返回 [] */
  list(dirRelPath: string): Promise<string[]>;
}

/** 统一错误格式 { error, code } 经适配器翻译后的抛出形态 */
export class StoreError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}
