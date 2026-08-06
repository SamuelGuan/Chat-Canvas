// electron/main.ts — Electron 主进程入口
import { app, BrowserWindow, ipcMain, safeStorage, Menu } from 'electron';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { buildMenu } from './menu.js';
import { IPC_CHANNELS } from './ipc-channels.js';
import { deletePath, ensureDataRoot, listDir, readJsonFile, resolveDataRoot, writeJsonFile } from '../scripts/storeCore.js';
import { startStoreWatcher } from '../scripts/storeWatcher.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
let mainWindow: BrowserWindow | null = null;

// 数据目录：dev 模式 process.cwd() 即项目根；打包后安装目录只读，落到 userData（Q2，打包路径打包时再验证）
const dataRoot = app.isPackaged
  ? join(app.getPath('userData'), 'chat-canvas-data')
  : resolveDataRoot(process.cwd());

// IPC: 文件存储（《消息服务协议 v1》Electron 实现，语义与 Vite 中间件一致，见 docs/store-protocol.md）
ipcMain.handle(IPC_CHANNELS.STORE_READ, (_e, relPath: string) => {
  ensureDataRoot(dataRoot);
  return readJsonFile(dataRoot, relPath);
});

ipcMain.handle(IPC_CHANNELS.STORE_WRITE, (_e, relPath: string, data: unknown) => {
  ensureDataRoot(dataRoot);
  return writeJsonFile(dataRoot, relPath, data);
});

ipcMain.handle(IPC_CHANNELS.STORE_DELETE, (_e, relPath: string) => {
  ensureDataRoot(dataRoot);
  return deletePath(dataRoot, relPath);
});

ipcMain.handle(IPC_CHANNELS.STORE_LIST, (_e, dirRelPath: string) => {
  ensureDataRoot(dataRoot);
  return listDir(dataRoot, dirRelPath);
});

// 数据目录文件监听：外部进程改文件 → 一致性校验收敛 → 推送渲染层联动（自写事件在 watcher 内过滤）
app.whenReady().then(() => {
  ensureDataRoot(dataRoot);
  startStoreWatcher(dataRoot, (paths) => {
    mainWindow?.webContents.send(IPC_CHANNELS.STORE_CHANGED, paths);
  });
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      // electron-vite 输出为 out/preload/preload.mjs；ESM preload 要求 sandbox: false（contextIsolation 保持开启）
      preload: join(__dirname, '../preload/preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    title: 'Chat Canvas',
  });

  // 开发模式加载 Vite 开发服务器，生产模式加载构建产物
  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    mainWindow.loadFile(join(__dirname, '../../dist/index.html'));
  }

  // 构建并设置菜单
  Menu.setApplicationMenu(buildMenu(mainWindow));
}

// IPC: 安全存储
ipcMain.handle('secure-get', async (_e, key: string) => {
  const encrypted = await readSecureData(key);
  if (!encrypted) return null;
  try {
    const decrypted = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    return decrypted;
  } catch {
    return null;
  }
});

ipcMain.handle('secure-set', async (_e, key: string, value: string) => {
  const encrypted = safeStorage.encryptString(value);
  await writeSecureData(key, encrypted.toString('base64'));
});

ipcMain.handle('get-version', () => app.getVersion());

// 安全存储的持久化（写入用户数据目录的 JSON 文件）
import { app as electronApp } from 'electron';
import { readFile, writeFile } from 'fs/promises';

const storePath = join(electronApp.getPath('userData'), 'secure-store.json');

async function readSecureData(key: string): Promise<string | null> {
  try {
    const data = JSON.parse(await readFile(storePath, 'utf-8'));
    return data[key] ?? null;
  } catch {
    return null;
  }
}

async function writeSecureData(key: string, value: string) {
  let data: Record<string, string> = {};
  try {
    data = JSON.parse(await readFile(storePath, 'utf-8'));
  } catch {}
  data[key] = value;
  await writeFile(storePath, JSON.stringify(data), 'utf-8');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
