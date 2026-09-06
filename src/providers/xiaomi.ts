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
import { xiaomiReasoningSchema } from "./reasoningSchemas";

export function createXiaomiConfig(): ProviderConfig {
  return {
    vendor: "xiaomi",
    displayName: "小米 MiMo",
    defaultBaseUrl: API_BASE_URLS.xiaomi,
    modelsEndpoint: `${API_BASE_URLS.xiaomi}/v1/models`,
    getAuthHeaders(apiKey: string) {
      return { Authorization: `Bearer ${apiKey}` };
    },
    getModelMetadata: defaultGetModelMetadata("xiaomi"),
    getVendorContextLimit: defaultGetVendorContextLimit,
    getReasoningConfigurationSchema: xiaomiReasoningSchema,
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
      };
      if (/reason|think|mimo/i.test(options.model)) {
        const reasoningEffort = options.modelOptions?.reasoningEffort
          ?? options.modelOptions?.reasoning_effort
          ?? options.configuration?.reasoningEffort
          ?? options.configuration?.reasoning_effort;
        const thinkingMode = options.modelOptions?.thinkingMode
          ?? options.configuration?.thinkingMode;
        body.thinking = {
          type: reasoningEffort === "none"
            || thinkingMode === "disabled"
            ? "disabled"
            : "enabled",
        };
      }
      return body;
    },
    parseStreamChunk(event: Record<string, unknown>): ChatStreamChunk | null {
      return event as unknown as ChatStreamChunk;
    },
  };
}