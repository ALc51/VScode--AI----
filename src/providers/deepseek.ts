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
import { deepseekReasoningSchema } from "./reasoningSchemas";

export function createDeepseekConfig(): ProviderConfig {
  return {
    vendor: "deepseek",
    displayName: "DeepSeek",
    defaultBaseUrl: API_BASE_URLS.deepseek,
    modelsEndpoint: `${API_BASE_URLS.deepseek}/models`,
    getAuthHeaders(apiKey: string) {
      return { Authorization: `Bearer ${apiKey}` };
    },
    getModelMetadata: defaultGetModelMetadata("deepseek"),
    getVendorContextLimit: defaultGetVendorContextLimit,
    getReasoningConfigurationSchema: deepseekReasoningSchema,
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
      if (/reason|r1/i.test(options.model)) {
        const effort = options.modelOptions?.reasoningEffort
          ?? options.modelOptions?.reasoning_effort
          ?? options.configuration?.reasoningEffort
          ?? options.configuration?.reasoning_effort;
        if (effort === "off") {
          body.thinking = { type: "disabled" };
          return body;
        }
        body.thinking = {
          type: options.modelOptions?.thinkingMode ?? options.configuration?.thinkingMode ?? "enabled",
        };
        body.reasoning_effort = effort === "low" || effort === "medium" || effort === "high" || effort === "max"
          ? effort
          : getReasoningEffort(options);
      }
      return body;
    },
    parseStreamChunk(event: Record<string, unknown>): ChatStreamChunk | null {
      return event as unknown as ChatStreamChunk;
    },
  };
}
