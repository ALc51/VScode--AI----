import { getReasoningEffort } from "../types";
import type { ProviderConfig, ChatRequestOptions, ChatStreamChunk } from "../types";
import { API_BASE_URLS } from "../config/models";
import { defaultGetModelMetadata, defaultGetVendorContextLimit } from "./modelMetadataStrategies";
import { defaultParseBalanceResponse } from "./billingStrategies";
import { defaultFormatModelDisplayName } from "./displayNameStrategies";
import {
  defaultHasInferredImageInput,
  defaultHasInferredReasoning,
  defaultHasInferredToolCalling,
  defaultInferContextTokens,
  defaultInferOutputTokens,
} from "./inferenceStrategies";
import { kimiReasoningSchema } from "./reasoningSchemas";

export function createKimiConfig(): ProviderConfig {
  return {
    vendor: "kimi",
    displayName: "Kimi",
    defaultBaseUrl: API_BASE_URLS.kimi,
    modelsEndpoint: `${API_BASE_URLS.kimi}/v1/models`,
    balanceEndpoint: `${API_BASE_URLS.kimi}/v1/users/me/balance`,
    billingConsoleUrl: "https://platform.moonshot.cn/console/account",
    supportsBalance: true,
    parseBalanceResponse: defaultParseBalanceResponse("kimi"),
    includeStreamUsage: true,
    getAuthHeaders(apiKey: string) {
      return { Authorization: `Bearer ${apiKey}` };
    },
    getModelMetadata: defaultGetModelMetadata("kimi"),
    getVendorContextLimit: defaultGetVendorContextLimit,
    getReasoningConfigurationSchema: kimiReasoningSchema,
    formatModelDisplayName: defaultFormatModelDisplayName,
    inferContextTokens: defaultInferContextTokens,
    inferOutputTokens: defaultInferOutputTokens,
    hasInferredImageInput: defaultHasInferredImageInput,
    hasInferredToolCalling: defaultHasInferredToolCalling,
    hasInferredReasoning: defaultHasInferredReasoning,
    buildRequestBody(options: ChatRequestOptions) {
      const modelOptions = options.modelOptions ?? {};
      const reasoningEffort = getReasoningEffort(options);
      const modelReasoningEffort = modelOptions.reasoningEffort;
      const thinkingMode = modelOptions.thinkingMode ?? options.configuration?.thinkingMode;
      const thinking = modelOptions.thinking;
      const body: Record<string, unknown> = {
        model: options.model,
        messages: options.messages,
        stream: options.stream ?? true,
        temperature: 1,
        max_tokens: options.max_tokens ?? 4096,
        stream_options: { include_usage: true },
      };

      if (options.model.startsWith("kimi-k3")) {
        if (modelReasoningEffort !== "off") {
          body.reasoning_effort = "high";
        }
      } else if (options.model.includes("k2.7-code")) {
        body.thinking = { type: "enabled", keep: "all" };
      } else if (options.model.includes("k2.6")) {
        body.thinking = thinking && typeof thinking === "object"
          ? thinking
          : { type: modelReasoningEffort === "off" || thinkingMode === "disabled" ? "disabled" : "enabled" };
      }

      return body;
    },
    parseStreamChunk(event: Record<string, unknown>): ChatStreamChunk | null {
      return event as unknown as ChatStreamChunk;
    },
  };
}
