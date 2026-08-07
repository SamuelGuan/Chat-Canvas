import type {
  ContentPart,
  GraphNode,
  SessionBundleAsset,
  SessionBundleFile,
  SessionData,
} from '@/types';

const BUNDLE_VERSION = 1;

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function isAssetPath(path: string | undefined | null): path is string {
  return !!path && /^projects\/[^/]+\/assets\/[^?#]+$/i.test(path);
}

function replaceMarkdownAssetPaths(markdown: string | undefined, pathMap: Map<string, string>): string | undefined {
  if (!markdown) return markdown;
  let next = markdown;
  for (const [from, to] of pathMap.entries()) {
    next = next.split(from).join(to);
  }
  return next;
}

function remapMessageContentAssets(content: GraphNode['messages'][number]['content'], pathMap: Map<string, string>) {
  if (typeof content === 'string') return content;
  return content.map((part) => {
    if (part.type !== 'image_url') return part;
    const nextUrl = pathMap.get(part.image_url.url) ?? part.image_url.url;
    return nextUrl === part.image_url.url
      ? part
      : { ...part, image_url: { url: nextUrl } } as ContentPart;
  });
}

export function collectSessionAssetPaths(session: SessionData): string[] {
  const paths = new Set<string>();
  for (const node of Object.values(session.nodes)) {
    for (const ref of node.resourceRefs ?? []) {
      if (isAssetPath(ref.path)) paths.add(ref.path);
    }
    for (const msg of node.messages ?? []) {
      if (typeof msg.content === 'string') continue;
      for (const part of msg.content) {
        if (part.type === 'image_url' && isAssetPath(part.image_url.url)) {
          paths.add(part.image_url.url);
        }
      }
    }
  }
  return [...paths];
}

export function buildSessionBundle(
  sessions: Record<string, SessionData>,
  assets: SessionBundleAsset[],
  activeSessionId?: string,
): SessionBundleFile {
  return {
    format: 'chat-canvas-bundle',
    version: BUNDLE_VERSION,
    sessions,
    activeSessionId,
    assets,
  };
}

export function isSessionBundleFile(data: unknown): data is SessionBundleFile {
  const bundle = data as SessionBundleFile | null;
  return !!bundle
    && bundle.format === 'chat-canvas-bundle'
    && typeof bundle.version === 'number'
    && !!bundle.sessions
    && Array.isArray(bundle.assets);
}

export function encodeBundleAsset(path: string, buffer: ArrayBuffer): SessionBundleAsset {
  return {
    path,
    dataBase64: arrayBufferToBase64(buffer),
  };
}

export function remapSessionBundleAssets(
  session: SessionData,
  pathMap: Map<string, string>,
  targetProjectId: string,
): SessionData {
  const nextNodes: Record<string, GraphNode> = {};
  for (const [nodeId, node] of Object.entries(session.nodes)) {
    const nextPdfPath = node.pdfPath ? (pathMap.get(node.pdfPath) ?? node.pdfPath) : node.pdfPath;
    const nextPicturePath = node.picturePath ? (pathMap.get(node.picturePath) ?? node.picturePath) : node.picturePath;
    const nextMarkdownContent = replaceMarkdownAssetPaths(node.markdownContent, pathMap);
    const nextMessages = (node.messages ?? []).map((msg) => ({
      ...msg,
      content: remapMessageContentAssets(msg.content, pathMap),
    }));
    const nextResourceRefs = (node.resourceRefs ?? []).map((ref) => ({
      ...ref,
      path: pathMap.get(ref.path) ?? ref.path,
    }));
    nextNodes[nodeId] = {
      ...node,
      pdfPath: nextPdfPath,
      picturePath: nextPicturePath,
      markdownContent: nextMarkdownContent,
      messages: nextMessages,
      resourceRefs: nextResourceRefs,
    };
  }
  return {
    ...session,
    projectId: targetProjectId,
    nodes: nextNodes,
  };
}
