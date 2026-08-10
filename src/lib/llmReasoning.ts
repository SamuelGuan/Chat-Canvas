import { ReasoningEffort } from '@/types';

type EffectiveReasoningEffort = Exclude<ReasoningEffort, 'default'>;

export type ReasoningProviderFamily =
  | 'openai'
  | 'anthropic'
  | 'deepseek'
  | 'moonshot'
  | 'glm'
  | 'generic';

export interface ReasoningRouteInput {
  baseURL: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
}

export interface ReasoningRouteResult {
  provider: ReasoningProviderFamily;
  bodyPatch: Record<string, unknown>;
  omitTemperature?: boolean;
}

export interface ReasoningCapability {
  provider: ReasoningProviderFamily;
  supportedEfforts: ReasoningEffort[];
  note: string;
}

export interface ReasoningUiOption {
  value: ReasoningEffort;
  label: string;
  tip: string;
}

export const REASONING_UI_OPTIONS: ReasoningUiOption[] = [
  { value: 'default', label: '跟随默认', tip: '不额外指定思考强度，完全使用模型自身默认值。适合先观察各模型原生表现。' },
  { value: 'low', label: '低', tip: '更快、更省 token，适合闲聊、改写、摘要、轻量问答。' },
  { value: 'medium', label: '中', tip: '速度、成本、质量较均衡，适合大多数日常任务。' },
  { value: 'high', label: '高（推荐）', tip: '更重视质量与稳定性，适合编码、分析、复杂多步问题。' },
  { value: 'xhigh', label: '极高', tip: '用于更难的代码与长链路任务，延迟和 token 消耗会明显上升。' },
  { value: 'max', label: '最大', tip: '尽可能拉满思考深度，只建议给最难、最贵也最慢的任务使用。' },
];

export function routeReasoningConfig(input: ReasoningRouteInput): ReasoningRouteResult {
  const provider = detectReasoningProvider(input);

  switch (provider) {
    case 'anthropic':
      return routeAnthropicReasoning(input);
    case 'deepseek':
      return routeDeepSeekReasoning(input);
    case 'moonshot':
      return routeMoonshotReasoning(input);
    case 'glm':
      return routeGlmReasoning(input);
    case 'openai':
      return routeOpenAIReasoning(input);
    default:
      return { provider, bodyPatch: {} };
  }
}

export function getReasoningCapability(input: ReasoningRouteInput): ReasoningCapability {
  const provider = detectReasoningProvider(input);
  const model = input.model.toLowerCase();

  switch (provider) {
    case 'openai':
      return {
        provider,
        supportedEfforts: ['default', 'low', 'medium', 'high', 'xhigh', 'max'],
        note: 'GPT 5.6 支持完整思考强度梯度，会通过 reasoning_effort 下发。',
      };
    case 'anthropic':
      return {
        provider,
        supportedEfforts: ['default', 'low', 'medium', 'high', 'xhigh', 'max'],
        note: 'Claude Fable 5 支持完整思考强度梯度，会通过 output_config.effort 下发。',
      };
    case 'deepseek':
      return {
        provider,
        supportedEfforts: ['default', 'high', 'max'],
        note: 'DeepSeek V4 原生只区分 High / Max 两档；界面因此只展示这两档。',
      };
    case 'moonshot':
      if (model.startsWith('kimi-k3')) {
        return {
          provider,
          supportedEfforts: ['default', 'low', 'high', 'max'],
          note: 'Kimi K3 支持 low / high / max 三档 reasoning_effort。',
        };
      }
      if (model.startsWith('kimi-k2.6')) {
        return {
          provider,
          supportedEfforts: ['default'],
          note: 'Kimi K2.6 用 thinking 开关控制思考模式，不支持独立强度档位。',
        };
      }
      return {
        provider,
        supportedEfforts: ['default'],
        note: '当前 Kimi 模型不支持独立思考强度档位，将跟随模型默认行为。',
      };
    case 'glm':
      if (supportsGlmReasoningEffort(model)) {
        return {
          provider,
          supportedEfforts: ['default', 'low', 'medium', 'high', 'xhigh', 'max'],
          note: 'GLM 5.2+ 支持 reasoning_effort 梯度，会自动附带 thinking.type=enabled。',
        };
      }
      return {
        provider,
        supportedEfforts: ['default'],
        note: 'GLM 5.1 不支持 reasoning_effort；当前会保持模型默认思考行为。',
      };
    default:
      return {
        provider,
        supportedEfforts: ['default'],
        note: '当前服务商暂未接入思考强度路由，会忽略该参数。',
      };
  }
}

