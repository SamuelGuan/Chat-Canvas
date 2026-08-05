import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import type { IncomingMessage, ServerResponse } from 'http';
import { PROTOCOL_VERSION, STORE_API_BASE, StoreError } from './src/lib/storage/protocol';
import { deletePath, ensureDataRoot, listDir, readJsonFile, resolveDataRoot, writeJsonFile } from './scripts/storeCore';

/**
 * 《消息服务协议 v1》Vite dev server 中间件 —— 协议的首个实现（docs/store-protocol.md）。
 * 浏览器页面处于沙箱无法直接读写本地文件，由 dev server 用 Node fs 代劳，
 * 页面侧只发同源相对路径请求；未来 Python FastAPI 照同一契约实现，前端零改动直连。
 * 中间件只存在于 dev server，vite build 产物不含 —— 静态部署自动降级 LocalStorageAdapter。
 */
function storeApiPlugin(): Plugin {
  return {
    name: 'chat-canvas-store-api',
    configureServer(server) {
      const dataRoot = resolveDataRoot(process.cwd());
      server.middlewares.use(STORE_API_BASE, (req, res) => {
        handleStoreRequest(dataRoot, req, res).catch((e) => sendError(res, e));
      });
    },
  };
}

/** 协议路由分发（挂载点为 /api/store，req.url 为其下子路径） */
async function handleStoreRequest(dataRoot: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  ensureDataRoot(dataRoot);
  const url = new URL(req.url ?? '/', 'http://localhost');
  const rel = url.searchParams.get('p') ?? '';
  const method = req.method ?? 'GET';

  // 能力描述（adapter 运行时选择依据）
  if (url.pathname === '/health' && method === 'GET') {
    return sendJson(res, 200, {
      kind: 'dev-server',
      version: PROTOCOL_VERSION,
      capabilities: ['readJson', 'writeJson', 'delete', 'list'],
    });
  }
  // SSE 服务端推送：协议预留占位，本期不实现
  if (url.pathname === '/events' && method === 'GET') {
    return sendJson(res, 501, { error: 'events 推送通道为协议预留，当前版本未实现', code: 'NOT_IMPLEMENTED' });
  }
  if (url.pathname === '/file' && method === 'GET') {
    const data = await readJsonFile(dataRoot, rel);
    if (data === null) return sendJson(res, 404, { error: `文件不存在: ${rel}`, code: 'ENOENT' });
    return sendJson(res, 200, data);
  }
  if (url.pathname === '/file' && method === 'PUT') {
    const body = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return sendJson(res, 400, { error: '请求体不是合法 JSON', code: 'EPARSE' });
    }
    await writeJsonFile(dataRoot, rel, parsed);
    return sendJson(res, 200, { ok: true });
  }
  // DELETE 允许文件或目录（递归）
  if (url.pathname === '/file' && method === 'DELETE') {
    await deletePath(dataRoot, rel);
    return sendJson(res, 200, { ok: true });
  }
  if (url.pathname === '/list' && method === 'GET') {
    return sendJson(res, 200, await listDir(dataRoot, rel));
  }
  return sendJson(res, 404, { error: `未知路由: ${method} ${url.pathname}`, code: 'ENOTFOUND' });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

/** 统一错误出口：{ error, code } 格式；StoreError 的 EINVAL 映射 400，其余 500 */
function sendError(res: ServerResponse, e: unknown): void {
  if (e instanceof StoreError) {
    return sendJson(res, e.code === 'EINVAL' ? 400 : 500, { error: e.message, code: e.code });
  }
  const message = e instanceof Error ? e.message : String(e);
  sendJson(res, 500, { error: message, code: 'EINTERNAL' });
}

export default defineConfig({
  plugins: [react(), storeApiPlugin()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 3000,
    open: true,
  },
});
