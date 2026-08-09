/**
 * src/components/MemoMarkdown.tsx
 * 按内容 memo 的 Markdown 渲染器（GFM 表格 / 代码高亮 / MathJax 数学公式）。
 * - MemoMarkdown: content 不变时跳过重渲染，避免流式刷新、卡片 resize、选中态变化时重复排版。
 * - MemoMarkdownBlocks: 块级增量渲染——按空行切分顶层块（代码围栏/$$ 数学块内的空行不切），
 *   内容变化只重渲染受影响的块；块包装带 content-visibility:auto，离屏块跳过布局与绘制。
 */
import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Options as MarkdownOptions } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkSupersub from 'remark-supersub';
import rehypeMathjax from 'rehype-mathjax/svg';
import rehypeHighlight from 'rehype-highlight';
import { mathjaxTexOptions, normalizeMathDelimiters } from '@/lib/utils';
import 'highlight.js/styles/github-dark.css';

// 插件数组为模块常量：每次渲染新建数组会使 memo 的 props 比较失效
const REMARK_PLUGINS: MarkdownOptions['remarkPlugins'] = [remarkMath, remarkGfm, remarkSupersub];
const REHYPE_PLUGINS: MarkdownOptions['rehypePlugins'] = [[rehypeMathjax, mathjaxTexOptions], rehypeHighlight];

/**
 * 按内容 memo 的 Markdown 渲染（内部统一做数学定界符归一化）
 *
 * :param content: 原始 Markdown 文本
 */
export const MemoMarkdown = memo(function MemoMarkdown({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>
      {normalizeMathDelimiters(content)}
    </ReactMarkdown>
  );
});

/**
 * 将已归一化的 Markdown 文本切分为顶层块
 *
 * 空行为块边界；代码围栏（```）与展示数学块（$$...$$）内的空行不切分，
 * 保证代码块与多行公式不会被拦腰截断
 *
 * :param src: 已经过 normalizeMathDelimiters 归一化的 Markdown 文本
 * :return: 顶层块数组（每块为独立可渲染的 Markdown 片段）
 */
function splitMarkdownBlocks(src: string): string[] {
  const lines = src.split('\n');
  const blocks: string[] = [];
  let cur: string[] = [];
  let inFence = false;
  let inMath = false;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('```')) {
      inFence = !inFence;
    } else if (!inFence) {
      // 本行 $$ 出现奇数次 = 进入/离开展示数学块；偶数次（$$x$$ 单行）不切换
      const matches = t.match(/\$\$/g);
      if (matches && matches.length % 2 === 1) inMath = !inMath;
    }
    if (!inFence && !inMath && t === '') {
      if (cur.length > 0) {
        blocks.push(cur.join('\n'));
        cur = [];
      }
      continue;
    }
    cur.push(line);
  }
  if (cur.length > 0) blocks.push(cur.join('\n'));
  return blocks;
}

/**
 * 块级增量 Markdown 渲染：内容变化时只有文本发生变化的块重渲染，
 * 其余块（含其中的 MathJax 公式）完全跳过。块级 key 用下标：
 * 流式追加只影响尾部块，编辑中段只影响邻近块
 *
 * :param content: 原始 Markdown 文本
 */
export const MemoMarkdownBlocks = memo(function MemoMarkdownBlocks({ content }: { content: string }) {
  const blocks = splitMarkdownBlocks(normalizeMathDelimiters(content));
  return (
    <>
      {blocks.map((block, idx) => (
        <div key={idx} className="md-block">
          {/* 块内文本已归一化；MemoMarkdown 内部重复归一化为幂等操作 */}
          <MemoMarkdown content={block} />
        </div>
      ))}
    </>
  );
});
