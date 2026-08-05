/**
 * src/lib/utils.ts
 * 通用工具函数：cn / 防抖 / 格式化等。
 */
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { SessionData } from '@/types';

/** 合并 Tailwind 类名 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** 深拷贝 Session（JSON 序列化语义，丢失 undefined 字段） */
export function cloneSession(src: SessionData): SessionData {
  return JSON.parse(JSON.stringify(src));
}

/**
 * 防抖（附带 cancel：卸载/删除场景丢弃未触发的写入）
 *
 * :param fn: 被防抖函数
 * :param delay: 延迟毫秒数
 * :return: 防抖包装函数，含 cancel() 方法
 */
export function debounce<T extends (...args: any[]) => void>(fn: T, delay = 300) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const wrapped = (...args: Parameters<T>) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return wrapped;
}

/** 格式化时间 */
export function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

/** 截断文本 */
export function truncate(text: string, max = 50): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

/**
 * 归一化数学公式定界符：将 LLM 常用的 \(...\) 与 \[...\] 转为 remark-math 支持的 $...$ 与 $$...$$
 *
 * 按 fenced/inline 代码块切分文本，仅转换普通文本片段，代码片段原样保留，
 * 避免误伤代码中的字面 \( \[ 序列。
 *
 * :param text: 原始 markdown 文本
 * :return: 定界符归一化后的 markdown 文本
 */
export function normalizeMathDelimiters(text: string): string {
  return text
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g)
    .map((segment, idx) => {
      // 奇数下标为代码片段，原样保留
      if (idx % 2 === 1) return segment;
      return segment
        .replace(/\\\[([\s\S]*?)\\\]/g, (_m, inner: string) => `$$${inner}$$`)
        .replace(/\\\(([\s\S]*?)\\\)/g, (_m, inner: string) => `$${inner}$`);
    })
    .join('');
}

/**
 * 计算字符串的 SHA-256（256 位）十六进制摘要
 *
 * :param text: 待哈希文本
 * :return: 64 位十六进制字符串
 */
export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 递归排序对象键后序列化，保证内容相同的对象生成稳定字符串（不受键插入顺序影响）
 *
 * :param value: 任意可序列化值
 * :return: 键序归一化后的 JSON 字符串
 */
function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalStringify(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * 计算 Session 内容哈希（SHA-256），用于导入时与现有 Session 去重。
 * 仅取用户内容字段（名称/卡片/连线），忽略 id、创建/更新时间、视口等元信息。
 *
 * :param session: 待计算的 SessionData
 * :return: 64 位十六进制哈希字符串
 */
export async function sessionContentHash(session: SessionData): Promise<string> {
  return sha256Hex(canonicalStringify({ name: session.name, nodes: session.nodes, edges: session.edges }));
}