function detectReasoningProvider(input: ReasoningRouteInput): ReasoningProviderFamily {
  const url = input.baseURL.toLowerCase();
  const model = input.model.toLowerCase();

  if (url.includes('anthropic.com')) return 'anthropic';
  if (url.includes('deepseek.com') || model.startsWith('deepseek-')) return 'deepseek';
  if (
    url.includes('moonshot.cn')
    || url.includes('moonshot.ai')
    || url.includes('kimi.ai')
    || model.startsWith('kimi-')
  ) {
    return 'moonshot';
  }
  if (
    url.includes('api.z.ai')
    || url.includes('bigmodel.cn')
    || model.startsWith('glm-')
  ) {
    return 'glm';
  }
  if (url.includes('openai.com') || model.startsWith('gpt-')) return 'openai';
  return 'generic';
}

function routeOpenAIReasoning(input: ReasoningRouteInput): ReasoningRouteResult {
  const effort = normalizeEffort(input.reasoningEffort);
  if (!effort || !input.model.toLowerCase().startsWith('gpt-')) {
    return { provider: 'openai', bodyPatch: {} };
  }
  return {
    provider: 'openai',
    bodyPatch: { reasoning_effort: effort },
  };
}

function routeAnthropicReasoning(input: ReasoningRouteInput): ReasoningRouteResult {
  const effort = normalizeEffort(input.reasoningEffort);
  if (!effort) return { provider: 'anthropic', bodyPatch: {} };
  return {
    provider: 'anthropic',
    bodyPatch: { output_config: { effort } },
  };
}

function routeDeepSeekReasoning(input: ReasoningRouteInput): ReasoningRouteResult {
  const effort = normalizeEffort(input.reasoningEffort);
  if (!effort) return { provider: 'deepseek', bodyPatch: {} };

  const reasoningEffort: 'high' | 'max' =
    effort === 'max' || effort === 'xhigh' ? 'max' : 'high';

  return {
    provider: 'deepseek',
    bodyPatch: {
      thinking: { type: 'enabled' },
      reasoning_effort: reasoningEffort,
    },
  };
}

function routeMoonshotReasoning(input: ReasoningRouteInput): ReasoningRouteResult {
  const effort = normalizeEffort(input.reasoningEffort);
  const model = input.model.toLowerCase();
  if (!effort || !model.startsWith('kimi-k3')) {
    return { provider: 'moonshot', bodyPatch: {} };
  }

  const reasoningEffort: 'low' | 'high' | 'max' =
    effort === 'low' ? 'low' : effort === 'max' || effort === 'xhigh' ? 'max' : 'high';

  return {
    provider: 'moonshot',
    bodyPatch: { reasoning_effort: reasoningEffort },
    omitTemperature: true,
  };
}

function routeGlmReasoning(input: ReasoningRouteInput): ReasoningRouteResult {
  const effort = normalizeEffort(input.reasoningEffort);
  const model = input.model.toLowerCase();
  if (!effort || !supportsGlmReasoningEffort(model)) {
    return { provider: 'glm', bodyPatch: {} };
  }
  return {
    provider: 'glm',
    bodyPatch: {
      thinking: { type: 'enabled' },
      reasoning_effort: effort,
    },
  };
}

function normalizeEffort(
  effort?: ReasoningEffort
): EffectiveReasoningEffort | undefined {
  if (!effort || effort === 'default') return undefined;
  return effort;
}

function supportsGlmReasoningEffort(model: string): boolean {
  const match = model.match(/^glm-(\d+)(?:\.(\d+))?/i);
  if (!match) return false;

  const major = Number(match[1] ?? 0);
  const minor = Number(match[2] ?? 0);
  return major > 5 || (major === 5 && minor >= 2);
}
