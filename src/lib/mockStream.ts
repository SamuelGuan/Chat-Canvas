/**
 * src/lib/mockStream.ts
 * Mock 流式输出：无 API Key 时启用，打字机效果。
 * 修复 D-10：统一 abort 语义，与 llm.ts 一致（throw 'UserAbort'）。
 * 新增：图片识别 mock 回复。
 */
import { StreamCallbacks } from './llm';
import { MessageContent } from '@/types';

const MOCK_REPLIES = [
  `收到！这是一个 **Mock 回复**，当前没有配置 LLM API Key。

你可以：

1. 打开设置面板（左侧边栏底部的「设置」按钮）
2. 选择服务商，填入 API Key
3. 回到画布开始对话

> 支持 DeepSeek / Kimi (Moonshot) / 智谱 GLM 等所有 OpenAI 兼容接口。

\`\`\`ts
// 示例：DeepSeek Chat
服务商: DeepSeek
baseURL: https://api.deepseek.com/v1
model: deepseek-chat
\`\`\`
`,

  `好的，我来帮你分析一下。

## 要点总结

- 画布上的**每张卡片**是一个独立对话单元
- **箭头连线**表示上下文继承关系
- 从一张卡拖出多条箭头 = 多次追问 / 对比不同模型
- 刷新页面数据**不会丢失**（已持久化到 localStorage）

## 下一步建议

在设置里配置真实的 LLM API，体验完整的流式对话效果。`,

  `这是一个树型消息图的演示回复。

当前节点可以：

- 继续往下追问（拖出新卡片）
- 切换模型重新生成
- 从任意历史节点分叉出新分支

所有操作都**实时保存**到本地浏览器。`,

  `Mock 模式已启用。

要切换到真实 LLM，请前往 **设置 → 服务商**：

| 服务商 | 获取 Key |
|---|---|
| DeepSeek | platform.deepseek.com/api_keys |
| Kimi | platform.moonshot.cn/console |
| GLM | open.bigmodel.cn/usercenter |

配置后此卡片会**自动用真实模型**重新生成回复。`,
];

const IMAGE_MOCK_REPLY = `收到图片。

> **Mock 模式不支持视觉理解**，请配置 API Key 后重试。

支持的视觉模型：
- DeepSeek · Chat
- Kimi 全系（Moonshot）
- GLM · 4V Flash / Plus
`;

function hasImage(content: MessageContent): boolean {
  return typeof content !== 'string' && Array.isArray(content)
    && content.some((p) => p.type === 'image_url');
}

function pickReply(prompt: string): string {
  const seed = prompt.length % MOCK_REPLIES.length;
  return MOCK_REPLIES[seed];
}

/**
 * 模拟流式输出
 */
export async function mockStream(
  prompt: MessageContent,
  callbacks: StreamCallbacks,
  signal?: AbortSignal
): Promise<void> {
  // 图片识别 mock
  if (hasImage(prompt)) {
    const text = IMAGE_MOCK_REPLY;
    callbacks.onStart?.();
    for (let i = 0; i < text.length; i++) {
      if (signal?.aborted) throw new Error('UserAbort');
      callbacks.onToken(text[i]);
      await sleep(5, signal);
    }
    callbacks.onDone(text);
    return;
  }

  const promptStr = typeof prompt === 'string' ? prompt : JSON.stringify(prompt);
  const text = pickReply(promptStr);
  let fullText = '';

  // 模拟 0.5-1.5 秒"思考"延迟
  await sleep(500 + Math.random() * 1000, signal);
  callbacks.onStart?.();

  // 逐字输出
  for (let i = 0; i < text.length; i++) {
    if (signal?.aborted) throw new Error('UserAbort');
    fullText += text[i];
    callbacks.onToken(text[i]);
    await sleep(10 + Math.random() * 20, signal);
  }

  callbacks.onDone(fullText);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
    };
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new Error('UserAbort'));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    if (!signal) return;
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
