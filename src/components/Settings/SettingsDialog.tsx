/**
 * src/components/Settings/SettingsDialog.tsx
 * 设置面板（v0.3: D-04 回溯策略 + D-06 全局 system prompt）。
 */
import { useState, useEffect } from 'react';
import { useSettingsStore, normalizeBuiltinModelId } from '@/store/useSettingsStore';
import { useCanvasStore } from '@/store/useCanvasStore';
import { useElectron } from '@/hooks/useElectron';
import { getProviderApiKind } from '@/lib/llm';
import { getReasoningCapability, REASONING_UI_OPTIONS } from '@/lib/llmReasoning';
import { cn } from '@/lib/utils';

interface Props { open: boolean; onClose: () => void; }

export function SettingsDialog({ open, onClose }: Props) {
  const settings = useSettingsStore();
  const session = useCanvasStore((s) => s.session);
  const sessions = useCanvasStore((s) => s.sessions);
  const activeSessionId = useCanvasStore((s) => s.activeSessionId);
  const importSessions = useCanvasStore((s) => s.importSessions);
  const exportSessionJson = useCanvasStore((s) => s.exportSessionJson);
  const { isElectron } = useElectron();

  const [activeTab, setActiveTab] = useState(settings.providers[0]?.id ?? 'deepseek');
  // v0.4：sessions 字典只含非激活 Session，导出下拉需合成含激活 Session 的全量视图
  const allSessions = { ...sessions, [session.id]: session };
  // 悬停按钮的说明文字（行内说明栏，避免悬浮气泡被面板裁剪）
  const [hoverTip, setHoverTip] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  // 导出目标 Session（'__all__' 表示全部；每次打开面板时重置为当前激活 Session）
  const [exportTarget, setExportTarget] = useState<string>(activeSessionId);
  useEffect(() => { if (open) setExportTarget(activeSessionId); }, [open, activeSessionId]);
  const activeProvider = settings.providers.find((p) => p.id === activeTab);
  const normalizedDefaultModel = normalizeBuiltinModelId(settings.defaultModel);
  const defaultModelProvider = settings.getProviderByModel(normalizedDefaultModel);
  const reasoningCapability = getReasoningCapability({
    baseURL: defaultModelProvider?.baseURL ?? '',
    model: normalizedDefaultModel,
    reasoningEffort: settings.reasoningEffort,
  });
  const visibleReasoningOptions = REASONING_UI_OPTIONS.filter((opt) =>
    reasoningCapability.supportedEfforts.includes(opt.value)
  );
  const supportedEffortsKey = reasoningCapability.supportedEfforts.join('|');

  useEffect(() => {
    if (!reasoningCapability.supportedEfforts.includes(settings.reasoningEffort)) {
      settings.setReasoningEffort('default');
    }
  }, [supportedEffortsKey, settings.reasoningEffort]);

  if (!open) return null;

  async function handleExport() {
    const isAll = exportTarget === '__all__';
    const json = isAll ? await exportSessionJson() : await exportSessionJson(exportTarget);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url;
    const name = isAll ? 'all' : (allSessions[exportTarget]?.name ?? 'session');
    a.download = `chat-canvas-${name}-${Date.now()}.json`;
    a.click(); URL.revokeObjectURL(url);
  }

  function handleImport() {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'application/json';
    input.onchange = async () => {
      const file = input.files?.[0]; if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        const { imported, skipped } = await importSessions(data);
        if (imported === 0) alert('导入被忽略：文件内容与现有 Session 完全相同');
        else alert(`导入成功！新增 ${imported} 个 Session${skipped > 0 ? `，忽略 ${skipped} 个内容重复的` : ''}`);
      } catch { alert('导入失败：文件格式错误'); }
    };
    input.click();
  }

  async function handleTest() {
    if (!activeProvider?.apiKey) { alert('请先填写 API Key'); return; }
    setTestStatus('testing');
    try {
      let url = activeProvider.baseURL.trim().replace(/\/$/, '');
      const apiKind = getProviderApiKind(url);
      if (!url.endsWith('/v1')) {
        url += '/v1';
      }
      const headers: Record<string, string> = apiKind === 'anthropic'
        ? {
            'x-api-key': activeProvider.apiKey,
            'anthropic-version': '2023-06-01',
          }
        : {
            Authorization: `Bearer ${activeProvider.apiKey}`,
          };
      const resp = await fetch(`${url}/models`, { headers });
      setTestStatus(resp.ok ? 'ok' : 'fail');
    } catch { setTestStatus('fail'); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={onClose}>
      <div className="w-[560px] max-h-[85vh] overflow-y-auto rounded-xl border shadow-xl bg-white border-zinc-200 dark:bg-zinc-900 dark:border-zinc-700" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b px-5 py-3 border-zinc-200 dark:border-zinc-700">
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">设置</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200">✕</button>
        </div>
        <div className="flex border-b border-zinc-200 dark:border-zinc-700">
          {settings.providers.map((p) => (
            <button key={p.id} onClick={() => { setActiveTab(p.id); setTestStatus('idle'); }} className={cn('flex-1 px-3 py-2 text-xs font-medium transition-colors border-b-2 -mb-px', activeTab === p.id ? 'border-zinc-900 text-zinc-900 dark:border-zinc-100 dark:text-zinc-100' : 'border-transparent text-zinc-400 hover:text-zinc-600')}>{p.name}</button>
          ))}
        </div>
        <div className="space-y-6 px-5 py-4">
          {activeProvider && (<>
            <section>
              <h3 className="mb-3 text-sm font-medium text-zinc-700 dark:text-zinc-300">{activeProvider.name} · API Key {isElectron && <span className="ml-2 text-[10px] text-green-500">(已加密存储)</span>}
                {activeProvider.getKeyUrl && <a href={activeProvider.getKeyUrl} target="_blank" rel="noreferrer" className="ml-2 text-[10px] text-blue-500 hover:underline">获取 Key →</a>}
              </h3>
              <div className="flex gap-2">
                <input type={showKey ? 'text' : 'password'} value={activeProvider.apiKey} onChange={(e) => settings.updateProvider(activeProvider.id, { apiKey: e.target.value })} placeholder="粘贴 API Key（sk-...）" className="flex-1 rounded-lg border px-3 py-2 text-sm outline-none border-zinc-200 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100" />
                <button onClick={() => setShowKey(!showKey)} className="rounded-lg border border-zinc-200 dark:border-zinc-600 px-2 text-xs text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-700">{showKey ? '隐藏' : '显示'}</button>
                <button onClick={handleTest} className={cn('rounded-lg px-3 py-1.5 text-xs font-medium transition-colors shrink-0', testStatus === 'testing' && 'bg-zinc-200 text-zinc-500', testStatus === 'ok' && 'bg-green-100 text-green-700', testStatus === 'fail' && 'bg-red-100 text-red-700', testStatus === 'idle' && 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300')}>{testStatus === 'testing' ? '测试中...' : testStatus === 'ok' ? '✓ 连接成功' : testStatus === 'fail' ? '✗ 连接失败' : '测试连接'}</button>
              </div>
            </section>
            <section>
              <h3 className="mb-3 text-sm font-medium text-zinc-700 dark:text-zinc-300">API 地址</h3>
              <input value={activeProvider.baseURL} onChange={(e) => settings.updateProvider(activeProvider.id, { baseURL: e.target.value })} className="w-full rounded-lg border px-3 py-2 text-sm outline-none border-zinc-200 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100" />
            </section>
          </>)}

          {/* ★ D-06: 全局 System Prompt */}
          <section>
            <h3 className="mb-3 text-sm font-medium text-zinc-700 dark:text-zinc-300">全局系统提示 (System Prompt)</h3>
            <textarea value={settings.globalSystemPrompt} onChange={(e) => settings.setGlobalSystemPrompt(e.target.value)} rows={3} placeholder="所有卡片的默认角色设定，如：'你是一位资深AI研究员，回答要严谨...'" className="w-full resize-none rounded-lg border px-3 py-2 text-sm outline-none border-zinc-200 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100" />
            <p className="mt-1 text-[10px] text-zinc-400">卡片标题栏的齿轮按钮可设置单卡覆盖</p>
          </section>

          <section>
            <h3 className="mb-3 text-sm font-medium text-zinc-700 dark:text-zinc-300">默认模型</h3>
            <select value={normalizedDefaultModel} onChange={(e) => settings.setDefaultModel(e.target.value)} className="w-full rounded-lg border px-3 py-2 text-sm outline-none border-zinc-200 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100">
              {settings.providers.filter((p) => p.isEnabled).map((p) => (<optgroup key={p.id} label={p.name}>{p.models.map((m) => (<option key={m.id} value={m.id}>{p.name} · {m.label}</option>))}</optgroup>))}
            </select>
          </section>

          <section>
            <h3 className="mb-3 text-sm font-medium text-zinc-700 dark:text-zinc-300">思考强度</h3>
            <div className="flex gap-2 flex-wrap">
              {visibleReasoningOptions.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => settings.setReasoningEffort(opt.value)}
                  onMouseEnter={() => setHoverTip(opt.tip)}
                  onMouseLeave={() => setHoverTip(null)}
                  onFocus={() => setHoverTip(opt.tip)}
                  onBlur={() => setHoverTip(null)}
                  className={cn('rounded-lg px-3 py-1.5 text-xs font-medium transition-colors', settings.reasoningEffort === opt.value ? 'bg-[#D97757] text-white dark:bg-zinc-100 dark:text-zinc-900' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400')}
                >{opt.label}</button>
              ))}
            </div>
            <p className={cn('mt-2 min-h-[28px] rounded-md bg-zinc-50 dark:bg-zinc-800/60 px-2 py-1.5 text-[11px] leading-relaxed transition-colors', hoverTip ? 'text-zinc-600 dark:text-zinc-300' : 'text-zinc-400')}>
              {hoverTip ?? reasoningCapability.note}
            </p>
          </section>

          {/* ★ D-04: 上下文回溯策略 */}
          <section>
            <h3 className="mb-3 text-sm font-medium text-zinc-700 dark:text-zinc-300">上下文回溯策略</h3>
            <div className="flex gap-2">
              {([
                { value: 'last' as const, label: '仅最后一条', tip: '每张上游卡片只把最后一条 AI 回复发给当前卡片作为参考。最省 token，适合上游内容很长、只需要结论的场景' },
                { value: 'full' as const, label: '完整多轮', tip: '把上游卡片的全部问答记录都发给当前卡片，并一直追溯到根卡片。上下文最完整，但消耗的 token 最多' },
              ]).map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => settings.setContextStrategy(opt.value)}
                  onMouseEnter={() => setHoverTip(opt.tip)}
                  onMouseLeave={() => setHoverTip(null)}
                  onFocus={() => setHoverTip(opt.tip)}
                  onBlur={() => setHoverTip(null)}
                  className={cn('rounded-lg px-3 py-1.5 text-xs font-medium transition-colors', settings.contextStrategy === opt.value ? 'bg-[#D97757] text-white dark:bg-zinc-100 dark:text-zinc-900' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400')}
                >{opt.label}</button>
              ))}
            </div>
            {/* 行内说明栏：固定高度避免布局抖动，悬停按钮时显示其作用 */}
            <p className={cn('mt-2 min-h-[28px] rounded-md bg-zinc-50 dark:bg-zinc-800/60 px-2 py-1.5 text-[11px] leading-relaxed transition-colors', hoverTip ? 'text-zinc-600 dark:text-zinc-300' : 'text-zinc-400')}>
              {hoverTip ?? '将鼠标悬停在上方按钮上，可查看该策略的作用说明'}
            </p>
          </section>

          <section>
            <h3 className="mb-3 text-sm font-medium text-zinc-700 dark:text-zinc-300">上下文回溯深度</h3>
            <div className="flex gap-2">
              {([
                { value: 1 as const, label: '仅直接上游', tip: '只把与当前卡片直接相连（隔 1 条连线）的上游卡片内容发给 AI，更上游的不纳入' },
                { value: 3 as const, label: '3 层', tip: '沿连线向上追溯最多 3 层卡片：直接上游、上游的上游、再上一层，第 4 层起不纳入' },
                { value: 5 as const, label: '5 层（默认）', tip: '沿连线向上追溯最多 5 层卡片。适合大多数分支链不太深的场景，兼顾上下文与 token 消耗' },
                { value: 'root' as const, label: '追溯到根节点', tip: '不限层数，沿连线一直向上追溯到最顶端的根卡片，链上所有上游卡片内容都会发给 AI' },
              ]).map((opt) => (
                <button
                  key={String(opt.value)}
                  onClick={() => settings.setContextDepth(opt.value)}
                  onMouseEnter={() => setHoverTip(opt.tip)}
                  onMouseLeave={() => setHoverTip(null)}
                  onFocus={() => setHoverTip(opt.tip)}
                  onBlur={() => setHoverTip(null)}
                  className={cn('rounded-lg px-3 py-1.5 text-xs font-medium transition-colors', settings.contextDepth === opt.value ? 'bg-[#D97757] text-white dark:bg-zinc-100 dark:text-zinc-900' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400')}
                >{opt.label}</button>
              ))}
            </div>
            {/* 行内说明栏：固定高度避免布局抖动，悬停按钮时显示其作用 */}
            <p className={cn('mt-2 min-h-[28px] rounded-md bg-zinc-50 dark:bg-zinc-800/60 px-2 py-1.5 text-[11px] leading-relaxed transition-colors', hoverTip ? 'text-zinc-600 dark:text-zinc-300' : 'text-zinc-400')}>
              {hoverTip ?? '将鼠标悬停在上方按钮上，可查看该深度的作用说明'}
            </p>
            <p className="mt-1 text-[10px] text-zinc-400">仅对「仅最后一条」策略生效；「完整多轮」始终追溯到根卡片</p>
          </section>

          {/* 侧边栏缩放：仅放大侧边栏，不影响画布 */}
          <section>
            <h3 className="mb-3 text-sm font-medium text-zinc-700 dark:text-zinc-300">侧边栏缩放</h3>
            <div className="flex gap-2 flex-wrap">
              {([0.8, 1, 1.25, 1.5, 1.75, 2] as const).map((v) => (
                <button key={v} onClick={() => settings.setSidebarScale(v)} className={cn('rounded-lg px-3 py-1.5 text-xs font-medium transition-colors', settings.sidebarScale === v ? 'bg-[#D97757] text-white dark:bg-zinc-100 dark:text-zinc-900' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400')}>{Math.round(v * 100)}%</button>
              ))}
            </div>
            <p className="mt-1 text-[10px] text-zinc-400">大屏显示器可调大，仅影响侧边栏，画布不受影响</p>
          </section>

          <section>
            <h3 className="mb-3 text-sm font-medium text-zinc-700 dark:text-zinc-300">主题</h3>
            <div className="flex gap-2">
              {(['light', 'dark', 'system'] as const).map((t) => (<button key={t} onClick={() => settings.setTheme(t)} className={cn('rounded-lg px-3 py-1.5 text-xs font-medium transition-colors', settings.theme === t ? 'bg-[#D97757] text-white dark:bg-zinc-100 dark:text-zinc-900' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400')}>{t === 'light' ? '浅色' : t === 'dark' ? '暗色' : '跟随系统'}</button>))}
            </div>
          </section>

          <section>
            <h3 className="mb-3 text-sm font-medium text-zinc-700 dark:text-zinc-300">数据管理</h3>
            {/* 先选择要导出的 Session，再点击导出 */}
            <div className="flex gap-2 items-center">
              <select value={exportTarget} onChange={(e) => setExportTarget(e.target.value)} className="flex-1 rounded-lg border px-3 py-1.5 text-xs outline-none border-zinc-200 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100" title="选择要导出的 Session">
                {Object.values(allSessions).map((s) => (<option key={s.id} value={s.id}>{s.name}</option>))}
                <option value="__all__">全部 Sessions</option>
              </select>
              <button onClick={handleExport} className="rounded-lg bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 shrink-0">导出 Bundle</button>
              <button onClick={handleImport} className="rounded-lg bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 shrink-0">导入 Bundle</button>
            </div>
            <p className="mt-1 text-[10px] text-zinc-400">导出所选 Session 的全部卡片、聊天记录、连线与相关资源；「全部 Sessions」为完整备份</p>
          </section>

          <section>
            <h3 className="mb-3 text-sm font-medium text-zinc-700 dark:text-zinc-300">快捷键</h3>
            <div className="grid grid-cols-2 gap-2 text-xs text-zinc-500">
              <div>双击画布</div><div>新建卡片</div><div>Enter</div><div>发送消息</div><div>Shift+Enter</div><div>换行</div><div>Delete / Backspace</div><div>删除选中</div><div>Cmd/Ctrl+Z</div><div>撤销</div><div>Cmd/Ctrl+Shift+Z</div><div>重做</div><div>Cmd/Ctrl+C</div><div>复制卡片</div><div>Cmd/Ctrl+V</div><div>粘贴卡片</div><div>Cmd/Ctrl+K</div><div>搜索</div><div>Cmd/Ctrl+S</div><div>导出 JSON</div><div>Cmd/Ctrl+,</div><div>打开设置</div>
            </div>
          </section>

          <section className="rounded-lg bg-blue-50 dark:bg-blue-900/20 px-3 py-2">
            <p className="text-[11px] text-blue-600 dark:text-blue-400">快速开始：选择服务商 → 去官网领免费 Key → 粘贴 → 测试连接 → 回到画布开始对话</p>
          </section>
        </div>
      </div>
    </div>
  );
}
