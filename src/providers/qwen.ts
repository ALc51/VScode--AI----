import { getReasoningEffort } from "../types";
import type { ProviderConfig, ChatRequestOptions, ChatStreamChunk } from "../types";
import { API_BASE_URLS } from "../config/models";
import { defaultGetModelMetadata, defaultGetVendorContextLimit } from "./modelMetadataStrategies";
import { defaultFormatModelDisplayName } from "./displayNameStrategies";
import {
  defaultHasInferredImageInput,
  defaultHasInferredReasoning,
  defaultHasInferredToolCalling,
  defaultInferContextTokens,
  defaultInferOutputTokens,
} from "./inferenceStrategies";
import { qwenReasoningSchema } from "./reasoningSchemas";

export function createQwenConfig(): ProviderConfig {
  return {
    vendor: "qwen",
    displayName: "通义千问",
    defaultBaseUrl: API_BASE_URLS.qwen,
    modelsEndpoint: `${API_BASE_URLS.qwen}/v1/models`,
    billingConsoleUrl: "https://dashscope.console.aliyun.com/billing",
    supportsBalance: false,
    includeStreamUsage: true,
    getAuthHeaders(apiKey: string) {
      return { Authorization: `Bearer ${apiKey}` };
    },
    getModelMetadata: defaultGetModelMetadata("qwen"),
    getVendorContextLimit: defaultGetVendorContextLimit,
    getReasoningConfigurationSchema: qwenReasoningSchema,
    formatModelDisplayName: defaultFormatModelDisplayName,
    inferContextTokens: defaultInferContextTokens,
    inferOutputTokens: defaultInferOutputTokens,
    hasInferredImageInput: defaultHasInferredImageInput,
    hasInferredToolCalling: defaultHasInferredToolCalling,
    hasInferredReasoning: defaultHasInferredReasoning,
    buildRequestBody(options: ChatRequestOptions) {
      const body: Record<string, unknown> = {
        model: options.model,
        messages: options.messages,
        stream: options.stream ?? true,
        temperature: options.temperature ?? 0.7,
        max_tokens: options.max_tokens ?? 4096,
        stream_options: { include_usage: true },
      };
      if (/qwen.*(3|thinking)|qwq/i.test(options.model)) {
        const effort = options.modelOptions?.reasoningEffort
          ?? options.configuration?.reasoningEffort;
        if (effort === "off") {
          body.enable_thinking = false;
        } else if (effort === "on") {
          body.enable_thinking = true;
        }
      }
      return body;
    },
    parseStreamChunk(event: Record<string, unknown>): ChatStreamChunk | null {
      return event as unknown as ChatStreamChunk;
    },
  };
}
