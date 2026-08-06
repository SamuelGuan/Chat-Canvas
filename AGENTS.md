# AGENTS.md — 编程 agent 操作协议

> 面向 Codex / Claude Code / Trae 等编程 agent 的数据层入口协议。
> 人类开发者请参考 `docs/store-protocol.md`（消息服务协议 v2）与 `versions/v0.4.md`（架构设计）。

## 核心原则

**权威状态在磁盘文件，内存只是缓存；任何进程改完文件都必须跑 `npm run check-data` 收敛。**

## 数据布局（`chat-canvas-data/`）

```
chat-canvas-data/
├── index.json                  # MBR：{ version, activeProjectId, projects: [...] }
├── schema/                     # 三级文件 JSON Schema（唯一权威格式定义，先读它再读写）
│   ├── index.schema.json
│   ├── project.schema.json
│   └── session.schema.json
└── projects/
    └── <projectId>/            # 项目 id = 文件夹名（改名只改 JSON 内 name，不动路径）
        ├── project.json        # PBR：{ version, id, name, activeSessionId, sessionIds, sessionMeta? }
        ├── assets/             # 二进制资源（PDF/图片等）；JSON 内只存相对路径引用，不内嵌
        └── sessions/
            └── <sessionId>.json  # SessionData + version（节点/边/消息/视口）
```

## 不变量（改文件时必须守住）

1. **固定项目** `proj_default`（默认项目）与 `proj_imported`（导入的 Sessions）必须存在且 `pinned: true`，不可删除；
2. `index.json` 的 `projects` 与 `projects/` 实际文件夹一一对应；
3. `project.json` 的 `sessionIds` 与 `sessions/` 实际 `.json` 文件一一对应；
4. `sessionMeta`（可选缓存）的键集合与 `sessionIds` 一致；
5. `activeProjectId` / `activeSessionId` 必须指向存在的条目；
6. 每个 JSON 文件携带 `version`（当前为 1）；格式以 `schema/` 为准；
7. 孤儿 Session（所在文件夹无 project.json）归拢到 `proj_imported`；
8. 写文件用**原子替换**（写 `<file>.tmp` 后 rename），不要半截写入；
9. 图片/PDF 等二进制放 `projects/<pid>/assets/`，JSON 里只写相对路径引用。

## 操作规矩

- **改完任何 `chat-canvas-data/` 下的文件，必须执行 `npm run check-data`**：它会按上表规则收敛索引与磁盘（幂等），并打印报告；
- 应用在运行时改文件，文件监听会自动收敛并通知前端；激活 Session 被改时前端会弹确认框（用户决定是否重载）——所以**避免改激活中的 Session 文件**，除非确有必要；
- 不要手改 `migration-backup-*.json` / `state.blob-backup.json`（迁移备份，只读）；
- 不要删除 `schema/` 目录；
- 读写 JSON 一律 UTF-8。

## 自动化接入

- 本机 HTTP API（dev server 运行时）：`GET/PUT/DELETE /api/store/file?p=<rel>`、`GET /api/store/list?p=<dir>`、`GET /api/store/health`、`GET /api/store/events`（SSE），契约见 `docs/store-protocol.md`；
- 未来 Python sidecar：FastAPI 实现同一契约即可被前端自动探测接入（`VITE_REMOTE_STORE_URL`）。
