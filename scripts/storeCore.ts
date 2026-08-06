/**
 * scripts/storeCore.ts
 * 《消息服务协议 v1》服务端共享 fs 实现（Node 侧：Vite 中间件 / Electron 主进程 / 校验 CLI 共用）。
 * 边界约束：仅 Node 侧模块可接触 fs；所有路径一律经 resolveInside 防目录穿越。
 * 渲染层禁止 import 本模块（经 StorageAdapter 间接访问）。
 */
import { existsSync, mkdirSync } from 'fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'fs/promises';
import { dirname, join, resolve, sep } from 'path';
import { execFile } from 'child_process';
import { DATA_DIR_NAME, StoreError } from '../src/lib/storage/protocol';

/** 解析数据目录绝对路径（cwd 即项目根） */
export function resolveDataRoot(cwd: string): string {
  return resolve(cwd, DATA_DIR_NAME);
}

/**
 * 将相对路径解析为数据目录内的绝对路径，越界（目录穿越）即抛错
 *
 * :param dataRoot: 数据目录绝对路径
 * :param rel: 相对数据目录的路径
 * :return: 数据目录内的绝对路径
 */
export function resolveInside(dataRoot: string, rel: string): string {
  if (!rel || rel.includes('\0')) throw new StoreError('路径为空或含非法字符', 'EINVAL');
  const abs = resolve(dataRoot, rel);
  if (abs !== dataRoot && !abs.startsWith(dataRoot + sep)) {
    throw new StoreError('路径越出数据目录', 'EINVAL');
  }
  return abs;
}

/** 读 / 写仅允许 .json 后缀（DELETE 允许目录，不做此校验） */
function assertJsonFile(rel: string): void {
  if (!rel.endsWith('.json')) throw new StoreError(`仅允许 .json 文件: ${rel}`, 'EINVAL');
}

/* 同一路径写操作串行化（单进程单窗口基本无并发，此为兜底防写坏文件） */
const writeQueues = new Map<string, Promise<unknown>>();

function enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeQueues.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  writeQueues.set(key, next);
  return next;
}

/* 本进程自身写入记录：文件监听据此过滤自写事件，避免收敛循环（外部进程写入无记录，正常触发） */
const selfWrites = new Map<string, number>();
const SELF_WRITE_WINDOW_MS = 2000;

function markSelfWrite(abs: string): void {
  selfWrites.set(abs, Date.now());
  // 防泄漏：只留窗口期内的记录
  if (selfWrites.size > 500) {
    const cutoff = Date.now() - SELF_WRITE_WINDOW_MS;
    for (const [p, t] of selfWrites) {
      if (t < cutoff) selfWrites.delete(p);
    }
  }
}

/**
 * 判断给定绝对路径的变更是否本进程自写（含目录前缀匹配，目录删除会带出子项事件）
 *
 * :param absPath: 变更文件绝对路径
 * :param withinMs: 自写有效窗口（默认 2000ms）
 */
export function isSelfWrite(absPath: string, withinMs = SELF_WRITE_WINDOW_MS): boolean {
  const now = Date.now();
  for (const [p, t] of selfWrites) {
    if (now - t > withinMs) {
      selfWrites.delete(p);
      continue;
    }
    if (absPath === p || absPath.startsWith(p + sep)) return true;
  }
  return false;
}

let gitInitTried = false;

/**
 * 确保数据目录存在；并按 Q1 决策在目录内建立独立 git 仓库
 * （项目仓库 gitignore 数据目录防误提交聊天隐私，目录内 git 给 agent / 手动改文件留版本时间机）。
 * git 不可用时静默跳过。
 */
export function ensureDataRoot(dataRoot: string): void {
  if (!existsSync(dataRoot)) mkdirSync(dataRoot, { recursive: true });
  if (!gitInitTried && !existsSync(join(dataRoot, '.git'))) {
    gitInitTried = true;
    execFile('git', ['init'], { cwd: dataRoot }, () => { /* best-effort，失败忽略 */ });
  }
}

/** 读 JSON 文件；不存在（或目标是目录）返回 null，JSON 损坏抛 EPARSE（容错 UTF-8 BOM） */
export async function readJsonFile(dataRoot: string, rel: string): Promise<unknown | null> {
  assertJsonFile(rel);
  const abs = resolveInside(dataRoot, rel);
  try {
    return JSON.parse((await readFile(abs, 'utf-8')).replace(/^﻿/, ''));
  } catch (e: any) {
    if (e?.code === 'ENOENT' || e?.code === 'EISDIR') return null;
    if (e instanceof SyntaxError) throw new StoreError(`JSON 解析失败: ${rel}`, 'EPARSE');
    throw e;
  }
}

/** 原子写 JSON（同路径串行 + tmp 后 rename，任何时刻磁盘上不存在半截文件） */
export async function writeJsonFile(dataRoot: string, rel: string, data: unknown): Promise<void> {
  assertJsonFile(rel);
  const abs = resolveInside(dataRoot, rel);
  return enqueue(abs, async () => {
    await mkdir(dirname(abs), { recursive: true });
    const tmp = `${abs}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
    markSelfWrite(abs);
    await rename(tmp, abs);
  });
}

/** 递归删除文件或目录；不存在视为成功（幂等） */
export async function deletePath(dataRoot: string, rel: string): Promise<void> {
  const abs = resolveInside(dataRoot, rel);
  if (abs === dataRoot) throw new StoreError('禁止删除数据目录根', 'EINVAL');
  return enqueue(abs, async () => {
    markSelfWrite(abs);
    await rm(abs, { recursive: true, force: true });
  });
}

/** 列目录直接子项名；目录不存在返回 []（rel 为空串时列数据目录根） */
export async function listDir(dataRoot: string, rel: string): Promise<string[]> {
  const abs = rel ? resolveInside(dataRoot, rel) : dataRoot;
  try {
    return await readdir(abs);
  } catch (e: any) {
    if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') return [];
    throw e;
  }
}
