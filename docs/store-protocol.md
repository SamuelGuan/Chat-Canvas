# 消息服务协议 v1

> **版本**: v1（`PROTOCOL_VERSION = 1`，见 `src/lib/storage/protocol.ts`）
> **地位**: 存储层唯一权威契约。Vite dev server 中间件是协议的首个实现；
> 未来 Python FastAPI / 独立后端照同一契约实现，前端 `DevServerAdapter` 零改动直连。
> **变更规矩**: 路由 / 语义 / 错误格式任何变更必须升级 `PROTOCOL_VERSION` 并同步本文档。

---

## 1. 目的与边界

渲染层（浏览器 / Electron Renderer）不直接读写文件系统，一切持久化访问经
`StorageAdapter` 接口（`src/lib/storage/protocol.ts`）穿过进程边界：

- 上层代码只经 StorageAdapter 访问持久化，禁止直接 import fs 等 Node 专用 API；
- 穿过适配器的数据必须可 JSON 序列化；undo 栈等内存态不得混入；
- 二进制资源走 `projects/<pid>/assets/` 相对路径引用，不内嵌 JSON —— 文件传输与消息分离；
- `readJson` 对不存在路径返回 `null`（非抛错）；写操作语义 = **原子替换**
  （tmp + rename 由实现侧负责，调用方无感知）；
- 错误格式统一 `{ error: string, code: string }`，由适配器翻译为 throw。

## 2. 适配器与运行时选择

| 实现 | 适用环境 | 机制 |
|---|---|---|
| `ElectronFsAdapter` | Electron（dev + 打包） | preload `window.electronAPI.store*` → IPC 到主进程 fs |
| `DevServerAdapter` | 浏览器 dev / 远端服务 | 同源相对路径 fetch `/api/store/*`；baseURL 指向远端即 `http-remote` |
| `LocalStorageAdapter` | 静态构建 / 降级兜底 | localStorage 模拟文件布局，兼作旧数据迁移源 |

启动选择顺序（任一探测失败自动降级）：

1. `VITE_REMOTE_STORE_URL` 存在且 health 探测通过 → `DevServerAdapter(remoteUrl)`（`http-remote`）
2. Electron 环境且 preload 暴露 `storeRead` → `ElectronFsAdapter`
3. `/api/store/health` 探测通过 → `DevServerAdapter()`（`dev-server`）
4. 否则 → `LocalStorageAdapter`

## 3. 路由表（HTTP 实现）

挂载点：`/api/store`。`rel` / `dir` 均为相对数据目录根（`chat-canvas-data/`）的路径。

| 请求 | 动作 | 成功响应 | 对应 fs 操作 |
|---|---|---|---|
| `GET /health` | 能力描述 | 200 `{ kind, version, capabilities }` | — |
| `GET /events` | 服务端推送（**预留占位，v1 不实现**） | 501 `{ error, code: 'NOT_IMPLEMENTED' }` | SSE：外部变更通知 / 解析进度 |
| `GET /file?p=<rel>` | 读 JSON | 200 `<JSON>`；不存在 404 | `fs.readFile(dataRoot/<rel>)` |
| `PUT /file?p=<rel>` | 写 JSON | 200 `{ ok: true }` | 写 `<rel>.tmp` 后 `fs.rename` 原子替换 |
| `DELETE /file?p=<rel>` | 删文件/目录（递归，幂等） | 200 `{ ok: true }` | `fs.rm(..., { recursive: true, force: true })` |
| `GET /list?p=<dir>` | 列目录直接子项名 | 200 `string[]`；目录不存在返回 `[]` | `fs.readdir` |

Electron 侧等价 IPC 通道（语义与上表一一对应）：`store:read` / `store:write` / `store:delete` / `store:list`。

## 4. 错误格式

所有非 2xx 响应体统一为：

```json
{ "error": "人类可读描述", "code": "机器可判错误码" }
```

| code | HTTP | 含义 |
|---|---|---|
| `EINVAL` | 400 | 路径非法（空 / 含 NUL / 目录穿越 / 非 .json 后缀） |
| `EPARSE` | 400/500 | 请求体或磁盘文件 JSON 解析失败 |
| `ENOENT` | 404 | `GET /file` 目标不存在（适配器翻译为 `null`，非 throw） |
| `ENOTFOUND` | 404 | 未知路由 |
| `NOT_IMPLEMENTED` | 501 | 协议预留能力（如 `/events`） |
| `EINTERNAL` | 500 | 未分类服务端错误 |

## 5. 安全约束（本机也必须有）

- `dataRoot = path.resolve(process.cwd(), 'chat-canvas-data')`（Electron 打包后为
  `app.getPath('userData')/chat-canvas-data/`）；每个请求 `path.resolve(dataRoot, rel)` 后
  必须 `startsWith(dataRoot + sep)`，防目录穿越；
- 读 / 写仅允许 `.json` 后缀（DELETE 允许目录，但禁止删除数据目录根本身）；
- 同一路径的写操作在服务端串行化（单进程单窗口基本无并发，此为兜底）；
- 中间件只存在于 dev server，`vite build` 产物不含 —— 静态部署自动降级 LocalStorageAdapter。

## 6. 数据目录布局（v0.4 Phase 1 现状）

```
chat-canvas-data/                  # 项目仓库 gitignore；目录内部独立 git 仓库（Q1）
├── state.json                     # persist 整包 blob（Phase 1 形态，zustand { state, version } 信封）
├── migration-backup-<ts>.json     # 旧 localStorage 迁移前的原样硬拷贝备份
└── .git/                          # 数据目录内独立仓库（best-effort init）
```

Phase 2 起拆分为三级文件（`index.json` / `projects/<pid>/project.json` /
`projects/<pid>/sessions/<sid>.json`），拆分规则与 schema 见 `versions/v0.4.md` 第 3、12 节。

## 7. 版本历史

| version | 变更 |
|---|---|
| 1 | 首版：health / file / list / delete + events 预留占位 |
