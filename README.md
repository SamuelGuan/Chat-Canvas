# Chat Canvas — 画布式 AI 聊天前端

> 无限画布上自由放置聊天卡片，箭头连线表示逻辑流和上下文传递。
> 个人本地使用，纯前端，数据存浏览器 / 本地文件。

## ✨ 功能特性

- 🎨 **无限画布** — 拖拽平移、滚轮缩放、框选多选
- 💬 **聊天卡片** — 每张卡片独立对话，支持 Markdown + 代码高亮
- 🔗 **箭头连线** — 实线=继承上下文，虚线=仅引用
- 🌳 **树型分支** — 从任意卡片分叉，多路对比
- 💾 **本地持久化** — 刷新/重启不丢（IndexedDB）
- 🔌 **官网 API 直连** — 支持 DeepSeek / Kimi(Moonshot) / 智谱 GLM，注册即领免费 Key
- 🖥️ **双模式** — Web 浏览器 + Electron 桌面端
- 🌙 **暗色模式** — 浅色/暗色/跟随系统
- ↩️ **撤销/重做** — 50 步历史

## 🚀 快速启动

### Web 模式（默认）

```bash
npm install
npm run dev
```

打开 http://localhost:3000

### Electron 桌面模式

```bash
npm install
npm run dev:electron
```

弹出桌面窗口，体验原生菜单和全局快捷键。

### 打包桌面应用

```bash
# macOS
npm run package:mac

# Windows
npm run package:win

# Linux
npm run package:linux
```

输出文件在 `release/` 目录。

## 📖 使用说明

### 创建卡片
**双击画布空白处** → 弹出一张聊天卡片

### 发送消息
1. 点击卡片，在底部输入框打字
2. **Enter** 发送 / **Shift+Enter** 换行
3. 看到流式打字机效果

### 连线（核心功能）
1. 从卡片**底部圆点**拖出箭头
2. 连接到目标卡片**顶部圆点**
3. 实线 = 继承上下文（上游回复会拼入下游 prompt）
4. 点击连线可切换 **实线 ↔ 虚线**

### 分支对话
- 从同一张卡片拖出**多条箭头** → 多次追问 / 对比不同模型
- 选中卡片按 **Delete** 删除

### 配置 LLM
1. 点击右上角 **⚙ 设置**
2. 在「选择服务商」区域**点击卡片**（DeepSeek / Kimi / GLM）
3. 点击「去 xxx 官网获取」链接，**注册并领取免费 API Key**
4. 粘贴 Key → 点 **测试连接** → 显示 ✓ 即可
5. 回到画布，开始对话

#### 支持的服务商

| 服务商 | 品牌 | Base URL | 推荐模型 | 免费额度 |
|---|---|---|---|---|
| **DeepSeek** | deepseek.com | `https://api.deepseek.com/v1` | `deepseek-chat`（通用）<br>`deepseek-reasoner`（推理） | ✅ 注册送 10 元 |
| **Moonshot AI** | moonshot.cn（Kimi） | `https://api.moonshot.cn/v1` | `moonshot-v1-8k`（默认）<br>`moonshot-v1-128k`（长文本） | ✅ 注册送 15 元 |
| **智谱 AI** | zhipuai.cn（GLM） | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash`（永久免费）<br>`glm-4-plus`（最强） | ✅ glm-4-flash 免费 |

> 💡 三家都兼容 OpenAI 接口格式，切换服务商时 Base URL 和模型列表会**自动填充**。
> 💡 不配置 API Key 也能用 **Mock 模式** 体验完整交互。

### 快捷键

| 快捷键 | 功能 |
|---|---|
| 双击画布 | 新建卡片 |
| Enter | 发送消息 |
| Shift+Enter | 换行 |
| Delete / Backspace | 删除选中 |
| Cmd/Ctrl+Z | 撤销 |
| Cmd/Ctrl+Shift+Z | 重做 |
| Cmd/Ctrl+S | 导出 JSON |
| Cmd/Ctrl+, | 打开设置 |

### Electron 专属快捷键

| 快捷键 | 功能 |
|---|---|
| Cmd/Ctrl+Shift+N | 新建卡片 |
| Cmd/Ctrl+= | 放大画布 |
| Cmd/Ctrl+- | 缩小画布 |
| Cmd/Ctrl+0 | 重置缩放 |
| F11 | 全屏 |

## 🏗️ 技术架构

```
chat-canvas/
├── electron/              # Electron 主进程
│   ├── main.ts            # 主进程入口（窗口/安全存储/IPC）
│   ├── preload.ts         # 预加载脚本（contextBridge）
│   ├── menu.ts            # 原生菜单
│   ├── storage.ts         # safeStorage 封装
│   └── ipc-channels.ts   # IPC 通道常量
├── src/                   # 前端源码（Web + Electron 共用）
│   ├── types/             # 全局类型
│   ├── store/             # Zustand 状态管理
│   │   ├── useCanvasStore.ts  # 画布/节点/边/撤销重做
│   │   ├── useChatStore.ts    # 消息/流式状态
│   │   └── useSettingsStore.ts# 设置/主题
│   ├── components/
│   │   ├── Canvas/        # React Flow 画布
│   │   ├── ChatNode/      # 聊天卡片（核心组件）
│   │   └── Settings/      # 设置面板
│   ├── lib/
│   │   ├── llm.ts         # LLM API（fetch + SSE，DeepSeek/Kimi/GLM）
│   │   ├── mockStream.ts  # Mock 打字机
│   │   ├── contextBuilder.ts # 上下文拼接 + 环检测
│   │   └── utils.ts       # 工具函数
│   ├── hooks/
│   │   └── useElectron.ts # 环境检测 + 安全存储桥
│   ├── styles/
│   │   └── globals.css    # 全局样式 + 暗色模式
│   ├── App.tsx            # 主应用
│   └── main.tsx           # 入口
├── index.html
├── package.json
├── electron.vite.config.ts
├── tsconfig.json
├── tailwind.config.js
├── postcss.config.js
├── CODEX.md               # Agent 行为准则
├── REQUIREMENTS.md        # 产品需求文档
├── SOURCES.md             # 素材库清单
└── TODO.md                # 交付检查清单
```

## 📄 License

MIT
