/**
 * src/store/sessionRuntime.ts
 * SessionRuntime（分区数据区）：激活 Session 驻留。
 * —— 每个 Session 的权威状态只有一份：激活态由本类持有（zustand state.session 为同一引用的响应式视图），
 *    非激活态权威 = 磁盘文件；切换时旧实例先落盘再卸载，无副本。
 * —— undo/redo 栈随实例驻留内存，不落盘，随实例销毁自然清理。
 * —— 内容变化防抖 500ms 写本 session 文件；元数据变化立即写。
 */
import { debounce, cloneSession } from '@/lib/utils';
import { sessionFilePath } from '@/lib/storage/paths';
import type { StorageAdapter } from '@/lib/storage/protocol';
import { STORE_FILE_VERSION, type SessionData, type SessionFile } from '@/types';

/** undo 栈上限（与旧版一致） */
const HISTORY_LIMIT = 50;
/** 内容变化落盘防抖间隔（ms） */
const PERSIST_DEBOUNCE_MS = 500;

export class SessionRuntime {
  /** 激活 Session 权威状态（仅经 commit/undo/redo 变更；外部只读） */
  session: SessionData;
  private past: SessionData[] = [];
  private future: SessionData[] = [];
  private readonly adapter: StorageAdapter;
  private readonly scheduleWrite: ReturnType<typeof debounce>;

  constructor(adapter: StorageAdapter, session: SessionData) {
    this.adapter = adapter;
    this.session = session;
    this.scheduleWrite = debounce(() => {
      void this.flush().catch((e) => console.error('[SessionRuntime] 落盘失败', e));
    }, PERSIST_DEBOUNCE_MS);
  }

  /**
   * 提交新状态：默认记录 undo 历史并防抖落盘
   *
   * :param next: 新 Session 状态（新引用，调用方保证不就地修改旧对象）
   * :param opts.history: 是否进 undo 栈（视口移动等高频操作传 false）
   * :param opts.immediate: 是否立即落盘（元数据变化传 true，绕过防抖）
   */
  commit(next: SessionData, opts: { history?: boolean; immediate?: boolean } = {}): void {
    if (opts.history ?? true) {
      this.past.push(cloneSession(this.session));
      this.past = this.past.slice(-HISTORY_LIMIT);
      this.future = [];
    }
    this.session = next;
    if (opts.immediate) {
      this.scheduleWrite.cancel();
      void this.flush().catch((e) => console.error('[SessionRuntime] 落盘失败', e));
    } else {
      this.scheduleWrite();
    }
  }

  /** 撤销：past 栈顶换入，当前状态入 future；空栈返回 false（无操作） */
  undo(): boolean {
    const prev = this.past.pop();
    if (!prev) return false;
    this.future.push(cloneSession(this.session));
    this.session = prev;
    this.scheduleWrite();
    return true;
  }

  /** 重做：future 栈顶换入，当前状态入 past；空栈返回 false（无操作） */
  redo(): boolean {
    const next = this.future.pop();
    if (!next) return false;
    this.past.push(cloneSession(this.session));
    this.session = next;
    this.scheduleWrite();
    return true;
  }

  /** 立即落盘（tmp + rename 原子替换由适配器负责）；切换/卸载前必须调用 */
  async flush(): Promise<void> {
    const file: SessionFile = { ...this.session, version: STORE_FILE_VERSION };
    await this.adapter.writeJson(sessionFilePath(this.session.projectId, this.session.id), file);
  }

  /** 卸载：丢弃未触发的防抖写入（删除 Session/项目场景防止已删文件被重写） */
  dispose(): void {
    this.scheduleWrite.cancel();
  }
}
