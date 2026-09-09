import type { OfficialModelMetadata } from "./config/modelMetadata";

/** 国内厂商 API 请求消息格式 */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** 国内厂商 API 请求选项 */
export interface ChatRequestOptions {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  top_p?: number;
  modelOptions?: Record<string, unknown>;
  configuration?: VendorConfiguration;
}

/** 上游流式 usage（OpenAI 兼容：prompt_tokens/completion_tokens/total_tokens） */
export interface ChatStreamUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** 兼容各厂商缓存 token 字段（如 prompt_cache_hit_tokens 等），解析时归一化 */
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  cached_tokens?: number;
  /** OpenAI 风格嵌套明细：prompt_tokens_details.cached_tokens 等 */
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_hit_tokens?: number;
    audio_tokens?: number;
    [key: string]: unknown;
  } & Record<string, unknown>;
  completion_tokens_details?: Record<string, unknown>;
  [key: string]: unknown;
}

/** 国内厂商 API 流式响应 chunk */
export interface ChatStreamChunk {
  choices: Array<{
    delta: {
      role?: string;
      content?: string;
      reasoning_content?: string;
    };
    finish_reason: string | null;
  }>;
  /** 流式末尾可能携带的用量（需请求体开启 stream_options.include_usage） */
  usage?: ChatStreamUsage | null;
}

/** 余额查询结果（金额单位以各厂商返回为准，currency 标注币种） */
export interface BalanceResult {
  vendor: string;
  /** 可用余额（主展示字段） */
  available?: number;
  currency?: string;
  total?: number;
  granted?: number;
  toppedUp?: number;
  /** 原始 payload（脱敏后可记日志，不含 key） */
  raw?: unknown;
  updatedAt: number;
}

/** 模型配置 */
export interface ModelConfig {
  id: string;
  name: string;
  vendor: string;
  family: string;
  version: string;
  maxInputTokens: number;
  maxOutputTokens?: number;
  capabilities?: {
    imageInput?: boolean;
    toolCalling?: boolean;
    reasoning?: boolean;
  };
}

/** VS Code 传入的厂商配置（来自 language-models.json） */
export interface VendorConfiguration {
  apiKey?: string;
  secretKey?: string;
  [key: string]: unknown;
}

/** 厂商 Provider 配置 */
export interface ProviderConfig {
  vendor: string;
  displayName: string;
  defaultBaseUrl: string;
  modelsEndpoint?: string;
  getAuthHeaders: (apiKey: string) => Record<string, string>;
  prepareRequest?: (
    config: VendorConfiguration,
    model: string,
    apiKey: string
  ) => Promise<{ url: string; headers: Record<string, string> }>;
  buildRequestBody: (options: ChatRequestOptions) => object;
  parseStreamChunk: (event: Record<string, unknown>) => ChatStreamChunk | null;
  getApiKeyFromConfig?: (config: VendorConfiguration) => string | undefined;
  /** 返回该厂商对某个模型的官方元数据（上下文长度、能力等），无则返回 undefined */
  getModelMetadata?: (modelId: string) => OfficialModelMetadata | undefined;
  /** 返回该厂商对某个模型的最大上下文 token 上限（用于 clamp），无则返回 undefined */
  getVendorContextLimit?: (modelId: string) => number | undefined;
  /** 返回 reasoning 模型的 configurationSchema（VS Code 透传给前端展示），无则 undefined */
  getReasoningConfigurationSchema?: (modelId: string) => Record<string, unknown> | undefined;
  /** 推断 modelId 的输入 token 上限（当上游未返回时） */
  inferContextTokens?: (modelId: string) => number | undefined;
  /** 推断 modelId 的输出 token 上限（当上游未返回时） */
  inferOutputTokens?: (modelId: string) => number | undefined;
  /** 是否该模型支持图片输入（用于能力推断的回退正则分支） */
  hasInferredImageInput?: (modelId: string) => boolean;
  /** 是否该模型支持工具调用（用于能力推断的回退正则分支） */
  hasInferredToolCalling?: (modelId: string) => boolean;
  /** 是否该模型支持 reasoning（用于能力推断的回退正则分支） */
  hasInferredReasoning?: (modelId: string) => boolean;
  /** 把上游 modelId 渲染成展示名 */
  formatModelDisplayName?: (modelId: string, reportedName?: string) => string;
  /** 请求相关参数（超时、重试次数、退避基数） */
  request?: {
    timeoutMs?: number;
    listModelsTimeoutMs?: number;
    maxRetries?: number;
    baseRetryDelayMs?: number;
  };
  /** 余额查询端点（完整 URL，无则不支持；404/403 运行时转为 unsupported） */
  balanceEndpoint?: string;
  /** 账单/充值控制台链接（unsupported 时用于跳转） */
  billingConsoleUrl?: string;
  /** 是否支持余额查询（默认以 balanceEndpoint 是否存在判定） */
  supportsBalance?: boolean;
  /** 解析余额响应 payload 为 BalanceResult，无则用通用解析 */
  parseBalanceResponse?: (payload: unknown, vendor: string) => BalanceResult | undefined;
  /** 是否在 chat/completions 请求体中附加 stream_options.include_usage（默认 true，白名单关闭） */
  includeStreamUsage?: boolean;
}

export function getReasoningEffort(options: ChatRequestOptions): "low" | "medium" | "high" | "max" {
  const value = options.modelOptions?.reasoningEffort
    ?? options.modelOptions?.reasoning_effort
    ?? options.configuration?.reasoningEffort
    ?? options.configuration?.reasoning_effort;
  if (value === "low" || value === "medium" || value === "high" || value === "max") {
    return value;
  }
  return "medium";
}
