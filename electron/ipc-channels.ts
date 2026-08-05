// electron/ipc-channels.ts — IPC 通道名集中管理
export const IPC_CHANNELS = {
  // 安全存储
  SECURE_GET: 'secure-get',
  SECURE_SET: 'secure-set',

  // 应用信息
  GET_VERSION: 'get-version',

  // 文件存储（《消息服务协议 v1》Electron 实现）
  STORE_READ: 'store:read',
  STORE_WRITE: 'store:write',
  STORE_DELETE: 'store:delete',
  STORE_LIST: 'store:list',

  // 菜单事件
  MENU_NEW_CARD: 'menu-new-card',
  MENU_OPEN_SETTINGS: 'menu-open-settings',
  MENU_ZOOM_IN: 'menu-zoom-in',
  MENU_ZOOM_OUT: 'menu-zoom-out',
  MENU_ZOOM_RESET: 'menu-zoom-reset',
  MENU_IMPORT: 'menu-import',
  MENU_EXPORT: 'menu-export',
  MENU_TOGGLE_THEME: 'menu-toggle-theme',
} as const;
