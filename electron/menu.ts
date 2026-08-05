// electron/menu.ts — 原生菜单定义
import { Menu, MenuItemConstructorOptions, BrowserWindow } from 'electron';
import { IPC_CHANNELS } from './ipc-channels.js';

export function buildMenu(mainWindow: BrowserWindow): Menu {
  const isMac = process.platform === 'darwin';

  const template: MenuItemConstructorOptions[] = [
    // App 菜单（macOS）
    ...(isMac
      ? ([
          {
            label: 'Chat Canvas',
            submenu: [
              { label: '关于 Chat Canvas', role: 'about' },
              { type: 'separator' },
              { label: '隐藏', role: 'hide' },
              { label: '隐藏其他', role: 'hideOthers' },
              { label: '全部显示', role: 'unhide' },
              { type: 'separator' },
              { label: '退出', role: 'quit' },
            ],
          },
        ] as MenuItemConstructorOptions[])
      : []),

    // 文件菜单
    {
      label: '文件',
      submenu: [
        {
          label: '新建卡片',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => mainWindow.webContents.send(IPC_CHANNELS.MENU_NEW_CARD),
        },
        { type: 'separator' },
        {
          label: '导入画布 (JSON)',
          accelerator: 'CmdOrCtrl+O',
          click: () => mainWindow.webContents.send(IPC_CHANNELS.MENU_IMPORT),
        },
        {
          label: '导出画布 (JSON)',
          accelerator: 'CmdOrCtrl+S',
          click: () => mainWindow.webContents.send(IPC_CHANNELS.MENU_EXPORT),
        },
        ...(!isMac ? [{ type: 'separator' as const }, { label: '退出', role: 'quit' as const }] : []),
      ],
    },

    // 编辑菜单
    {
      label: '编辑',
      submenu: [
        { label: '撤销', accelerator: 'CmdOrCtrl+Z', role: 'undo' },
        { label: '重做', accelerator: 'Shift+CmdOrCtrl+Z', role: 'redo' },
        { type: 'separator' },
        { label: '复制', accelerator: 'CmdOrCtrl+C', role: 'copy' },
        { label: '粘贴', accelerator: 'CmdOrCtrl+V', role: 'paste' },
        { label: '删除选中', accelerator: 'Delete', role: 'delete' },
      ],
    },

    // 视图菜单
    {
      label: '视图',
      submenu: [
        {
          label: '放大',
          accelerator: 'CmdOrCtrl+=',
          click: () => mainWindow.webContents.send(IPC_CHANNELS.MENU_ZOOM_IN),
        },
        {
          label: '缩小',
          accelerator: 'CmdOrCtrl+-',
          click: () => mainWindow.webContents.send(IPC_CHANNELS.MENU_ZOOM_OUT),
        },
        {
          label: '重置缩放',
          accelerator: 'CmdOrCtrl+0',
          click: () => mainWindow.webContents.send(IPC_CHANNELS.MENU_ZOOM_RESET),
        },
        { type: 'separator' },
        {
          label: '切换主题',
          accelerator: 'CmdOrCtrl+Shift+T',
          click: () => mainWindow.webContents.send(IPC_CHANNELS.MENU_TOGGLE_THEME),
        },
        { type: 'separator' },
        { label: '全屏', accelerator: 'F11', role: 'togglefullscreen' },
      ],
    },

    // 卡片菜单
    {
      label: '卡片',
      submenu: [
        {
          label: '新建卡片',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => mainWindow.webContents.send(IPC_CHANNELS.MENU_NEW_CARD),
        },
        { type: 'separator' },
        {
          label: '打开设置',
          accelerator: 'CmdOrCtrl+,',
          click: () => mainWindow.webContents.send(IPC_CHANNELS.MENU_OPEN_SETTINGS),
        },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}
