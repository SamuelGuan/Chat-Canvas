/**
 * scripts/checkData.ts
 * 一致性校验独立 CLI（npm run check-data）。
 * 外部进程（agent / Python sidecar）直接改文件后手动触发收敛 —— "多写者"模式的安全网。
 * 校验逻辑与应用启动自愈 / 文件监听同源（src/lib/storage/consistency.ts）。
 */
import { ensureDataRoot, resolveDataRoot } from './storeCore';
import { createNodeFsAdapter } from './nodeFsAdapter';
import { reconcileData, type ReconcileReport } from '../src/lib/storage/consistency';

function printReport(report: ReconcileReport): void {
  const rows: Array<[string, string[]]> = [
    ['从索引剔除的项目（磁盘已丢）', report.projectsRemoved],
    ['收录进索引的项目（外部拷入）', report.projectsAdded],
    ['剔除的 Session 登记（文件已丢）', report.sessionsRemoved],
    ['收录的 Session（未登记）', report.sessionsAdded],
    ['归拢到 proj_imported 的孤儿 Session', report.sessionsMoved],
    ['补回固定项目 / pinned', report.pinnedFixed],
    ['重建元信息缓存的 Session', report.metaRebuilt],
  ];
  let total = 0;
  for (const [label, items] of rows) {
    total += items.length;
    if (items.length > 0) console.log(`  ${label}: ${items.join(', ')}`);
  }
  console.log(total === 0 ? 'check-data: 索引与磁盘一致，无需收敛' : `check-data: 收敛完成，共处理 ${total} 项`);
}

async function main(): Promise<void> {
  const dataRoot = resolveDataRoot(process.cwd());
  ensureDataRoot(dataRoot);
  const report = await reconcileData(createNodeFsAdapter(dataRoot));
  printReport(report);
}

main().catch((e) => {
  console.error('check-data: 校验失败', e);
  process.exit(1);
});
