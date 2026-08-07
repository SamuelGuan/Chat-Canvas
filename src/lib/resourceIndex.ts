import type {
  AssetIndexEntry,
  AssetIndexRef,
  GraphNode,
  NodeResourceField,
  NodeResourceKind,
  NodeResourceRef,
  SessionData,
} from '../types';

const ASSET_PATH_RE = /^projects\/[^/]+\/assets\/[^?#]+$/i;
const MARKDOWN_IMAGE_RE = /!\[[^\]]*]\((<[^>]+>|[^)\s]+)(?:\s+["'][^"']*["'])?\)/g;

function uniqRefs(refs: NodeResourceRef[]): NodeResourceRef[] {
  const map = new Map<string, NodeResourceRef>();
  for (const ref of refs) {
    map.set(`${ref.kind}|${ref.field}|${ref.path}`, ref);
  }
  return [...map.values()];
}

export function isAssetPath(path: string | undefined | null): path is string {
  return !!path && ASSET_PATH_RE.test(path);
}

export function extractMarkdownAssetPaths(markdown: string | undefined): string[] {
  if (!markdown) return [];
  const paths: string[] = [];
  let match: RegExpExecArray | null = null;
  while ((match = MARKDOWN_IMAGE_RE.exec(markdown)) !== null) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    const path = raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw;
    if (isAssetPath(path)) paths.push(path);
  }
  return [...new Set(paths)];
}

export function buildNodeResourceRefs(node: GraphNode): NodeResourceRef[] {
  const refs: NodeResourceRef[] = [];
  if (isAssetPath(node.pdfPath)) {
    refs.push({ path: node.pdfPath, kind: 'pdf', field: 'pdfPath' });
  }
  if (isAssetPath(node.picturePath)) {
    refs.push({ path: node.picturePath, kind: 'image', field: 'picturePath' });
  }
  for (const path of extractMarkdownAssetPaths(node.markdownContent)) {
    refs.push({ path, kind: 'image', field: 'markdownContent' });
  }
  return uniqRefs(refs);
}

export function sameResourceRefs(a: NodeResourceRef[] | undefined, b: NodeResourceRef[] | undefined): boolean {
  const left = uniqRefs(a ?? []).map((ref) => `${ref.kind}|${ref.field}|${ref.path}`).sort();
  const right = uniqRefs(b ?? []).map((ref) => `${ref.kind}|${ref.field}|${ref.path}`).sort();
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

export function toAssetIndexRef(sessionId: string, nodeId: string, ref: NodeResourceRef): AssetIndexRef {
  return { ...ref, sessionId, nodeId };
}

export function buildProjectAssetIndex(sessions: SessionData[]): {
  assetIndex: Record<string, AssetIndexEntry>;
  normalizedSessions: SessionData[];
} {
  const assetIndex: Record<string, AssetIndexEntry> = {};
  const normalizedSessions = sessions.map((session) => {
    const nextNodes = { ...session.nodes };
    let changed = false;
    for (const [nodeId, node] of Object.entries(session.nodes)) {
      const refs = buildNodeResourceRefs(node);
      if (!sameResourceRefs(node.resourceRefs, refs)) {
        nextNodes[nodeId] = { ...node, resourceRefs: refs };
        changed = true;
      }
      for (const ref of refs) {
        assetIndex[ref.path] ??= { path: ref.path, refs: [] };
        assetIndex[ref.path].refs.push(toAssetIndexRef(session.id, nodeId, ref));
      }
    }
    return changed ? { ...session, nodes: nextNodes } : session;
  });
  return { assetIndex, normalizedSessions };
}

export function refsFromAssetIndexEntry(entry: AssetIndexEntry | undefined): NodeResourceRef[] {
  if (!entry) return [];
  return entry.refs.map((ref) => ({ path: ref.path, kind: ref.kind as NodeResourceKind, field: ref.field as NodeResourceField }));
}
