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
import { zhipuReasoningSchema } from "./reasoningSchemas";

export function createZhipuConfig(): ProviderConfig {
  return {
    vendor: "zhipu",
    displayName: "智谱GLM",
    defaultBaseUrl: API_BASE_URLS.zhipu,
    modelsEndpoint: `${API_BASE_URLS.zhipu}/v4/models`,
    getAuthHeaders(apiKey: string) {
      return { Authorization: `Bearer ${apiKey}` };
    },
    getModelMetadata: defaultGetModelMetadata("zhipu"),
    getVendorContextLimit: defaultGetVendorContextLimit,
    getReasoningConfigurationSchema: zhipuReasoningSchema,
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
      if (/thinking|reason|glm-z|glm-4\.5/i.test(options.model)) {
        const effort = options.modelOptions?.reasoningEffort
          ?? options.configuration?.reasoningEffort;
        body.thinking = {
          type: effort === "off" ? "disabled" : "enabled",
        };
        if (effort !== "off") {
          body.reasoning_effort = effort === "max" ? "max" : "high";
        }
      }
      return body;
    },
    parseStreamChunk(event: Record<string, unknown>): ChatStreamChunk | null {
      return event as unknown as ChatStreamChunk;
    },
  };
}
