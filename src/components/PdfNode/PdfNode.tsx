/**
 * src/components/PdfNode/PdfNode.tsx
 * PDF 阅读卡片：拖入/上传 PDF → assets/ 存储 → iframe 渲染。
 * v0.5: 浏览器原生 PDF 查看器，支持分页浏览。
 */
import { useState, useRef, useCallback, useEffect, memo } from 'react';
import { Handle, Position, NodeProps, NodeResizer } from '@xyflow/react';
import { useCanvasStore } from '@/store/useCanvasStore';
import { getStorageAdapter } from '@/lib/storage/adapter';
import { GraphNode } from '@/types';
import { formatTime, shallowSkipPosition } from '@/lib/utils';

interface PdfNodeData extends GraphNode {
  selected?: boolean;
}

/** 计算 ArrayBuffer 的 SHA-256 十六进制字符串 */
async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export const PdfNode = memo(function PdfNode({ id, data, selected, dragging }: NodeProps) {
  const node = (data ?? {}) as unknown as PdfNodeData;
  const updateNode = useCanvasStore((s) => s.updateNode);
  const session = useCanvasStore((s) => s.session);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pdfPath = node.pdfPath ?? '';
  const currentPage = node.pdfCurrentPage ?? 1;
  const totalPages = node.pdfTotalPages ?? 1;
  const projectId = session.projectId;

  /** 构建 iframe 显示的 URL。需要先通过 storage adapter 读取二进制并生成 blob URL */
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!pdfPath) return;
    let cancelled = false;
    void (async () => {
      try {
        const adapter = await getStorageAdapter();
        const buffer = await adapter.readBinary(pdfPath);
        if (!buffer || cancelled) return;
        const blob = new Blob([buffer], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        setBlobUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return url;
        });
      } catch {
        if (!cancelled) setError('无法加载 PDF 文件');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pdfPath]);

  useEffect(() => {
    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, []);

  /** 上传处理 */
  const handleUpload = useCallback(async (file: File) => {
    if (file.type !== 'application/pdf') {
      setError('仅支持 PDF 文件');
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const buffer = await file.arrayBuffer();
      const hash = await sha256Hex(buffer);
      const relPath = `projects/${projectId}/assets/${hash}.pdf`;
      const adapter = await getStorageAdapter();
      const existed = await adapter.exists(relPath);
      if (!existed) {
        await adapter.writeBinary(relPath, buffer);
      }
      updateNode(id, {
        title: node.title === 'PDF 阅读' ? file.name : node.title,
        pdfPath: relPath,
        pdfCurrentPage: 1,
        pdfTotalPages: 1,
      });
    } catch (e) {
      setError('上传失败');
    } finally {
      setUploading(false);
    }
  }, [id, updateNode, node.title, projectId]);

  /** 拖放 */
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file) handleUpload(file);
    },
    [handleUpload]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  /** 点击选择文件 */
  const handleClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleUpload(file);
    },
    [handleUpload]
  );

  /** 分页控制 */
  const goToPrev = useCallback(() => {
    if (currentPage <= 1) return;
    updateNode(id, { pdfCurrentPage: currentPage - 1 });
  }, [id, currentPage, updateNode]);

  const goToNext = useCallback(() => {
    if (currentPage >= totalPages) return;
    updateNode(id, { pdfCurrentPage: currentPage + 1 });
  }, [id, currentPage, totalPages, updateNode]);

  return (
    <div
      className="relative rounded-lg border shadow-md bg-white dark:bg-zinc-800 border-red-200 dark:border-red-800 min-w-[500px]"
      style={{ width: node.width || 700, height: node.height || 550 }}
    >
      <NodeResizer minWidth={400} minHeight={300} isVisible={selected} lineStyle={{ borderColor: '#D97757' }} />

      {/* 标题栏 */}
      <div className="flex items-center justify-between border-b border-red-200 dark:border-red-800 px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-red-600 dark:text-red-400 text-xs shrink-0">[PDF]</span>
          <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100 truncate">{node.title}</span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {pdfPath && (
            <>
              <button
                onClick={goToPrev}
                disabled={currentPage <= 1}
                className="text-[10px] px-1.5 py-0.5 rounded text-zinc-400 hover:text-zinc-600 disabled:opacity-30 hover:bg-red-50 dark:hover:bg-red-900/20"
                title="上一页"
              >
                &lt;
              </button>
              <span className="text-[10px] text-zinc-400">{currentPage} / {totalPages}</span>
              <button
                onClick={goToNext}
                disabled={currentPage >= totalPages}
                className="text-[10px] px-1.5 py-0.5 rounded text-zinc-400 hover:text-zinc-600 disabled:opacity-30 hover:bg-red-50 dark:hover:bg-red-900/20"
                title="下一页"
              >
                &gt;
              </button>
            </>
          )}
          <span className="text-[9px] text-zinc-400">{formatTime(node.createdAt)}</span>
        </div>
      </div>

      {/* 内容区 (nodrag: 拖动仅由标题栏/卡片边缘触发, onWheel 隔离滚动与画布缩放) */}
      <div
        className="h-[calc(100%-40px)] nodrag"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onWheel={(e) => e.stopPropagation()}
      >
        {dragging ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-zinc-400">
            <span className="text-4xl opacity-20">[PDF]</span>
            <span className="text-xs">{node.title}</span>
          </div>
        ) : uploading ? (
          <div className="flex items-center justify-center h-full text-sm text-zinc-400">
            上传中...
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center h-full gap-2">
            <div className="text-sm text-red-500">{error}</div>
            <button
              onClick={handleClick}
              className="text-xs text-blue-500 hover:underline"
            >
              重新选择文件
            </button>
          </div>
        ) : blobUrl ? (
          <iframe
            src={`${blobUrl}#page=${currentPage}`}
            className="w-full h-full border-0"
            title={node.title}
          />
        ) : (
          <div
            className="flex flex-col items-center justify-center h-full gap-3 cursor-pointer text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
            onClick={handleClick}
          >
            <div className="text-4xl opacity-30">[PDF]</div>
            <div className="text-sm">拖入 PDF 文件或点击上传</div>
            <div className="text-[10px] opacity-50">支持浏览器原生 PDF 查看器</div>
          </div>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf"
        className="hidden"
        onChange={handleFileChange}
      />

      {/* Handle: 顶部入，底部出 */}
      <Handle type="target" position={Position.Top} className="!bg-red-400 !w-2.5 !h-2.5" />
      <Handle type="source" position={Position.Bottom} className="!bg-red-400 !w-2.5 !h-2.5" />
    </div>
  );
}, shallowSkipPosition);

