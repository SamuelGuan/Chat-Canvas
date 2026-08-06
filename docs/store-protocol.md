# 消息服务协议 v1

> **版本**: v2（`PROTOCOL_VERSION = 2`，见 `src/lib/storage/protocol.ts`）
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

「项目 = 磁盘文件夹」是硬设计，**不支持 localStorage 兜底**：无文件存储后端（如静态部署的纯
浏览器环境）时适配器选择抛 `ENOBACKEND`，应用回退空画布且不持久化。

启动选择顺序（任一探测失败自动降级）：

1. `VITE_REMOTE_STORE_URL` 存在且 health 探测通过 → `DevServerAdapter(remoteUrl)`（`http-remote`）
2. Electron 环境且 preload 暴露 `storeRead` → `ElectronFsAdapter`
3. `/api/store/health` 探测通过 → `DevServerAdapter()`（`dev-server`）
4. 否则 → 抛 `ENOBACKEND`（bootstrap 捕获，回退默认空画布）

## 3. 路由表（HTTP 实现）

挂载点：`/api/store`。`rel` / `dir` 均为相对数据目录根（`chat-canvas-data/`）的路径。

| 请求 | 动作 | 成功响应 | 对应 fs 操作 |
|---|---|---|---|
| `GET /health` | 能力描述 | 200 `{ kind, version, capabilities }` | — |
| `GET /events` | SSE 服务端推送（外部变更通知） | 200 `text/event-stream` 长连接 | chokidar 监听 → 一致性收敛 → 广播 |
| `GET /file?p=<rel>` | 读 JSON | 200 `<JSON>`；不存在 404 | `fs.readFile(dataRoot/<rel>)` |
| `PUT /file?p=<rel>` | 写 JSON | 200 `{ ok: true }` | 写 `<rel>.tmp` 后 `fs.rename` 原子替换 |
| `DELETE /file?p=<rel>` | 删文件/目录（递归，幂等） | 200 `{ ok: true }` | `fs.rm(..., { recursive: true, force: true })` |
| `GET /list?p=<dir>` | 列目录直接子项名 | 200 `string[]`；目录不存在返回 `[]` | `fs.readdir` |

Electron 侧等价 IPC 通道（语义与上表一一对应）：`store:read` / `store:write` / `store:delete` / `store:list`；
外部变更推送走主进程 → 渲染进程 `store:changed` 通道（对应 SSE 的 `store-changed` 事件）。

### SSE 事件格式（v2 起）

`GET /events` 返回长连接，外部进程改动数据目录文件并完成一致性收敛后广播：

```
data: {"type":"store-changed","paths":["<变更文件绝对路径>"]}
```

服务端实现要点：chokidar 监听数据目录（忽略 `.git/`、原子写 tmp、`schema/`），
去抖 300ms；**本进程自身经 storeCore 的写入被过滤**（自写事件不触发收敛广播）。

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
- 中间件只存在于 dev server，`vite build` 产物不含 —— 静态部署无文件存储后端（见第 2 节）。

## 6. 数据目录布局（v0.4 Phase 3 现状）

```
chat-canvas-data/                  # 项目仓库 gitignore；目录内部独立 git 仓库（Q1）
├── index.json                     # MBR：{ version, activeProjectId, projects: [ProjectMeta...] }
├── schema/                        # 三级文件 JSON Schema（唯一权威格式定义，启动时落地）
│   ├── index.schema.json / project.schema.json / session.schema.json
├── state.blob-backup.json         # Phase 1 整包 blob 拆分前的硬备份（一次性迁移产物）
├── migration-backup-<ts>.json     # 旧 localStorage 迁移前的硬拷贝备份（一次性迁移产物）
├── projects/
│   ├── <pid>/
│   │   ├── project.json           # PBR：{ version, id, name, activeSessionId, sessionIds, sessionMeta? }
│   │   ├── assets/                # 二进制资源（后续 PDF/图片），JSON 内仅存相对路径引用
│   │   └── sessions/
│   │       └── <sid>.json         # 分区数据区：{ version, ...SessionData }
│   └── ...
└── .git/                          # 数据目录内独立仓库（best-effort init）
```

三级文件各携带独立 `version`（当前 `STORE_FILE_VERSION = 1`），支持按文件粒度懒升级；
id 即路径（project id = 文件夹名，session id = 文件名），改名只改 JSON 内 name 字段；
`sessionMeta` 为可选懒加载元信息缓存（缺失由一致性校验重建，additive 不升版本）。

## 6.1 一致性校验与多写者收敛

外部进程（agent / Python sidecar / 手动）可直接改数据目录文件，三道防线收敛：

1. **启动自愈**：应用启动时执行 `reconcileData`（`src/lib/storage/consistency.ts`，幂等）；
2. **校验 CLI**：`npm run check-data`（`scripts/checkData.ts`，同一实现）——外部进程改完文件的手动触发器；
3. **文件监听**：中间件 / 主进程 chokidar 监听 → 外部变更 → 重校验 + SSE/IPC 通知渲染层；
   激活 Session 被外部修改时前端弹确认框（Q6：不自动 reload），其余直接收敛。

收敛规则（索引 vs 磁盘两个事实来源）：索引有/磁盘无 → 剔除；磁盘有/索引无 → 收录（含
读 project.json 挂载整个外部拷入的项目）；孤儿 Session 文件（文件夹无 project.json）
→ 移动到 `proj_imported`；固定项目缺失或 pinned 丢失 → 重建/补回。

## 7. 版本历史

| version | 变更 |
|---|---|
| 1 | 首版：health / file / list / delete + events 预留占位 |
| 2 | events 落地（SSE store-changed：文件监听 + 一致性收敛 + 推送）；数据目录新增 schema/ 三级 JSON Schema；新增 `npm run check-data` 校验 CLI |
