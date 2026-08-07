/**
 * src/store/projectManager.ts
 * ProjectManager（PBR）：项目内事务 —— Session 注册表、activeSessionId、项目内 Session 文件 CRUD。
 * 职责边界与磁盘边界一致：只读写本项目 project.json 与 sessions/ 下文件，不碰 index.json。
 * Q3：仅激活项目驻留实例；非激活项目的 project.json 变更经 load → 改 → persist 即弃。
 */
import type { StorageAdapter } from '@/lib/storage/protocol';
import { projectDir, projectFilePath, sessionFilePath } from '@/lib/storage/paths';
import {
  STORE_FILE_VERSION,
  type AssetIndexEntry,
  type ProjectData,
  type ProjectFile,
  type NodeResourceRef,
  type SessionData,
  type SessionFile,
  type SessionMeta,
} from '@/types';

export class ProjectManager {
  private constructor(
    private readonly adapter: StorageAdapter,
    private file: ProjectFile,
  ) {}

  /** 装载项目（读 project.json）；文件夹 / 文件不存在返回 null */
  static async load(adapter: StorageAdapter, pid: string): Promise<ProjectManager | null> {
    const raw = (await adapter.readJson(projectFilePath(pid))) as ProjectFile | null;
    return raw ? new ProjectManager(adapter, raw) : null;
  }

  /** 新建项目文件夹 + 空 project.json（sessionIds 为空，activeSessionId 为 null） */
  static async create(adapter: StorageAdapter, meta: ProjectData): Promise<ProjectManager> {
    const file: ProjectFile = {
      version: STORE_FILE_VERSION,
      id: meta.id,
      name: meta.name,
      activeSessionId: null,
      sessionIds: [],
    };
    const pm = new ProjectManager(adapter, file);
    await pm.persist();
    return pm;
  }

  get projectId(): string {
    return this.file.id;
  }
  get sessionIds(): string[] {
    return this.file.sessionIds;
  }
  get activeSessionId(): string | null {
    return this.file.activeSessionId;
  }

  /** Session 元信息缓存（懒加载支撑；可能为空，由一致性校验重建） */
  get sessionMetaMap(): Record<string, SessionMeta> {
    return this.file.sessionMeta ?? {};
  }

  getSessionMeta(sid: string): SessionMeta | undefined {
    return this.file.sessionMeta?.[sid];
  }

  get assetIndex(): Record<string, AssetIndexEntry> {
    return this.file.assetIndex ?? {};
  }

  /** 登记 Session（可选同时置为激活 / 写入元信息缓存），立即写 project.json */
  async registerSession(sid: string, makeActive = false, meta?: SessionMeta): Promise<void> {
    if (!this.file.sessionIds.includes(sid)) this.file.sessionIds.push(sid);
    if (makeActive) this.file.activeSessionId = sid;
    if (meta) {
      this.file.sessionMeta ??= {};
      this.file.sessionMeta[sid] = meta;
    }
    await this.persist();
  }

  /** 注销 Session（若为激活则清空 activeSessionId，并移除元信息缓存），立即写 project.json */
  async unregisterSession(sid: string): Promise<void> {
    this.file.sessionIds = this.file.sessionIds.filter((x) => x !== sid);
    if (this.file.activeSessionId === sid) this.file.activeSessionId = null;
    if (this.file.sessionMeta) delete this.file.sessionMeta[sid];
    await this.persist();
  }

  /** 更新 Session 元信息缓存（改名 / 卸载落盘时保持新鲜），立即写 project.json */
  async updateSessionMeta(sid: string, meta: SessionMeta): Promise<void> {
    if (!this.file.sessionIds.includes(sid)) return;
    this.file.sessionMeta ??= {};
    this.file.sessionMeta[sid] = meta;
    await this.persist();
  }

  /** 更新项目内激活 Session 指针，立即写 project.json */
  async setActiveSession(sid: string | null): Promise<void> {
    if (this.file.activeSessionId === sid) return;
    this.file.activeSessionId = sid;
    await this.persist();
  }

