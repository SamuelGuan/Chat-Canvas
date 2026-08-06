/**
 * src/lib/storage/devServer.ts
 * DevServerAdapter：经 HTTP 访问《消息服务协议 v1》服务端。
 * 本质是通用 HTTP 适配器：baseUrl 指向同源 /api/store 即 dev-server，
 * 指向未来 Python 服务（FastAPI 等同契约实现）即 http-remote，复用同一实现，无需新类。
 */
import { StoreError, STORE_API_BASE, type StorageAdapter } from './protocol';

export class DevServerAdapter implements StorageAdapter {
  readonly kind: 'dev-server' | 'http-remote';
  private readonly baseUrl: string;

  constructor(baseUrl = STORE_API_BASE) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.kind = /^https?:\/\//.test(this.baseUrl) ? 'http-remote' : 'dev-server';
  }

  /** 服务根地址（SSE 等附属端点拼接用） */
  getBaseUrl(): string {
    return this.baseUrl;
  }

  async readJson(relPath: string): Promise<unknown | null> {
    return this.request('GET', `/file?p=${encodeURIComponent(relPath)}`);
  }

  async writeJson(relPath: string, data: unknown): Promise<void> {
    await this.request('PUT', `/file?p=${encodeURIComponent(relPath)}`, data);
  }

  async delete(relPath: string): Promise<void> {
    await this.request('DELETE', `/file?p=${encodeURIComponent(relPath)}`);
  }

  async list(dirRelPath: string): Promise<string[]> {
    const res = await this.request('GET', `/list?p=${encodeURIComponent(dirRelPath)}`);
    return Array.isArray(res) ? (res as string[]) : [];
  }

  /**
   * 统一请求入口：404 → null（readJson 语义）；其余非 2xx 解析 { error, code } 后翻译为 throw
   *
   * :param method: HTTP 方法
   * :param path: 已拼接查询串的协议路径
   * :param body: 可选 JSON 请求体
   * :return: 响应 JSON（404 时为 null）
   */
  private async request(method: string, path: string, body?: unknown): Promise<unknown | null> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const payload: any = await res.json().catch(() => null);
      throw new StoreError(
        payload?.error ?? `store 请求失败 (HTTP ${res.status})`,
        payload?.code ?? `HTTP_${res.status}`,
      );
    }
    return res.json();
  }
}
