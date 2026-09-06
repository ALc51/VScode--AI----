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
