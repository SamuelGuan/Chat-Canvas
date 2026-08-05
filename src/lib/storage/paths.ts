/**
 * src/lib/storage/paths.ts
 * 数据目录内三级文件的路径约定（纯函数，Node / 渲染层均可引用）。
 * id 即路径：project id = 文件夹名，session id = 文件名（nanoid 天然路径安全）；
 * 改名只改 JSON 内 name 字段，不动路径。
 */

/** MBR：根索引文件（相对数据目录根） */
export const INDEX_FILE = 'index.json';

/** 项目文件夹 */
export const projectDir = (pid: string): string => `projects/${pid}`;

/** PBR：项目注册表文件 */
export const projectFilePath = (pid: string): string => `projects/${pid}/project.json`;

/** 分区数据区：Session 文件 */
export const sessionFilePath = (pid: string, sid: string): string => `projects/${pid}/sessions/${sid}.json`;

/** 二进制资源目录（后续 PDF/图片；JSON 内仅存相对路径引用） */
export const projectAssetsDir = (pid: string): string => `projects/${pid}/assets`;
