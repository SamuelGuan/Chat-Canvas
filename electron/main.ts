// electron/main.ts — Electron 主进程入口
import { app, BrowserWindow, ipcMain, safeStorage, Menu } from 'electron';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { buildMenu } from './menu.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
let mainWindow: BrowserWindow | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
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
