/**
 * src/components/PdfNode/PdfNode.tsx
 * PDF 阅读卡片：拖入/上传 PDF → assets/ 存储 → pdf.js canvas 渲染。
 * v0.5: 用 pdf.js 替换 iframe，支持高清渲染和自由缩放。
 * v0.6: PDF 批注功能 —— 批注状态在组件内部维护，不污染 GraphNode。
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

/* ===== 批注类型（组件内部，不暴露到 GraphNode） ===== */

type AnnotationTool = 'select' | 'highlight' | 'underline' | 'strikeout' | 'freetext';

interface TextMarkupAnnotation {
  id: string;
  type: 'highlight' | 'underline' | 'strikeout';
  pageNumber: number;
  quads: number[][];         // [[x1,y1,x2,y2], ...] viewport 坐标下的矩形区域
  color: string;
  createdAt: number;
}

interface FreetextAnnotation {
  id: string;
  type: 'freetext';
  pageNumber: number;
  x: number;                 // viewport 坐标
  y: number;
  text: string;
  color: string;
  fontSize: number;
  createdAt: number;
}

type PdfAnnotation = TextMarkupAnnotation | FreetextAnnotation;

/** 各批注类型的默认颜色 */
const ANNOTATION_COLORS: Record<string, string> = {
  highlight: 'rgba(255, 230, 50, 0.45)',
  underline: 'rgba(0, 100, 255, 0.85)',
  strikeout: 'rgba(255, 60, 60, 0.85)',
  freetext: '#222222',
};

const FREETEXT_BG = 'rgba(255, 255, 200, 0.92)';

/* ===== 文本层类型 ===== */

interface TextLayerSpan {
  text: string;
  left: number;
  top: number;
  fontSize: number;
  fontFamily: string;
  width: number;
  height: number;
  scaleX: number;
}

/* ===== 工具函数 ===== */

