/**
 * src/store/useSettingsStore.ts
 * 应用设置：多服务商独立配置 / 模型 / 主题 / 上下文深度 / 回溯策略 / 全局 system prompt。
 * v0.3: +globalSystemPrompt (D-06) +contextStrategy (D-04)。
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { ProviderConfig, ProviderModel, AppSettings, ContextStrategy, ReasoningEffort } from '@/types';
import { secureSet } from '@/hooks/useElectron';

const BUILTIN_MODEL_MAP: Record<string, { id: string; label: string }> = {
  'deepseek-chat': { id: 'deepseek-v4-flash', label: 'DeepSeek · V4 Flash（默认）' },
  'deepseek-reasoner': { id: 'deepseek-v4-pro', label: 'DeepSeek · V4 Pro（最强）' },
  'moonshot-v1-8k': { id: 'kimi-k3', label: 'Kimi · K3（旗舰，1M上下文）' },
  'moonshot-v1-128k': { id: 'kimi-k2.6', label: 'Kimi · K2.6（轻量）' },
  'glm-4-flash': { id: 'glm-5.2', label: 'GLM · 5.2（旗舰，1M上下文）' },
  'glm-4-plus': { id: 'glm-5.1', label: 'GLM · 5.1（Coding增强）' },
  'gpt-5': { id: 'gpt-5.6-sol', label: 'GPT · 5.6 Sol（旗舰）' },
  'gpt-5-mini': { id: 'gpt-5.6-luna', label: 'GPT · 5.6 Luna（轻量）' },
  'gpt-4.1': { id: 'gpt-5.6-terra', label: 'GPT · 5.6 Terra（均衡）' },
  'claude-sonnet-4-20250514': { id: 'claude-fable-5', label: 'Claude · Fable 5（旗舰）' },
  'claude-opus-4-20250514': { id: 'claude-fable-5', label: 'Claude · Fable 5（旗舰）' },
  'claude-3-5-haiku-20241022': { id: 'claude-fable-5', label: 'Claude · Fable 5（旗舰）' },
};

export function normalizeBuiltinModelId(modelId: string): string {
  return BUILTIN_MODEL_MAP[modelId]?.id ?? modelId;
}

const DEFAULT_PROVIDERS: ProviderConfig[] = [
  { id: 'deepseek', name: 'DeepSeek', apiKey: '', baseURL: 'https://api.deepseek.com/v1', models: [{ id: 'deepseek-v4-flash', label: 'DeepSeek · V4 Flash（默认）' }, { id: 'deepseek-v4-pro', label: 'DeepSeek · V4 Pro（最强）' }], isEnabled: true, description: '1M上下文, V4 Flash性价比最高', getKeyUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'moonshot', name: 'Kimi (Moonshot)', apiKey: '', baseURL: 'https://api.moonshot.cn/v1', models: [{ id: 'kimi-k3', label: 'Kimi · K3（旗舰，1M上下文）' }, { id: 'kimi-k2.6', label: 'Kimi · K2.6（轻量）' }], isEnabled: true, description: 'K3 旗舰模型，1M上下文', getKeyUrl: 'https://platform.moonshot.cn/console/api-keys' },
  { id: 'glm', name: '智谱 GLM', apiKey: '', baseURL: 'https://api.z.ai/api/paas/v4', models: [{ id: 'glm-5.2', label: 'GLM · 5.2（旗舰，1M上下文）' }, { id: 'glm-5.1', label: 'GLM · 5.1（Coding增强）' }], isEnabled: true, description: 'GLM-5.2 旗舰，MIT开源', getKeyUrl: 'https://open.bigmodel.cn/usercenter/apikeys' },
  { id: 'openai', name: 'OpenAI GPT', apiKey: '', baseURL: 'https://api.openai.com/v1', models: [{ id: 'gpt-5.6-sol', label: 'GPT · 5.6 Sol（旗舰）' }, { id: 'gpt-5.6-terra', label: 'GPT · 5.6 Terra（均衡）' }, { id: 'gpt-5.6-luna', label: 'GPT · 5.6 Luna（轻量）' }], isEnabled: true, description: 'OpenAI 官方 GPT 5.6 接口', getKeyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'anthropic', name: 'Claude', apiKey: '', baseURL: 'https://api.anthropic.com/v1', models: [{ id: 'claude-fable-5', label: 'Claude · Fable 5（旗舰）' }], isEnabled: true, description: 'Anthropic 官方 Claude Fable 5 接口', getKeyUrl: 'https://console.anthropic.com/settings/keys' },
];

function mergeProvidersWithDefaults(providers?: ProviderConfig[]): ProviderConfig[] {
  const existingMap = new Map((providers ?? []).map((provider) => [provider.id, provider]));
  const mergedDefaults = DEFAULT_PROVIDERS.map((provider) => {
    const existing = existingMap.get(provider.id);
    if (!existing) return provider;
    return {
      ...provider,
      ...existing,
      models: existing.models?.length ? existing.models : provider.models,
    };
  });
  const customProviders = (providers ?? []).filter((provider) => !DEFAULT_PROVIDERS.some((builtin) => builtin.id === provider.id));
  return [...mergedDefaults, ...customProviders];
}

function getDefaultSettings(): AppSettings {
  const first = DEFAULT_PROVIDERS[0];
  return {
    providers: DEFAULT_PROVIDERS,
    activeProviderId: first.id,
    defaultModel: first.models[0].id,
    reasoningEffort: 'high',
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
  setReasoningEffort: (effort: ReasoningEffort) => void;
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
      setDefaultModel: (model) => set({ defaultModel: normalizeBuiltinModelId(model) }),
      setReasoningEffort: (effort) => set({ reasoningEffort: effort }),
      setTheme: (theme) => { set({ theme }); applyTheme(theme); },
      setContextDepth: (depth) => set({ contextDepth: depth }),
      setContextStrategy: (s) => set({ contextStrategy: s }),
      setGlobalSystemPrompt: (p) => set({ globalSystemPrompt: p }),
      setSidebarScale: (v) => set({ sidebarScale: v }),
      resetSettings: () => set({ ...getDefaultSettings() }),
      getActiveProvider: () => get().providers.find((p) => p.id === get().activeProviderId),
      getProviderByModel: (modelId) => {
        const normalized = normalizeBuiltinModelId(modelId);
        return get().providers.find((p) => p.isEnabled && p.models.some((m) => m.id === normalized));
      },
      initialize: () => { applyTheme(get().theme); },
    }),
    {
      name: 'chat-canvas-settings',
      storage: createJSONStorage(() => localStorage),
      version: 5,
      migrate: (persisted: any, version) => {
        persisted = persisted ?? {};
        // v1 -> v2: 移除 'depth' 回溯策略，旧值归并为 'full'
        if (version < 2 && persisted?.contextStrategy === 'depth') {
          persisted.contextStrategy = 'full';
        }
        if (version === 0) {
          // v0 -> v1: 更新 2026年7月 过时的模型名称
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
              p.models = (p.models || []).map((m: any) => BUILTIN_MODEL_MAP[m.id] ?? m);
              return p;
            });
          }
          // 更新 defaultModel
          if (persisted.defaultModel && BUILTIN_MODEL_MAP[persisted.defaultModel]) {
            persisted.defaultModel = BUILTIN_MODEL_MAP[persisted.defaultModel].id;
          }
        }
        if (version < 4) {
          if (persisted.providers) {
            persisted.providers = persisted.providers.map((p: any) => ({
              ...p,
              models: (p.models || []).map((m: any) => BUILTIN_MODEL_MAP[m.id] ?? m),
            }));
          }
          if (persisted.defaultModel) {
            persisted.defaultModel = normalizeBuiltinModelId(persisted.defaultModel);
          }
        }
        if (version < 5 && !persisted.reasoningEffort) {
          persisted.reasoningEffort = 'high';
        }
        persisted.providers = mergeProvidersWithDefaults(persisted?.providers);
        const enabledProviders = persisted.providers.filter((p: ProviderConfig) => p.isEnabled);
        if (!enabledProviders.some((p: ProviderConfig) => p.id === persisted.activeProviderId)) {
          persisted.activeProviderId = enabledProviders[0]?.id ?? DEFAULT_PROVIDERS[0].id;
        }
        const hasDefaultModel = enabledProviders.some((p: ProviderConfig) => p.models.some((m: ProviderModel) => m.id === persisted.defaultModel));
        if (!hasDefaultModel) {
          persisted.defaultModel = enabledProviders[0]?.models[0]?.id ?? DEFAULT_PROVIDERS[0].models[0].id;
        }
        return persisted;
      },
      partialize: (state) => ({
        providers: state.providers.map((p) => ({ ...p, apiKey: '' })),
        activeProviderId: state.activeProviderId,
        defaultModel: state.defaultModel,
        reasoningEffort: state.reasoningEffort,
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
