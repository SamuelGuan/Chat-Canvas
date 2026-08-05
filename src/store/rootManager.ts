/**
 * src/store/rootManager.ts
 * RootManager（MBR）：跨项目事务 —— 项目注册表、activeProjectId、固定项目不变量、导入路由。
 * 职责边界与磁盘边界一致：只读写 index.json，不碰 project.json 与 session 文件。
 */
import type { StorageAdapter } from '@/lib/storage/protocol';
import { INDEX_FILE } from '@/lib/storage/paths';
import {
  DEFAULT_PROJECT_ID,
  IMPORT_PROJECT_ID,
  STORE_FILE_VERSION,
  type ProjectData,
  type RootIndex,
} from '@/types';

export class RootManager {
  private constructor(
    private readonly adapter: StorageAdapter,
    private index: RootIndex,
  ) {}

  /** 装载根索引；不存在则建立含两个固定项目的默认注册表并落盘 */
  static async load(adapter: StorageAdapter): Promise<RootManager> {
    const raw = (await adapter.readJson(INDEX_FILE)) as RootIndex | null;
    if (raw) return new RootManager(adapter, raw);
    const now = Date.now();
    const index: RootIndex = {
      version: STORE_FILE_VERSION,
      activeProjectId: DEFAULT_PROJECT_ID,
      projects: [
        { id: DEFAULT_PROJECT_ID, name: '默认项目', pinned: true, createdAt: now, updatedAt: now },
        { id: IMPORT_PROJECT_ID, name: '导入的 Sessions', pinned: true, createdAt: now, updatedAt: now },
      ],
    };
    const root = new RootManager(adapter, index);
    await root.persist();
    return root;
  }

  get activeProjectId(): string {
    return this.index.activeProjectId;
  }

  /** 全部项目 id（注册表顺序） */
  get projectIds(): string[] {
    return this.index.projects.map((p) => p.id);
  }

  /** 项目注册表（id → meta），与渲染层 state.projects 形状一致 */
  get projects(): Record<string, ProjectData> {
    return Object.fromEntries(this.index.projects.map((p) => [p.id, { ...p }]));
  }

  has(pid: string): boolean {
    return this.index.projects.some((p) => p.id === pid);
  }

  /** 切换激活项目，立即写 index.json */
  async setActiveProject(pid: string): Promise<void> {
    if (this.index.activeProjectId === pid) return;
    this.index.activeProjectId = pid;
    await this.persist();
  }

  /** 登记新项目，立即写 index.json */
  async addProject(meta: ProjectData): Promise<void> {
    this.index.projects.push({ ...meta });
    await this.persist();
  }

  /** 注销项目（激活项目被删时回退到注册表首个项目），立即写 index.json */
  async removeProject(pid: string): Promise<void> {
    this.index.projects = this.index.projects.filter((p) => p.id !== pid);
    if (this.index.activeProjectId === pid) {
      this.index.activeProjectId = this.index.projects[0]?.id ?? DEFAULT_PROJECT_ID;
    }
    await this.persist();
  }

  /** 项目改名（只改 JSON 内 name 字段，不动路径），立即写 index.json */
  async renameProject(pid: string, name: string): Promise<void> {
    const p = this.index.projects.find((x) => x.id === pid);
    if (!p) return;
    p.name = name;
    p.updatedAt = Date.now();
    await this.persist();
  }

  /** 固定项目 pinned 不变量补回（启动自愈用），立即写 index.json */
  async ensurePinned(pid: string, name: string): Promise<void> {
    const p = this.index.projects.find((x) => x.id === pid);
    if (!p) {
      const now = Date.now();
      this.index.projects.push({ id: pid, name, pinned: true, createdAt: now, updatedAt: now });
      await this.persist();
    } else if (!p.pinned) {
      p.pinned = true;
      await this.persist();
    }
  }

  private async persist(): Promise<void> {
    await this.adapter.writeJson(INDEX_FILE, this.index);
  }
}
