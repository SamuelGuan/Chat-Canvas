import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import type { IncomingMessage, ServerResponse } from 'http';
import { PROTOCOL_VERSION, STORE_API_BASE, StoreError } from './src/lib/storage/protocol';
import { deletePath, ensureDataRoot, existsPath, listDir, readBinaryFile, readJsonFile, resolveDataRoot, writeBinaryFile, writeJsonFile } from './scripts/storeCore';
import { startStoreWatcher } from './scripts/storeWatcher';

/**
 * 《消息服务协议 v1》Vite dev server 中间件 —— 协议的首个实现（docs/store-protocol.md）。
 * 浏览器页面处于沙箱无法直接读写本地文件，由 dev server 用 Node fs 代劳，
 * 页面侧只发同源相对路径请求；未来 Python FastAPI 照同一契约实现，前端零改动直连。
 * 中间件只存在于 dev server，vite build 产物不含 —— 静态部署无文件存储后端（不支持 localStorage 兜底）。
 * 附带数据目录文件监听：外部进程改文件 → 一致性校验收敛 → SSE 推送渲染层联动。
 */

/** SSE 客户端集合（GET /events 长连接） */
const sseClients = new Set<ServerResponse>();

/** 向全部 SSE 客户端广播 store-changed 事件 */
function broadcastStoreChanged(paths: string[]): void {
  const payload = `data: ${JSON.stringify({ type: 'store-changed', paths })}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

function storeApiPlugin(): Plugin {
  // 每次 configureServer（含 r 快捷键重启）生成新的清理闭包；buildEnd 由 server.close() 触发
  let shutdown: (() => void) | null = null;
  return {
    name: 'chat-canvas-store-api',
    configureServer(server) {
      const dataRoot = resolveDataRoot(process.cwd());
      ensureDataRoot(dataRoot);
      // 文件监听：外部变更 → 收敛 → 推送（自写事件在 watcher 内过滤）
      const watcher = startStoreWatcher(dataRoot, broadcastStoreChanged);

      /* 退出清理（幂等）：关闭 chokidar 句柄 + 销毁全部 SSE 长连接。
       * 不做的后果：q+enter 退出时 httpServer.close() 会永远等 /events 长连接结束，
       * server.close() 不返回 → 进程挂死、3000 端口残留；chokidar 句柄也挂在事件循环上。 */
      let cleaned = false;
      const cleanup = (): void => {
        if (cleaned) return;
        cleaned = true;
        process.off('SIGINT', onSigint);
        for (const res of sseClients) {
          try { res.end(); } catch { /* 客户端已断开 */ }
          res.socket?.destroy();
        }
        sseClients.clear();
        void watcher.close();
      };
      // Ctrl+C：npm/PowerShell 链路下默认强杀常残留子进程，这里兜底清理后自行退出
      const onSigint = (): void => {
        cleanup();
        process.exit(0);
      };
      process.once('SIGINT', onSigint);
      server.httpServer?.once('close', cleanup);
      shutdown = cleanup;

      server.middlewares.use(STORE_API_BASE, (req, res) => {
        handleStoreRequest(dataRoot, req, res).catch((e) => sendError(res, e));
      });
    },
    // server.close() 会执行插件 buildEnd（与 closeHttpServer 并行），在此结束 SSE 使 http 关闭得以完成
    buildEnd() {
      shutdown?.();
      shutdown = null;
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
      capabilities: ['readJson', 'writeJson', 'delete', 'list', 'readBinary', 'writeBinary', 'exists', 'events'],
    });
  }
  // SSE 服务端推送：外部变更通知（文件监听触发）
  if (url.pathname === '/events' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return; // 长连接不 end
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
  // v0.5: 二进制文件读写
  if (url.pathname === '/binary' && method === 'PUT') {
    const buffer = await readRawBody(req);
    await writeBinaryFile(dataRoot, rel, buffer);
    return sendJson(res, 200, { ok: true });
  }
  if (url.pathname === '/binary' && method === 'GET') {
    const data = await readBinaryFile(dataRoot, rel);
    if (data === null) return sendJson(res, 404, { error: `文件不存在: ${rel}`, code: 'ENOENT' });
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(Buffer.from(data));
    return;
  }
  // v0.5: 文件存在性检查
  if (url.pathname === '/exists' && method === 'GET') {
    return sendJson(res, 200, { exists: existsPath(dataRoot, rel) });
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

/** 读取原始请求体（二进制） */
function readRawBody(req: IncomingMessage): Promise<ArrayBuffer> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      resolvePromise(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    });
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
  define: {
    // mathjax-full components/version.js 在 PACKAGE_VERSION 未定义时会 eval('require')，
    // 浏览器环境直接抛 ReferenceError 导致白屏，此处注入版本常量规避
    PACKAGE_VERSION: JSON.stringify('3.2.1'),
  },
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
