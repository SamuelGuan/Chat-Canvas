/**
 * src/components/PdfNode/PdfNode.tsx
 * PDF 阅读卡片：拖入/上传 PDF → assets/ 存储 → pdf.js canvas 渲染。
 * v0.5: 用 pdf.js 替换 iframe，支持高清渲染和自由缩放。
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { Handle, Position, NodeProps, NodeResizer } from '@xyflow/react';
import * as pdfjs from 'pdfjs-dist';
import { useCanvasStore } from '@/store/useCanvasStore';
import { getStorageAdapter } from '@/lib/storage/adapter';
import { GraphNode } from '@/types';
import { formatTime } from '@/lib/utils';

/** pdf.js worker */
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

/** 缩放档位 */
const SCALE_LEVELS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0, 4.0];

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

export const PdfNode = function PdfNode({ id, data, selected, dragging }: NodeProps) {
  const node = (data ?? {}) as unknown as PdfNodeData;
  const updateNode = useCanvasStore((s) => s.updateNode);
  const session = useCanvasStore((s) => s.session);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const renderTaskRef = useRef<pdfjs.RenderTask | null>(null);

  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [pdfDoc, setPdfDoc] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [scale, setScale] = useState(1.5);
  const [rendering, setRendering] = useState(false);
  const [liveSize, setLiveSize] = useState(() => ({
    width: node.width ?? 1400,
    height: node.height ?? 1100,
  }));

  const pdfPath = node.pdfPath ?? '';
  const currentPage = node.pdfCurrentPage ?? 1;
  const totalPages = pdfDoc?.numPages ?? node.pdfTotalPages ?? 0;
  const projectId = session.projectId;
  const toolbarButtonClass = 'min-h-7 min-w-7 rounded-md bg-[#D97757] px-2 py-1 text-xs text-white hover:bg-[#C96B4D] disabled:opacity-40 dark:bg-violet-700 dark:hover:bg-violet-600';
  const toolbarBadgeClass = 'rounded-md bg-[#D97757] px-2 py-1 text-xs text-white select-none dark:bg-violet-700';

  useEffect(() => {
    setLiveSize({
      width: node.width ?? 1400,
      height: node.height ?? 1100,
    });
  }, [node.height, node.width]);

  /* ---------- 加载 PDF 二进制 ---------- */
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
          if (prev && prev !== url) URL.revokeObjectURL(prev);
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

  /* ---------- pdf.js 加载文档 ---------- */
  useEffect(() => {
    if (!blobUrl) {
      setPdfDoc(null);
      return;
    }
    let cancelled = false;
    setError(null);
    const loadingTask = pdfjs.getDocument(blobUrl);
    loadingTask.promise
      .then((doc) => {
        if (cancelled) return;
        setPdfDoc(doc);
        updateNode(id, { pdfTotalPages: doc.numPages });
      })
      .catch(() => {
        if (!cancelled) setError('PDF 解析失败');
      });
    return () => {
      cancelled = true;
      loadingTask.destroy();
    };
  }, [blobUrl, id, updateNode]);

  /* ---------- 渲染当前页 ---------- */
  useEffect(() => {
    if (!pdfDoc || !canvasRef.current) return;
    let cancelled = false;
    setRendering(true);

    void (async () => {
      try {
        // 取消上一次渲染
        if (renderTaskRef.current) {
          renderTaskRef.current.cancel();
        }
        const page = await pdfDoc.getPage(currentPage);
        if (cancelled) return;
        const viewport = page.getViewport({ scale });
        const canvas = canvasRef.current!;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        const ctx = canvas.getContext('2d')!;
        const task = page.render({ canvasContext: ctx, viewport });
        renderTaskRef.current = task;
        await task.promise;
        if (!cancelled) setRendering(false);
      } catch (err: any) {
        if (err?.name !== 'RenderingCancelledException' && !cancelled) {
          setRendering(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [pdfDoc, currentPage, scale]);
  /* ---------- blobUrl 清理 ---------- */
  useEffect(() => {
    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [blobUrl]);

  /* ---------- 缩放 ---------- */
  const zoomIn = useCallback(() => {
    setScale((s) => {
      const next = SCALE_LEVELS.find((v) => v > s);
      return next ?? s;
    });
  }, []);

  const zoomOut = useCallback(() => {
    setScale((s) => {
      const rev = [...SCALE_LEVELS].reverse();
      const prev = rev.find((v) => v < s);
      return prev ?? s;
    });
  }, []);

  /* ---------- 上传 ---------- */
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
    } catch {
      setError('上传失败');
    } finally {
      setUploading(false);
    }
  }, [id, updateNode, node.title, projectId]);

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

  /* ---------- 翻页 ---------- */
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
      className="relative overflow-hidden rounded-lg border shadow-md bg-white dark:bg-zinc-800 border-red-200 dark:border-violet-700 min-w-[400px]"
      style={{ width: liveSize.width, height: liveSize.height }}
    >
      <NodeResizer
        minWidth={400}
        minHeight={300}
        isVisible={selected}
        lineStyle={{ borderColor: '#D97757' }}
        onResizeStart={(_e, params) => {
          setLiveSize({ width: params.width, height: params.height });
        }}
        onResize={(_e, params) => {
          setLiveSize({ width: params.width, height: params.height });
        }}
        onResizeEnd={(_e, params) => {
          setLiveSize({ width: params.width, height: params.height });
          updateNode(id, { width: params.width, height: params.height });
        }}
      />

      {/* 标题栏 */}
      <div className="flex items-center justify-between border-b border-red-200 dark:border-violet-700 px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-red-600 dark:text-red-400 text-xs shrink-0">[PDF]</span>
          <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100 truncate">{node.title}</span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {pdfDoc && (
            <>
              {/* 缩放按钮 */}
              <button
                onClick={zoomOut}
                disabled={scale <= SCALE_LEVELS[0]}
                className={toolbarButtonClass}
                title="缩小"
              >
                &minus;
              </button>
              <span
                className={`${toolbarBadgeClass} cursor-pointer`}
                onClick={() => setScale(1.5)}
                title="重置缩放"
              >
                {Math.round(scale * 100)}%
              </span>
              <button
                onClick={zoomIn}
                disabled={scale >= SCALE_LEVELS[SCALE_LEVELS.length - 1]}
                className={toolbarButtonClass}
                title="放大"
              >
                +
              </button>
              <span className="text-[8px] text-zinc-300 dark:text-zinc-600">|</span>
              {/* 翻页按钮 */}
              <button
                onClick={goToPrev}
                disabled={currentPage <= 1}
                className={toolbarButtonClass}
                title="上一页"
              >
                &lt;
              </button>
              <span className={toolbarBadgeClass}>{currentPage} / {totalPages}</span>
              <button
                onClick={goToNext}
                disabled={currentPage >= totalPages}
                className={toolbarButtonClass}
                title="下一页"
              >
                &gt;
              </button>
            </>
          )}
          <span className="text-[9px] text-zinc-400 ml-1">{formatTime(node.createdAt)}</span>
        </div>
      </div>

      {/* 内容区 */}
      <div
        ref={containerRef}
        className="h-[calc(100%-40px)] overflow-auto nodrag"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onWheel={(e) => e.stopPropagation()}
      >
        {uploading ? (
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
        ) : blobUrl && pdfDoc ? (
          <div className="flex items-start justify-center min-h-full p-1">
            <div className="relative">
              <canvas ref={canvasRef} className="shadow-sm" />
              {(rendering || dragging) && (
                <div className="absolute inset-0 flex items-center justify-center bg-white/50 dark:bg-zinc-800/50">
                  <span className="text-xs text-zinc-400">
                    {dragging ? node.title : '渲染中...'}
                  </span>
                </div>
              )}
            </div>
          </div>
        ) : blobUrl ? (
          <div className="flex items-center justify-center h-full text-sm text-zinc-400">
            加载中...
          </div>
        ) : (
          <div
            className="flex flex-col items-center justify-center h-full gap-3 cursor-pointer text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
            onClick={handleClick}
          >
            <div className="text-4xl opacity-30">[PDF]</div>
            <div className="text-sm">拖入 PDF 文件或点击上传</div>
            <div className="text-[10px] opacity-50">支持高 DPI 渲染和自由缩放</div>
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

      {/* Handle */}
      <Handle type="target" position={Position.Top} className="!bg-red-400 !w-2.5 !h-2.5" />
      <Handle type="source" position={Position.Bottom} className="!bg-red-400 !w-2.5 !h-2.5" />
    </div>
  );
}
