/**
 * src/lib/llm.ts
 * LLM API 调用：fetch + SSE 流式输出。支持 DeepSeek / Moonshot / 智谱 GLM。
 *
 * 修复 D-10：统一 abort 语义（都 throw 'AbortError'，在 ChatNode 层区分用户取消）。
 * 新增：同域名发送间隔节流（最小 500ms）+ 同域名互斥串行队列。
 * 新增：onStart 回调（通知 store 切换 pending → streaming）。
 */
import { ChatMessage } from '@/types';

export interface LLMConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

export interface StreamCallbacks {
  onStart?: () => void;
  onToken: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  onDone: (fullText: string) => void;
  onError: (err: Error) => void;
}

const MAX_RETRIES = 3;
const MIN_INTERVAL = 500; // 同域名最小发送间隔 (ms)

// 同域名最后发送时间（节流）
const lastSend = new Map<string, number>();
// 同域名互斥锁（串行队列）
const locks = new Map<string, Promise<void>>();

/**
 * 发送消息并流式接收回复（带指数退避重试）
 */
export async function streamChat(
  messages: ChatMessage[],
  config: LLMConfig,
  callbacks: StreamCallbacks,
  signal?: AbortSignal
): Promise<void> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      await doStream(messages, config, callbacks, signal);
      return;
    } catch (err) {
      lastError = err as Error;

      // 用户取消不重试
      if (lastError.message === 'UserAbort') throw err;

      // 非 429 错误不重试
      if (!lastError.message.includes('429') && !lastError.message.includes('超时')) {
        throw err;
      }

      if (attempt === MAX_RETRIES - 1) {
        throw lastError;
      }

      const delay = Math.pow(2, attempt) * 1000;
      await sleep(delay, signal);
    }
  }
}

async function doStream(
  messages: ChatMessage[],
  config: LLMConfig,
  callbacks: StreamCallbacks,
  signal?: AbortSignal
): Promise<void> {
  const { baseURL, apiKey, model } = config;

  // 规范化 URL
  let url = baseURL.trim().replace(/\/$/, '');
  // 智谱系域名（bigmodel.cn / api.z.ai）路径已含 /api/paas/v4，直接拼接
  if (url.includes('bigmodel.cn') || url.includes('api.z.ai')) {
    url += '/chat/completions';
  } else {
    // OpenAI 兼容 API：确保以 /v1/chat/completions 结尾
    if (!url.endsWith('/v1')) {
      url += '/v1';
    }
    url += '/chat/completions';
  }

  const origin = new URL(url).origin;

  // === 同域名节流 ===
  const elapsed = Date.now() - (lastSend.get(origin) ?? 0);
  if (elapsed < MIN_INTERVAL) {
    await sleep(MIN_INTERVAL - elapsed, signal);
  }
  lastSend.set(origin, Date.now());

  // === 同域名互斥串行 ===
  const prev = locks.get(origin);
  if (prev) {
    try { await prev; } catch { /* 上一个流失败不影响下一个 */ }
  }
  let resolveLock: () => void;
  locks.set(origin, new Promise<void>((r) => { resolveLock = r; }));

  try {
    // 通知 UI：队列释放，开始 streaming
    callbacks.onStart?.();

    const body = {
      model,
      messages: messages.map(({ role, content }) => ({
        role,
        content,
      })),
      stream: true,
      temperature: 0.7,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);
    const combinedSignal = signal
      ? mergeSignals(signal, controller.signal)
      : controller.signal;

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: combinedSignal,
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        if (resp.status === 401) {
          throw new Error('API Key 无效或已过期，请检查设置');
        } else if (resp.status === 429) {
          throw new Error('请求过于频繁 (429)，正在重试...');
        } else if (resp.status === 404) {
          throw new Error(`模型 ${model} 不存在，请检查模型名称`);
        } else {
          throw new Error(`API 错误 ${resp.status}: ${errText.slice(0, 200)}`);
        }
      }

      if (!resp.body) {
        throw new Error('响应没有 body（不支持流式）');
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;

          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') {
            callbacks.onDone(fullText);
            return;
          }

          try {
            const json = JSON.parse(data);
            const choice = json.choices?.[0];
            const delta = choice?.delta?.content ?? '';
            if (delta) {
              fullText += delta;
              callbacks.onToken(delta);
            }
            const reasoning = choice?.delta?.reasoning_content ?? '';
            if (reasoning && callbacks.onReasoning) {
              callbacks.onReasoning(reasoning);
            }
          } catch {
            // 忽略非 JSON 行
          }
        }
      }

      callbacks.onDone(fullText);
    } finally {
      clearTimeout(timeout);
    }
  } finally {
    resolveLock!();
    locks.delete(origin);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error('UserAbort'));
      };
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new Error('UserAbort'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function mergeSignals(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      controller.abort();
      break;
    }
    s.addEventListener('abort', () => controller.abort());
  }
  return controller.signal;
}
