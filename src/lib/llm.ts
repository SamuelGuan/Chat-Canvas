/**
 * src/lib/llm.ts
 * LLM API 调用：fetch + SSE 流式输出。支持 OpenAI 兼容接口与 Anthropic Claude。
 *
 * 修复 D-10：统一 abort 语义（都 throw 'AbortError'，在 ChatNode 层区分用户取消）。
 * 新增：同域名发送间隔节流（最小 500ms）+ 同域名互斥串行队列。
 * 新增：onStart 回调（通知 store 切换 pending → streaming）。
 * 新增：思考强度参数路由层（按 OpenAI / Claude / DeepSeek / Kimi / GLM 自动映射）。
 */
import { ChatMessage, MessageContent, ContentPart, ReasoningEffort } from '@/types';
import { routeReasoningConfig } from './llmReasoning';

export interface LLMConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
}

export interface StreamCallbacks {
  onStart?: () => void;
  onToken: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  onDone: (fullText: string) => void;
  onError: (err: Error) => void;
}

export type ProviderApiKind = 'openai-compatible' | 'anthropic';

const MAX_RETRIES = 3;
const MIN_INTERVAL = 500; // 同域名最小发送间隔 (ms)

// 同域名最后发送时间（节流）
const lastSend = new Map<string, number>();
// 同域名互斥锁（串行队列）
const locks = new Map<string, Promise<void>>();

export function getProviderApiKind(baseURL: string): ProviderApiKind {
  return /anthropic\.com/i.test(baseURL) ? 'anthropic' : 'openai-compatible';
}

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
  const { baseURL, model } = config;
  const url = buildChatUrl(config);
  const apiKind = getProviderApiKind(baseURL);

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

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);
    const combinedSignal = signal
      ? mergeSignals(signal, controller.signal)
      : controller.signal;

    try {
      const request = buildRequest(messages, config);
      const resp = await fetch(url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
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

      if (apiKind === 'anthropic') {
        await readAnthropicStream(resp.body, callbacks);
      } else {
        await readOpenAICompatibleStream(resp.body, callbacks);
      }
    } finally {
      clearTimeout(timeout);
    }
  } finally {
    resolveLock!();
    locks.delete(origin);
  }
}

function buildChatUrl(config: LLMConfig): string {
  let url = config.baseURL.trim().replace(/\/$/, '');
  if (getProviderApiKind(url) === 'anthropic') {
    if (!url.endsWith('/v1')) {
      url += '/v1';
    }
    return `${url}/messages`;
  }
  // 智谱系域名（bigmodel.cn / api.z.ai）路径已含 /api/paas/v4，直接拼接
  if (url.includes('bigmodel.cn') || url.includes('api.z.ai')) {
    return `${url}/chat/completions`;
  }
  if (!url.endsWith('/v1')) {
    url += '/v1';
  }
  return `${url}/chat/completions`;
}

function buildRequest(messages: ChatMessage[], config: LLMConfig): {
  headers: Record<string, string>;
  body: Record<string, unknown>;
} {
  const reasoningRoute = routeReasoningConfig(config);

  if (getProviderApiKind(config.baseURL) === 'anthropic') {
    const anthropicMessages = toAnthropicMessages(messages);
    return {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: {
        model: config.model,
        messages: anthropicMessages.messages,
        system: anthropicMessages.system || undefined,
        stream: true,
        max_tokens: 4096,
        temperature: 0.7,
        ...reasoningRoute.bodyPatch,
      },
    };
  }

  return {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: {
      model: config.model,
      messages: messages.map(({ role, content }) => ({
        role,
        content,
      })),
      stream: true,
      temperature: reasoningRoute.omitTemperature ? undefined : 0.7,
      ...reasoningRoute.bodyPatch,
    },
  };
}

async function readOpenAICompatibleStream(
  body: ReadableStream<Uint8Array>,
  callbacks: StreamCallbacks
): Promise<void> {
  const reader = body.getReader();
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
}

async function readAnthropicStream(
  body: ReadableStream<Uint8Array>,
  callbacks: StreamCallbacks
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? '';

    for (const chunk of chunks) {
      const dataLine = chunk.split('\n').find((line) => line.startsWith('data:'));
      if (!dataLine) continue;
      const data = dataLine.slice(5).trim();
      if (!data || data === '[DONE]') continue;

      try {
        const json = JSON.parse(data);
        if (json.type === 'content_block_delta') {
          const delta = json.delta?.text ?? '';
          if (delta) {
            fullText += delta;
            callbacks.onToken(delta);
          }
        }
      } catch {
        // 忽略非 JSON 行
      }
    }
  }

  callbacks.onDone(fullText);
}

function toAnthropicMessages(messages: ChatMessage[]): {
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: Array<Record<string, unknown>> }>;
} {
  const systemParts: string[] = [];
  const converted: Array<{ role: 'user' | 'assistant'; content: Array<Record<string, unknown>> }> = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      const text = extractTextContent(msg.content);
      if (text) systemParts.push(text);
      continue;
    }

    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    const content = toAnthropicContent(msg.content);
    if (content.length === 0) continue;

    const prev = converted[converted.length - 1];
    if (prev && prev.role === role) {
      prev.content.push(...content);
    } else {
      converted.push({ role, content });
    }
  }

  return {
    system: systemParts.join('\n\n'),
    messages: converted,
  };
}

function toAnthropicContent(content: MessageContent): Array<Record<string, unknown>> {
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : [];
  }

  const blocks: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if (part.type === 'text') {
      if (part.text) blocks.push({ type: 'text', text: part.text });
      continue;
    }
    const imageBlock = toAnthropicImageBlock(part);
    if (imageBlock) blocks.push(imageBlock);
  }
  return blocks;
}

function toAnthropicImageBlock(part: ContentPart): Record<string, unknown> | null {
  if (part.type !== 'image_url') return null;
  const url = part.image_url?.url ?? '';
  const matched = url.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (matched) {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: matched[1],
        data: matched[2],
      },
    };
  }

  return {
    type: 'text',
    text: `[图片 URL] ${url}`,
  };
}

function extractTextContent(content: MessageContent): string {
  if (typeof content === 'string') return content;
  return content
    .map((part) => {
      if (part.type === 'text') return part.text;
      return '[图片]';
    })
    .filter(Boolean)
    .join('\n');
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
