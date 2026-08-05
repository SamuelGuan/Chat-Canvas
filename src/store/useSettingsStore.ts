/**
 * src/store/useSettingsStore.ts
 * 应用设置：多服务商独立配置 / 模型 / 主题 / 上下文深度 / 回溯策略 / 全局 system prompt。
 * v0.3: +globalSystemPrompt (D-06) +contextStrategy (D-04)。
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { ProviderConfig, ProviderModel, AppSettings, ContextStrategy } from '@/types';
import { secureSet } from '@/hooks/useElectron';

const DEFAULT_PROVIDERS: ProviderConfig[] = [
  { id: 'deepseek', name: 'DeepSeek', apiKey: '', baseURL: 'https://api.deepseek.com/v1', models: [{ id: 'deepseek-v4-flash', label: 'DeepSeek · V4 Flash（默认）' }, { id: 'deepseek-v4-pro', label: 'DeepSeek · V4 Pro（最强）' }], isEnabled: true, description: '1M上下文, V4 Flash性价比最高', getKeyUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'moonshot', name: 'Kimi (Moonshot)', apiKey: '', baseURL: 'https://api.moonshot.cn/v1', models: [{ id: 'kimi-k3', label: 'Kimi · K3（旗舰，1M上下文）' }, { id: 'kimi-k2.6', label: 'Kimi · K2.6（轻量）' }], isEnabled: true, description: 'K3 旗舰模型，1M上下文', getKeyUrl: 'https://platform.moonshot.cn/console/api-keys' },
  { id: 'glm', name: '智谱 GLM', apiKey: '', baseURL: 'https://api.z.ai/api/paas/v4', models: [{ id: 'glm-5.2', label: 'GLM · 5.2（旗舰，1M上下文）' }, { id: 'glm-5.1', label: 'GLM · 5.1（Coding增强）' }], isEnabled: true, description: 'GLM-5.2 旗舰，MIT开源', getKeyUrl: 'https://open.bigmodel.cn/usercenter/apikeys' },
];

function getDefaultSettings(): AppSettings {
  const first = DEFAULT_PROVIDERS[0];
  return {
    providers: DEFAULT_PROVIDERS,
    activeProviderId: first.id,
    defaultModel: first.models[0].id,
    theme: 'system',
    contextDepth: 5,
    contextStrategy: 'last',
    globalSystemPrompt: '',
    sidebarScale: 1,
  };
}

interface SettingsState extends AppSettings {
  updateProvider: (id: string, patch: Partial<ProviderConfig>) => void;
  addProvider: (p: ProviderConfig) => void;
  removeProvider: (id: string) => void;
  setActiveProvider: (id: string) => void;
  setDefaultModel: (model: string) => void;
  setTheme: (theme: 'light' | 'dark' | 'system') => void;
  setContextDepth: (depth: number | 'root') => void;
  setContextStrategy: (s: ContextStrategy) => void;
  setGlobalSystemPrompt: (p: string) => void;
  setSidebarScale: (v: number) => void;
  resetSettings: () => void;
  getActiveProvider: () => ProviderConfig | undefined;
  getProviderByModel: (modelId: string) => ProviderConfig | undefined;
  initialize: () => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      ...getDefaultSettings(),

      updateProvider: (id, patch) =>
        set((s) => ({
          providers: s.providers.map((p) => {
            if (p.id !== id) return p;
            const updated = { ...p, ...patch };
            if (patch.apiKey !== undefined) secureSet(`apikey_${p.id}`, patch.apiKey);
            return updated;
          }),
        })),

      addProvider: (p) => set((s) => ({ providers: [...s.providers, p] })),
      removeProvider: (id) => set((s) => ({ providers: s.providers.filter((p) => p.id !== id), activeProviderId: s.activeProviderId === id ? s.providers.find((x) => x.id !== id)?.id ?? '' : s.activeProviderId })),
      setActiveProvider: (id) => set({ activeProviderId: id }),
      setDefaultModel: (model) => set({ defaultModel: model }),
      setTheme: (theme) => { set({ theme }); applyTheme(theme); },
      setContextDepth: (depth) => set({ contextDepth: depth }),
      setContextStrategy: (s) => set({ contextStrategy: s }),
      setGlobalSystemPrompt: (p) => set({ globalSystemPrompt: p }),
      setSidebarScale: (v) => set({ sidebarScale: v }),
      resetSettings: () => set({ ...getDefaultSettings() }),
      getActiveProvider: () => get().providers.find((p) => p.id === get().activeProviderId),
      getProviderByModel: (modelId) => get().providers.find((p) => p.isEnabled && p.models.some((m) => m.id === modelId)),
      initialize: () => { applyTheme(get().theme); },
    }),
    {
      name: 'chat-canvas-settings',
      storage: createJSONStorage(() => localStorage),
      version: 2,
      migrate: (persisted: any, version) => {
        // v1 -> v2: 移除 'depth' 回溯策略，旧值归并为 'full'
        if (version < 2 && persisted?.contextStrategy === 'depth') {
          persisted.contextStrategy = 'full';
        }
        if (version === 0) {
          // v0 -> v1: 更新 2026年7月 过时的模型名称
          const MODEL_MAP: Record<string, { id: string; label: string }> = {
            'deepseek-chat':    { id: 'deepseek-v4-flash', label: 'DeepSeek · V4 Flash（默认）' },
            'deepseek-reasoner':{ id: 'deepseek-v4-pro',   label: 'DeepSeek · V4 Pro（最强）' },
            'moonshot-v1-8k':   { id: 'kimi-k3',            label: 'Kimi · K3（旗舰，1M上下文）' },
            'moonshot-v1-128k': { id: 'kimi-k2.6',          label: 'Kimi · K2.6（轻量）' },
            'glm-4-flash':      { id: 'glm-5.2',            label: 'GLM · 5.2（旗舰，1M上下文）' },
            'glm-4-plus':       { id: 'glm-5.1',            label: 'GLM · 5.1（Coding增强）' },
          };
          if (persisted.providers) {
            persisted.providers = persisted.providers.map((p: any) => {
              if (p.id === 'deepseek') {
                p.description = '1M上下文, V4 Flash性价比最高';
              } else if (p.id === 'moonshot') {
                p.description = 'K3 旗舰模型，1M上下文';
              } else if (p.id === 'glm') {
                p.baseURL = 'https://api.z.ai/api/paas/v4';
                p.description = 'GLM-5.2 旗舰，MIT开源';
              }
              p.models = (p.models || []).map((m: any) => MODEL_MAP[m.id] ?? m);
              return p;
            });
          }
          // 更新 defaultModel
          if (persisted.defaultModel && MODEL_MAP[persisted.defaultModel]) {
            persisted.defaultModel = MODEL_MAP[persisted.defaultModel].id;
          }
        }
        return persisted;
      },
      partialize: (state) => ({
        providers: state.providers.map((p) => ({ ...p, apiKey: '' })),
        activeProviderId: state.activeProviderId,
        defaultModel: state.defaultModel,
        theme: state.theme,
        contextDepth: state.contextDepth,
        contextStrategy: state.contextStrategy,
        globalSystemPrompt: state.globalSystemPrompt,
        sidebarScale: state.sidebarScale,
      }),
    }
  )
);

function applyTheme(theme: 'light' | 'dark' | 'system') {
  const root = document.documentElement;
  const isDark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  root.classList.toggle('dark', isDark);
}
