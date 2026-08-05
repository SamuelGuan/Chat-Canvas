/**
 * src/lib/storage/probe.ts
 * store 服务能力探测（health 端点），adapter 运行时选择的依据。
 */
import { STORE_API_BASE, type StoreHealth } from './protocol';

/** 探测超时时间（ms）：本机服务应即时响应，超时按不存在处理 */
const PROBE_TIMEOUT_MS = 1500;

/**
 * 探测 store 服务能力描述
 *
 * 依次校验 HTTP 状态 / content-type / 返回体 version 字段，
 * vite preview 等 SPA fallback 返回的 index.html 会在 content-type 校验处被排除。
 *
 * :param baseUrl: store API 根（默认同源 /api/store；远端服务传完整 URL）
 * :return: 能力描述；服务不存在或超时返回 null
 */
export async function probeCaps(baseUrl = STORE_API_BASE): Promise<StoreHealth | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/health`, { signal: controller.signal });
    if (!res.ok) return null;
    if (!(res.headers.get('content-type') ?? '').includes('application/json')) return null;
    const data: any = await res.json();
    if (!data || typeof data.version !== 'number') return null;
    return data as StoreHealth;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