  /** 项目改名（只改 JSON 内 name 字段，不动路径），立即写 project.json */
  async renameProject(name: string): Promise<void> {
    this.file.name = name;
    await this.persist();
  }

  /** 用节点最新资源引用同步项目级资源索引，返回已无引用的孤儿路径 */
  async syncNodeResources(sessionId: string, nodeId: string, refs: NodeResourceRef[]): Promise<string[]> {
    const nextIndex: Record<string, AssetIndexEntry> = { ...(this.file.assetIndex ?? {}) };
    const orphanPaths: string[] = [];
    let dirty = false;

    for (const [path, entry] of Object.entries(nextIndex)) {
      const keptRefs = entry.refs.filter((ref) => !(ref.sessionId === sessionId && ref.nodeId === nodeId));
      if (keptRefs.length !== entry.refs.length) {
        dirty = true;
        if (keptRefs.length === 0) {
          delete nextIndex[path];
          orphanPaths.push(path);
        } else {
          nextIndex[path] = { ...entry, refs: keptRefs };
        }
      }
    }

    for (const ref of refs) {
      const entry = nextIndex[ref.path] ?? { path: ref.path, refs: [] };
      const exists = entry.refs.some(
        (item) => item.sessionId === sessionId
          && item.nodeId === nodeId
          && item.kind === ref.kind
          && item.field === ref.field,
      );
      if (!exists) {
        entry.refs = [...entry.refs, { ...ref, sessionId, nodeId }];
        nextIndex[ref.path] = entry;
        dirty = true;
      }
    }

    if (dirty) {
      this.file.assetIndex = nextIndex;
      await this.persist();
    }
    return orphanPaths.filter((path) => !refs.some((ref) => ref.path === path));
  }

  /** 删除整个 Session 的资源引用，返回已无引用的孤儿路径 */
  async removeSessionResources(sessionId: string): Promise<string[]> {
    const nextIndex: Record<string, AssetIndexEntry> = { ...(this.file.assetIndex ?? {}) };
    const orphanPaths: string[] = [];
    let dirty = false;

    for (const [path, entry] of Object.entries(nextIndex)) {
      const keptRefs = entry.refs.filter((ref) => ref.sessionId !== sessionId);
      if (keptRefs.length !== entry.refs.length) {
        dirty = true;
        if (keptRefs.length === 0) {
          delete nextIndex[path];
          orphanPaths.push(path);
        } else {
          nextIndex[path] = { ...entry, refs: keptRefs };
        }
      }
    }

    if (dirty) {
      this.file.assetIndex = nextIndex;
      await this.persist();
    }
    return orphanPaths;
  }

  /** 一致性校验后整体替换资源索引 */
  async replaceAssetIndex(assetIndex: Record<string, AssetIndexEntry>): Promise<void> {
    this.file.assetIndex = assetIndex;
    await this.persist();
  }

  /** 写 Session 内容文件（立即写，携带文件版本） */
  async writeSession(session: SessionData): Promise<void> {
    const file: SessionFile = { ...session, version: STORE_FILE_VERSION };
    await this.adapter.writeJson(sessionFilePath(this.file.id, session.id), file);
  }

  /** 读 Session 内容文件（剥离文件版本字段）；不存在返回 null */
  async readSession(sid: string): Promise<SessionData | null> {
    const raw = (await this.adapter.readJson(sessionFilePath(this.file.id, sid))) as SessionFile | null;
    if (!raw) return null;
    const { version: _version, ...session } = raw;
    return session;
  }

  /** 删 Session 内容文件 */
  async deleteSessionFile(sid: string): Promise<void> {
    await this.adapter.delete(sessionFilePath(this.file.id, sid));
  }

  /** 删除整个项目文件夹（递归，含 assets 与全部 Session 文件） */
  async destroy(): Promise<void> {
    await this.adapter.delete(projectDir(this.file.id));
  }

  private async persist(): Promise<void> {
    await this.adapter.writeJson(projectFilePath(this.file.id), this.file);
  }
}
