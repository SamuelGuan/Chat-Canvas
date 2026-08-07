import { useState, useRef, useCallback, useEffect } from 'react';
import { Handle, Position, NodeProps, NodeResizer } from '@xyflow/react';
import { useCanvasStore } from '@/store/useCanvasStore';
import { getStorageAdapter } from '@/lib/storage/adapter';
import { GraphNode } from '@/types';
import { formatTime } from '@/lib/utils';

interface PictureNodeData extends GraphNode {
  selected?: boolean;
}

function imageMimeType(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? 'png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'svg') return 'image/svg+xml';
  return 'image/png';
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export const PictureNode = function PictureNode({ id, data, selected, dragging }: NodeProps) {
  const node = (data ?? {}) as unknown as PictureNodeData;
  const updateNode = useCanvasStore((s) => s.updateNode);
  const session = useCanvasStore((s) => s.session);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [liveSize, setLiveSize] = useState(() => ({
    width: node.width ?? 900,
    height: node.height ?? 700,
  }));

  const picturePath = node.picturePath ?? '';
  const projectId = session.projectId;

  useEffect(() => {
    setLiveSize({
      width: node.width ?? 900,
      height: node.height ?? 700,
    });
  }, [node.height, node.width]);

  useEffect(() => {
    if (!picturePath) {
      setBlobUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const adapter = await getStorageAdapter();
        const buffer = await adapter.readBinary(picturePath);
        if (!buffer || cancelled) return;
        const url = URL.createObjectURL(new Blob([buffer], { type: imageMimeType(picturePath) }));
        setBlobUrl((prev) => {
          if (prev && prev !== url) URL.revokeObjectURL(prev);
          return url;
        });
      } catch {
        if (!cancelled) setError('无法加载图片文件');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [picturePath]);

  useEffect(() => {
    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [blobUrl]);

  const handleUpload = useCallback(async (file: File) => {
    if (!file.type.startsWith('image/')) {
      setError('仅支持图片文件');
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const buffer = await file.arrayBuffer();
      const hash = await sha256Hex(buffer);
      const ext = file.type === 'image/jpeg'
        ? 'jpg'
        : file.type === 'image/gif'
          ? 'gif'
          : file.type === 'image/webp'
            ? 'webp'
            : file.type === 'image/svg+xml'
              ? 'svg'
              : 'png';
      const relPath = `projects/${projectId}/assets/${hash}.${ext}`;
      const adapter = await getStorageAdapter();
      const existed = await adapter.exists(relPath);
      if (!existed) {
        await adapter.writeBinary(relPath, buffer);
      }
      updateNode(id, {
        title: node.title === '图片卡片' ? file.name : node.title,
        picturePath: relPath,
      });
    } catch {
      setError('上传失败');
    } finally {
      setUploading(false);
    }
  }, [id, node.title, projectId, updateNode]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) void handleUpload(file);
  }, [handleUpload]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void handleUpload(file);
    e.target.value = '';
  }, [handleUpload]);

  return (
    <div
      className="relative overflow-hidden rounded-lg border shadow-md bg-white dark:bg-zinc-800 border-emerald-200 dark:border-violet-700 min-w-[320px]"
      style={{ width: liveSize.width, height: liveSize.height }}
    >
      <NodeResizer
        minWidth={320}
        minHeight={240}
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

      <div className="flex items-center justify-between border-b border-emerald-200 dark:border-violet-700 px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-emerald-600 dark:text-emerald-400 text-xs shrink-0">[PIC]</span>
          <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100 truncate">{node.title}</span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <span className="text-[9px] text-zinc-400 ml-1">{formatTime(node.createdAt)}</span>
        </div>
      </div>

      <div
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
            <button onClick={handleClick} className="text-xs text-blue-500 hover:underline">
              重新选择文件
            </button>
          </div>
        ) : blobUrl ? (
          <div className="relative flex items-center justify-center min-h-full bg-zinc-50 dark:bg-zinc-900/50 p-2">
            <img
              src={blobUrl}
              alt={node.title}
              className="max-w-full max-h-full h-auto w-auto object-contain rounded"
            />
            {dragging && (
              <div className="absolute inset-0 flex items-center justify-center bg-white/50 dark:bg-zinc-800/50">
                <span className="text-xs text-zinc-400">{node.title}</span>
              </div>
            )}
          </div>
        ) : (
          <div
            className="flex flex-col items-center justify-center h-full gap-3 cursor-pointer text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
            onClick={handleClick}
          >
            <div className="text-4xl opacity-30">[PIC]</div>
            <div className="text-sm">拖入图片文件或点击上传</div>
            <div className="text-[10px] opacity-50">适合承载本地图片资源</div>
          </div>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFileChange}
      />

      <Handle type="target" position={Position.Top} className="!bg-emerald-400 !w-2.5 !h-2.5" />
      <Handle type="source" position={Position.Bottom} className="!bg-emerald-400 !w-2.5 !h-2.5" />
    </div>
  );
};