interface PdfNodeData extends GraphNode {
  selected?: boolean;
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function genAnnoId(): string {
  return `anno_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 从 pdf.js TextContent 构建字符级的位置索引，用于选区→坐标映射 */
interface CharPosition {
  char: string;
  x: number;
  y: number;      // baseline y
  width: number;
  height: number;
  pageIdx: number; // 在整个页面文本流中的位置
}

/** 从 pdf.js TextContent 构建文本层 span 数组（含样式信息，用于 DOM 文本层渲染） */
async function buildTextLayerSpans(page: pdfjs.PDFPageProxy): Promise<TextLayerSpan[]> {
  const textContent = await page.getTextContent();
  const viewport = page.getViewport({ scale: 1.0 });
  const spans: TextLayerSpan[] = [];

  for (const item of textContent.items) {
    if (!('str' in item) || !item.str.trim()) continue;
    const tx = item.transform;
    const fontSize = Math.sqrt(tx[0] ** 2 + tx[1] ** 2);
    const itemWidth: number = 'width' in item ? item.width : 0;
    if (itemWidth === 0) continue;

    const [vx, vy] = viewport.convertToViewportPoint(tx[4], tx[5]);
    const scaleX = Math.sqrt(tx[0] ** 2 + tx[2] ** 2);

    spans.push({
      text: item.str,
      left: vx,
      top: vy - fontSize * viewport.scale,
      fontSize: fontSize * viewport.scale,
      fontFamily: 'sans-serif',
      width: itemWidth * viewport.scale,
      height: fontSize * viewport.scale * 1.4,
      scaleX: scaleX,
    });
  }
  return spans;
}

/** 从 pdf.js TextContent 构建字符级的位置索引，用于选区→坐标映射 */
async function buildCharIndex(page: pdfjs.PDFPageProxy): Promise<CharPosition[]> {
  const textContent = await page.getTextContent();
  const viewport = page.getViewport({ scale: 1.0 });
  const chars: CharPosition[] = [];
  let globalIdx = 0;

  for (const item of textContent.items) {
    if (!('str' in item)) continue;
    const tx = item.transform;
    const fontSize = Math.sqrt(tx[0] ** 2 + tx[1] ** 2);
    if ('width' in item && item.width === 0) continue;

    const str: string = item.str;
    const itemWidth: number = 'width' in item ? item.width : 0;
    const charWidths: number[] = [];

    if ('rawChars' in item && Array.isArray(item.rawChars)) {
      // 有逐字符宽度
      for (const rc of item.rawChars) {
        charWidths.push(rc.width ?? rc.charWidth ?? 0);
      }
    } else if (itemWidth > 0 && str.length > 0) {
      // 均匀分配
      const avgW = itemWidth / str.length;
      for (let i = 0; i < str.length; i++) charWidths.push(avgW);
    }

    // 调整到实际字符数
    while (charWidths.length < str.length) charWidths.push(0);

    let cursorX = tx[4];
    for (let i = 0; i < str.length; i++) {
      const cw = charWidths[i] ?? 0;
      const [vx, vy] = viewport.convertToViewportPoint(cursorX, tx[5]);
      chars.push({
        char: str[i],
        x: vx,
        y: vy,
        width: cw * viewport.scale,
        height: fontSize * viewport.scale,
        pageIdx: globalIdx++,
      });
      cursorX += (cw / fontSize) * fontSize;  // 沿文本方向推进
    }
  }
  return chars;
}

/**
 * 将选中的文本范围映射为 viewport 坐标下的 quads 数组。
 * selectedOffset/selectedLength 是选中文本在全文中的偏移（用于精确匹配）。
 */
function selectionToQuads(
  chars: CharPosition[],
  selectedText: string,
  viewport: pdfjs.PageViewport
): number[][] | null {
  if (chars.length === 0 || !selectedText) return null;

  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const fullText = chars.map((c) => c.char).join('');
  const normFull = norm(fullText);
  const normSel = norm(selectedText);
  if (!normSel) return null;

  const startIdx = normFull.indexOf(normSel);
  if (startIdx < 0) return null;

  // 将规范化索引映射回原始 chars 索引
  let rawStart = 0;
  let normPos = 0;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i].char;
    const isWS = /\s/.test(c);
    if (!isWS) {
      if (normPos === startIdx) { rawStart = i; }
      normPos++;
    } else if (normPos > startIdx && normFull[normPos] === ' ') {
      normPos++;
    }
    if (normPos >= startIdx + normSel.length) {
      break;
    }
  }
  const rawEnd = Math.min(rawStart + selectedText.replace(/\s/g, '').length, chars.length - 1);

  // 按行分组，生成 quads
  const quads: number[][] = [];
  const Y_THRESHOLD = 3; // 同一行 y 偏差阈值
  let groupStart = rawStart;

  for (let i = rawStart + 1; i <= rawEnd; i++) {
    if (i > rawEnd) break;
    const prev = chars[i - 1];
    const curr = chars[i];
    if (Math.abs(curr.y - prev.y) > Y_THRESHOLD) {
      const gChars = chars.slice(groupStart, i);
      const minX = Math.min(...gChars.map((c) => c.x));
      const maxX = Math.max(...gChars.map((c) => c.x + c.width));
      const avgY = gChars.reduce((s, c) => s + c.y, 0) / gChars.length;
      const avgH = gChars.reduce((s, c) => s + c.height, 0) / gChars.length;
      // 应用 viewport scale
      const [vx1, vy1] = viewport.convertToViewportPoint(minX, avgY - avgH * 0.2);
      const [vx2, vy2] = viewport.convertToViewportPoint(maxX, avgY + avgH * 1.1);
      quads.push([vx1, vy1, vx2, vy2]);
      groupStart = i;
    }
  }
  // 最后一组
  const lastGroup = chars.slice(groupStart, rawEnd + 1);
  if (lastGroup.length > 0) {
    const minX = Math.min(...lastGroup.map((c) => c.x));
    const maxX = Math.max(...lastGroup.map((c) => c.x + c.width));
    const avgY = lastGroup.reduce((s, c) => s + c.y, 0) / lastGroup.length;
    const avgH = lastGroup.reduce((s, c) => s + c.height, 0) / lastGroup.length;
    const [vx1, vy1] = viewport.convertToViewportPoint(minX, avgY - avgH * 0.2);
    const [vx2, vy2] = viewport.convertToViewportPoint(maxX, avgY + avgH * 1.1);
    quads.push([vx1, vy1, vx2, vy2]);
  }

  return quads.length > 0 ? quads : null;
}

/* ===== 组件 ===== */

export const PdfNode = function PdfNode({ id, data, selected, dragging }: NodeProps) {
  const node = (data ?? {}) as unknown as PdfNodeData;
  const updateNode = useCanvasStore((s) => s.updateNode);
  const session = useCanvasStore((s) => s.session);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const svgContainerRef = useRef<HTMLDivElement>(null);
  const renderTaskRef = useRef<pdfjs.RenderTask | null>(null);
  const charIndexRef = useRef<CharPosition[]>([]);
  const viewportRef = useRef<pdfjs.PageViewport | null>(null);
  const annotationsRef = useRef<PdfAnnotation[]>([]);

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

  /* ---------- 批注状态（组件内部，不进入 GraphNode） ---------- */
  const [annotations, setAnnotations] = useState<PdfAnnotation[]>([]);
  const [annotationTool, setAnnotationTool] = useState<AnnotationTool>('select');
  const [editingFreetextId, setEditingFreetextId] = useState<string | null>(null);
  const [freetextDraft, setFreetextDraft] = useState('');

  /* ---------- 文本层（使 Canvas PDF 文本可被浏览器选区） ---------- */
  const [textLayerSpans, setTextLayerSpans] = useState<TextLayerSpan[]>([]);

  /* ---------- freetext 拖拽状态 ---------- */
  const [draggingAnnoId, setDraggingAnnoId] = useState<string | null>(null);
  const dragStartRef = useRef<{ mouseX: number; mouseY: number; annoX: number; annoY: number } | null>(null);

  const pdfPath = node.pdfPath ?? '';
  const currentPage = node.pdfCurrentPage ?? 1;
  const totalPages = pdfDoc?.numPages ?? node.pdfTotalPages ?? 0;
  const projectId = session.projectId;
  const toolbarButtonClass = 'min-h-7 min-w-7 rounded-md bg-[#D97757] px-2 py-1 text-xs text-white hover:bg-[#C96B4D] disabled:opacity-40 dark:bg-violet-700 dark:hover:bg-violet-600';
  const toolbarBadgeClass = 'rounded-md bg-[#D97757] px-2 py-1 text-xs text-white select-none dark:bg-violet-700';
  const activeToolClass = 'min-h-7 min-w-7 rounded-md px-2 py-1 text-xs text-white bg-[#E05A3A] dark:bg-violet-500 ring-1 ring-white';

  useEffect(() => {
    setLiveSize({
      width: node.width ?? 1400,
      height: node.height ?? 1100,
    });
  }, [node.height, node.width]);

  // 同步 ref
  useEffect(() => {
    annotationsRef.current = annotations;
  }, [annotations]);

  /* ---------- 批注持久化 ---------- */
  const getAnnoPath = useCallback(
    (pdfRelPath: string) => pdfRelPath.replace(/\.pdf$/i, '.annotations.json'),
    []
  );

  const saveAnnotations = useCallback(
    async (annos: PdfAnnotation[], pdfRelPath: string) => {
      if (!pdfRelPath) return;
      try {
        const adapter = await getStorageAdapter();
        const annoPath = getAnnoPath(pdfRelPath);
        await adapter.writeJson(annoPath, JSON.parse(JSON.stringify(annos)));
      } catch {
        // 静默失败，不影响主流程
      }
    },
    [getAnnoPath]
  );

  const loadAnnotations = useCallback(
    async (pdfRelPath: string) => {
      if (!pdfRelPath) return;
      try {
        const adapter = await getStorageAdapter();
        const annoPath = getAnnoPath(pdfRelPath);
        const existed = await adapter.exists(annoPath);
        if (!existed) {
          setAnnotations([]);
          return;
        }
        const parsed = await adapter.readJson(annoPath);
        if (Array.isArray(parsed)) setAnnotations(parsed as PdfAnnotation[]);
      } catch {
        setAnnotations([]);
      }
    },
    [getAnnoPath]
  );

  // 加载/卸载 PDF 时同步批注
  useEffect(() => {
    if (pdfPath) {
      loadAnnotations(pdfPath);
    } else {
      setAnnotations([]);
    }
  }, [pdfPath, loadAnnotations]);

  // 批注变更时自动保存（防抖 1s）
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    if (!pdfPath) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveAnnotations(annotations, pdfPath);
    }, 1000);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [annotations, pdfPath, saveAnnotations]);

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

  /* ---------- 渲染当前页 + 构建字符索引 ---------- */
  useEffect(() => {
    if (!pdfDoc || !canvasRef.current) return;
    let cancelled = false;
    setRendering(true);

    void (async () => {
      try {
        if (renderTaskRef.current) {
          renderTaskRef.current.cancel();
        }
        const page = await pdfDoc.getPage(currentPage);
        if (cancelled) return;
        const viewport = page.getViewport({ scale });
        viewportRef.current = viewport;
        const canvas = canvasRef.current!;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        const ctx = canvas.getContext('2d')!;
        const task = page.render({ canvasContext: ctx, viewport });
        renderTaskRef.current = task;

        // 并行构建字符索引和文本层
        buildCharIndex(page).then((idx) => {
          if (!cancelled) charIndexRef.current = idx;
        });
        buildTextLayerSpans(page).then((spans) => {
          if (!cancelled) setTextLayerSpans(spans);
        });

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

  /* ---------- 批注：文本标记（高亮/下划线/删除线） ---------- */
  const handleTextSelection = useCallback(() => {
    const tool = annotationTool;
    if (tool !== 'highlight' && tool !== 'underline' && tool !== 'strikeout') return;

    // 延迟执行，等浏览器完成选区渲染
    setTimeout(() => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.toString().trim()) return;

      const range = selection.getRangeAt(0);
      const containerEl = containerRef.current;
      if (!containerEl) return;
      const ancestor = range.commonAncestorContainer;
      const nodeInContainer = ancestor.nodeType === 1
        ? containerEl.contains(ancestor as Element)
        : ancestor.parentElement ? containerEl.contains(ancestor.parentElement) : false;
      if (!nodeInContainer) return;

      const selectedText = selection.toString();
      const chars = charIndexRef.current;
      const viewport = viewportRef.current;
      if (!viewport) return;

      const quads = selectionToQuads(chars, selectedText, viewport);
      if (!quads || quads.length === 0) return;

      const newAnno: TextMarkupAnnotation = {
        id: genAnnoId(),
        type: tool,
        pageNumber: currentPage,
        quads,
        color: ANNOTATION_COLORS[tool],
        createdAt: Date.now(),
      };

      setAnnotations((prev) => [...prev, newAnno]);
      selection.removeAllRanges();
    }, 0);
  }, [annotationTool, currentPage]);

  /* ---------- freetext 拖拽 ---------- */
  const handleFreetextMouseDown = useCallback(
    (e: React.MouseEvent, anno: FreetextAnnotation) => {
      if (annotationTool !== 'select') return;
      e.stopPropagation();
      e.preventDefault();
      setDraggingAnnoId(anno.id);
      dragStartRef.current = {
        mouseX: e.clientX,
        mouseY: e.clientY,
        annoX: anno.x,
        annoY: anno.y,
      };
    },
    [annotationTool]
  );

  useEffect(() => {
    if (!draggingAnnoId) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragStartRef.current) return;
      const dx = e.clientX - dragStartRef.current.mouseX;
      const dy = e.clientY - dragStartRef.current.mouseY;
      setAnnotations((prev) =>
        prev.map((a) =>
          a.id === draggingAnnoId && a.type === 'freetext'
            ? { ...a, x: dragStartRef.current!.annoX + dx, y: dragStartRef.current!.annoY + dy }
            : a
        )
      );
    };

    const handleMouseUp = () => {
      setDraggingAnnoId(null);
      dragStartRef.current = null;
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [draggingAnnoId]);

  /* ---------- 批注：自由文本点击放置 ---------- */
  const handleCanvasClick = useCallback(
    (e: React.MouseEvent) => {
      if (annotationTool !== 'freetext') return;
      const svgRect = svgContainerRef.current?.getBoundingClientRect();
      if (!svgRect) return;
      const x = e.clientX - svgRect.left;
      const y = e.clientY - svgRect.top;

      const newId = genAnnoId();
      const newAnno: FreetextAnnotation = {
        id: newId,
        type: 'freetext',
        pageNumber: currentPage,
        x,
        y,
        text: '',
        color: ANNOTATION_COLORS.freetext,
        fontSize: 13,
        createdAt: Date.now(),
      };
      setAnnotations((prev) => [...prev, newAnno]);
      setEditingFreetextId(newId);
      setFreetextDraft('');
    },
    [annotationTool, currentPage]
  );

  const handleFreetextSave = useCallback(
    (annoId: string) => {
      const trimmed = freetextDraft.trim();
      if (!trimmed) {
        // 空文本则删除批注
        setAnnotations((prev) => prev.filter((a) => a.id !== annoId));
      } else {
        setAnnotations((prev) =>
          prev.map((a) => (a.id === annoId ? { ...a, text: trimmed } as FreetextAnnotation : a))
        );
      }
      setEditingFreetextId(null);
      setFreetextDraft('');
    },
    [freetextDraft]
  );

  const handleFreetextCancel = useCallback(
    (annoId: string) => {
      setAnnotations((prev) => {
        const anno = prev.find((a) => a.id === annoId);
        if (anno && anno.type === 'freetext' && !anno.text) {
          return prev.filter((a) => a.id !== annoId);
        }
        return prev;
      });
      setEditingFreetextId(null);
      setFreetextDraft('');
    },
    []
  );

  /* ---------- 批注：删除 ---------- */
  const handleDeleteAnnotation = useCallback((annoId: string) => {
    setAnnotations((prev) => prev.filter((a) => a.id !== annoId));
  }, []);

  /* ---------- 当前页的批注 ---------- */
  const pageAnnotations = annotations.filter((a) => a.pageNumber === currentPage);

  /* ---------- 渲染批注 SVG 叠加层 ---------- */
  const renderAnnotationSvg = (tool: AnnotationTool) => {
    if (!viewportRef.current) return null;
    const vpW = viewportRef.current.width;
    const vpH = viewportRef.current.height;
    const isFreetext = tool === 'freetext';

    return (
      <svg
        width={vpW}
        height={vpH}
        className="absolute top-0 left-0"
        style={{ zIndex: 10, pointerEvents: isFreetext ? 'auto' : 'none' }}
        onClick={isFreetext ? handleCanvasClick : undefined}
      >
        {pageAnnotations.map((anno) => {
          if (anno.type === 'freetext') {
            const isDragging = draggingAnnoId === anno.id;
            return (
              <g key={anno.id} className="pointer-events-auto">
                {/* 背景 */}
                <rect
                  x={anno.x}
                  y={anno.y}
                  width={Math.max(anno.text.length * anno.fontSize * 0.7 + 16, 40)}
                  height={anno.fontSize * 2.2}
                  rx={3}
                  fill={FREETEXT_BG}
                  stroke={isDragging ? '#4A90D9' : '#ccc'}
                  strokeWidth={isDragging ? 1.5 : 0.5}
                  className="cursor-move"
                  onMouseDown={(e) => handleFreetextMouseDown(e, anno)}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setEditingFreetextId(anno.id);
                    setFreetextDraft(anno.text);
                  }}
                />
                {/* 文本 */}
                <text
                  x={anno.x + 8}
                  y={anno.y + anno.fontSize + 4}
                  fontSize={anno.fontSize}
                  fill={anno.color}
                  fontFamily="sans-serif"
                  className="select-none pointer-events-none"
                >
                  {anno.text || '(双击编辑)'}
                </text>
                {/* 删除按钮（hover 显示） */}
                <g
                  className="opacity-0 hover:opacity-100 pointer-events-auto cursor-pointer"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteAnnotation(anno.id);
                  }}
                >
                  <circle
                    cx={anno.x + Math.max(anno.text.length * anno.fontSize * 0.7 + 16, 40) - 6}
                    cy={anno.y + 6}
                    r={7}
                    fill="#e74c3c"
                  />
                  <line
                    x1={anno.x + Math.max(anno.text.length * anno.fontSize * 0.7 + 16, 40) - 10}
                    y1={anno.y + 2}
                    x2={anno.x + Math.max(anno.text.length * anno.fontSize * 0.7 + 16, 40) - 2}
                    y2={anno.y + 10}
                    stroke="white"
                    strokeWidth={1.5}
                  />
                  <line
                    x1={anno.x + Math.max(anno.text.length * anno.fontSize * 0.7 + 16, 40) - 2}
                    y1={anno.y + 2}
                    x2={anno.x + Math.max(anno.text.length * anno.fontSize * 0.7 + 16, 40) - 10}
                    y2={anno.y + 10}
                    stroke="white"
                    strokeWidth={1.5}
                  />
                </g>
              </g>
            );
          }

          // 文本标记批注 (highlight / underline / strikeout)
          return (
            <g key={anno.id} className="pointer-events-auto">
              {anno.quads.map((quad, qi) => {
                const [x1, y1, x2, y2] = quad;
                const rx = Math.min(x1, x2);
                const ry = Math.min(y1, y2);
                const rw = Math.abs(x2 - x1);
                const rh = Math.abs(y2 - y1);

                if (anno.type === 'highlight') {
                  return (
                    <rect
                      key={qi}
                      x={rx}
                      y={ry}
                      width={rw}
                      height={rh}
                      fill={anno.color}
                      className="cursor-pointer opacity-60 hover:opacity-40"
                      onClick={() => handleDeleteAnnotation(anno.id)}
                    >
                      <title>点击删除批注</title>
                    </rect>
                  );
                }
                if (anno.type === 'underline') {
                  const lineY = ry + rh;
                  return (
                    <line
                      key={qi}
                      x1={rx}
                      y1={lineY}
                      x2={rx + rw}
                      y2={lineY}
                      stroke={anno.color}
                      strokeWidth={2}
                      className="cursor-pointer hover:opacity-50"
                      onClick={() => handleDeleteAnnotation(anno.id)}
                    >
                      <title>点击删除批注</title>
                    </line>
                  );
                }
                // strikeout
                const midY = ry + rh / 2;
                return (
                  <line
                    key={qi}
                    x1={rx}
                    y1={midY}
                    x2={rx + rw}
                    y2={midY}
                    stroke={anno.color}
                    strokeWidth={2}
                    className="cursor-pointer hover:opacity-50"
                    onClick={() => handleDeleteAnnotation(anno.id)}
                  >
                    <title>点击删除批注</title>
                  </line>
                );
              })}
            </g>
          );
        })}
      </svg>
    );
  };

  /* ---------- 批注工具栏 ---------- */
  const annotationToolbar = pdfDoc ? (
    <div className="flex items-center gap-1 shrink-0">
      <span className="text-[8px] text-zinc-300 dark:text-zinc-600">|</span>
      <button
        onClick={() => setAnnotationTool('select')}
        className={annotationTool === 'select' ? activeToolClass : toolbarButtonClass}
        title="选择模式"
      >
        &#x2B55;
      </button>
      <button
        onClick={() => setAnnotationTool('highlight')}
        className={annotationTool === 'highlight' ? activeToolClass : toolbarButtonClass}
        title="高亮 (框选文字后自动创建)"
        style={annotationTool === 'highlight' ? { backgroundColor: '#F5C842', color: '#333' } : undefined}
      >
        &#x1F4CD;
      </button>
      <button
        onClick={() => setAnnotationTool('underline')}
        className={annotationTool === 'underline' ? activeToolClass : toolbarButtonClass}
        title="下划线 (框选文字后自动创建)"
        style={annotationTool === 'underline' ? { backgroundColor: '#4A90D9' } : undefined}
      >
        U
      </button>
      <button
        onClick={() => setAnnotationTool('strikeout')}
        className={annotationTool === 'strikeout' ? activeToolClass : toolbarButtonClass}
        title="删除线 (框选文字后自动创建)"
        style={annotationTool === 'strikeout' ? { backgroundColor: '#E05A3A' } : undefined}
      >
        S
      </button>
      <button
        onClick={() => setAnnotationTool('freetext')}
        className={annotationTool === 'freetext' ? activeToolClass : toolbarButtonClass}
        title="文本批注 (点击页面放置)"
        style={annotationTool === 'freetext' ? { backgroundColor: '#5BBD72' } : undefined}
      >
        T
      </button>
    </div>
  ) : null;

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
              {annotationToolbar}
              <span className="text-[8px] text-zinc-300 dark:text-zinc-600">|</span>
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
        onMouseUp={handleTextSelection}
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
              {/* Canvas 层 */}
              <canvas ref={canvasRef} className="shadow-sm block" />
              {/* 文本层（透明 DOM span，使 PDF 文本可被浏览器选区） */}
              {textLayerSpans.length > 0 && (
                <div
                  className="absolute top-0 left-0 select-text"
                  style={{
                    width: viewportRef.current?.width ?? 0,
                    height: viewportRef.current?.height ?? 0,
                    zIndex: 5,
                  }}
                >
                  {textLayerSpans.map((span, i) => (
                    <span
                      key={i}
                      style={{
                        position: 'absolute',
                        left: span.left * scale,
                        top: span.top * scale,
                        fontSize: span.fontSize * scale,
                        fontFamily: span.fontFamily,
                        width: span.width * scale,
                        height: span.height * scale,
                        color: 'transparent',
                        whiteSpace: 'pre',
                        overflow: 'hidden',
                        lineHeight: `${span.height * scale}px`,
                      }}
                    >
                      {span.text}
                    </span>
                  ))}
                </div>
              )}
              {/* SVG 批注层 */}
              <div
                ref={svgContainerRef}
                className="absolute top-0 left-0"
              >
                {renderAnnotationSvg(annotationTool)}
                {/* 自由文本编辑框 */}
                {editingFreetextId && (() => {
                  const ft = annotations.find(
                    (a) => a.id === editingFreetextId && a.type === 'freetext'
                  ) as FreetextAnnotation | undefined;
                  if (!ft) return null;
                  return (
                    <textarea
                      autoFocus
                      value={freetextDraft}
                      onChange={(e) => setFreetextDraft(e.target.value)}
                      onBlur={() => handleFreetextSave(editingFreetextId)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          handleFreetextSave(editingFreetextId);
                        }
                        if (e.key === 'Escape') {
                          handleFreetextCancel(editingFreetextId);
                        }
                      }}
                      placeholder="输入批注内容..."
                      className="absolute bg-white border border-yellow-400 rounded p-1 text-xs resize-none outline-none shadow-sm"
                      style={{
                        left: ft.x,
                        top: ft.y,
                        width: 180,
                        minHeight: 40,
                        zIndex: 20,
                        fontFamily: 'sans-serif',
                        fontSize: ft.fontSize,
                        color: ft.color,
                      }}
                      onClick={(e) => e.stopPropagation()}
                    />
                  );
                })()}
              </div>
              {/* 渲染中遮罩 */}
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
