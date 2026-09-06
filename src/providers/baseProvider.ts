import * as vscode from "vscode";
import type { ModelConfig, ProviderConfig, VendorConfiguration } from "../types";
import { SSEParser } from "../utils/sseParser";
import { estimateTokens } from "../utils/tokenEstimator";
import { createAbortSignal, cancellableSleep } from "../utils/cancellation";
import { ExtensionLogger } from "../utils/logger";

/**
 * 所有国内厂商 Provider 的基类
 * 使用 VS Code 原生 configuration 驱动，与 Anthropic/OpenAI 等厂商完全一致
 */
export class BaseLanguageModelProvider
  implements vscode.LanguageModelChatProvider, vscode.Disposable
{
  private readonly modelChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.modelChangeEmitter.event;
  private configuration?: VendorConfiguration;
  private modelIds?: string;
  private cachedModels?: ModelConfig[];
  private refreshPromise?: Promise<void>;

  dispose(): void {
    this.modelChangeEmitter.dispose();
  }

  constructor(
    protected readonly config: ProviderConfig,
    private readonly modelCache?: vscode.Memento
  ) {}

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    // configuration 是提案 API，通过类型断言访问
    const configuration = (options as unknown as { configuration?: VendorConfiguration }).configuration;

    // 如果没有 configuration（首次调用），返回空，VS Code 会触发配置流程
    const apiKey = configuration ? this.getApiKey(configuration) : undefined;
    if (!apiKey) {
      return [];
    }

    this.configuration = configuration;

    if (!this.cachedModels) {
      this.cachedModels = this.modelCache?.get<ModelConfig[]>(this.getModelCacheKey());
    }

    if (this.cachedModels && this.cachedModels.length > 0) {
      void this.refreshModels(apiKey);
    } else {
      await this.refreshModels(apiKey);
    }

    return (this.cachedModels ?? []).map((m) => {
      const information = {
        id: m.id,
        name: m.name,
        vendor: m.vendor,
        family: m.family,
        version: m.version,
        maxInputTokens: m.maxInputTokens,
        maxOutputTokens: m.maxOutputTokens ?? 4096,
        capabilities: {
          imageInput: m.capabilities?.imageInput ?? false,
          toolCalling: m.capabilities?.toolCalling ?? false,
        },
      } as vscode.LanguageModelChatInformation & Record<string, unknown>;

      const configurationSchema = this.getReasoningConfigurationSchema(m.id, m.capabilities?.reasoning);
      if (configurationSchema) {
        information.configurationSchema = configurationSchema;
      }

      return information;
    });
  }

  private getReasoningConfigurationSchema(
    modelId: string,
    reasoning?: boolean
  ): Record<string, unknown> | undefined {
    if (!reasoning) return undefined;
    return this.config.getReasoningConfigurationSchema?.(modelId);
  }

  private async refreshModels(apiKey: string): Promise<void> {
    const endpoint = this.config.modelsEndpoint;
    if (!endpoint || this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = (async () => {
      const logger = ExtensionLogger.get();
      const response = await fetch(endpoint, {
        headers: this.config.getAuthHeaders(apiKey),
        signal: AbortSignal.timeout(this.config.request?.listModelsTimeoutMs ?? 8_000),
      }).catch((err) => {
        logger.warn(`模型列表拉取失败: ${err instanceof Error ? err.message : String(err)}`, {
          vendor: this.config.vendor,
          kind: "ModelListError",
        });
        return undefined;
      });
      if (!response || !response.ok) {
        // 提前结束：避免 body 连接悬空
        await response?.body?.cancel().catch(() => undefined);
        if (response && !response.ok) {
          logger.warn(`模型列表返回非 200`, {
            vendor: this.config.vendor,
            status: response.status,
            kind: "ModelListError",
          });
        }
        return;
      }

      const payload = (await response.json()) as unknown;
      const entries = this.getModelEntries(payload);
      const discovered = entries
        .filter((item): item is Record<string, unknown> & { id: string } => typeof item.id === "string")
        .filter((item) => this.isChatModelId(item.id))
        .map((item) => {
          const modelId = item.id;
          const contextTokens = this.getContextTokens(item, modelId);
          const outputTokens = this.getNumber(item, [
            "max_output_tokens",
            "max_completion_tokens",
            "output_token_limit",
          ]) ?? this.inferOutputTokens(modelId);
          const capabilities = this.getModelCapabilities(item, modelId);
          return {
            id: modelId,
            name: this.getModelDisplayName(modelId, typeof item.name === "string" ? item.name : undefined),
            vendor: this.config.vendor,
            family: typeof item.family === "string" ? item.family : modelId.split("-")[0],
            version: typeof item.version === "string" ? item.version : "latest",
            maxInputTokens: contextTokens,
            maxOutputTokens: outputTokens,
            capabilities,
          };
        });

      if (discovered.length === 0) {
        return;
      }

      const modelIds = this.getModelIds(discovered);
      const changed = this.modelIds !== modelIds;
      this.cachedModels = discovered;
      this.modelIds = modelIds;
      await this.modelCache?.update(this.getModelCacheKey(), discovered);
      if (changed) {
        this.modelChangeEmitter.fire();
      }
    })().catch(() => undefined).finally(() => {
      this.refreshPromise = undefined;
    });

    return this.refreshPromise;
  }

  private getModelIds(models: ModelConfig[]): string {
    return models
      .map((model) => `${model.id}:${model.capabilities?.imageInput ? "i" : ""}${model.capabilities?.toolCalling ? "t" : ""}`)
      .sort()
      .join("\n");
  }

  private getModelCacheKey(): string {
    return `language-models.${this.config.vendor}`;
  }

  private getModelDisplayName(modelId: string, reportedName?: string): string {
    if (this.config.formatModelDisplayName) {
      return this.config.formatModelDisplayName(modelId, reportedName);
    }
    return reportedName ?? modelId;
  }

  private getApiKey(configuration: VendorConfiguration): string | undefined {
    const configuredKey = this.config.getApiKeyFromConfig?.(configuration)
      ?? configuration.apiKey;
    if (typeof configuredKey !== "string") {
      return undefined;
    }
    const apiKey = configuredKey.trim();
    return apiKey.length > 0 ? apiKey : undefined;
  }

  private getModelEntries(payload: unknown): Array<Record<string, unknown>> {
    if (Array.isArray(payload)) {
      return payload.filter((item): item is Record<string, unknown> => this.isRecord(item));
    }
    if (!this.isRecord(payload)) {
      return [];
    }
    for (const key of ["data", "models", "items"]) {
      const value = payload[key];
      if (Array.isArray(value)) {
        return value.filter((item): item is Record<string, unknown> => this.isRecord(item));
      }
    }
    return [];
  }

  private isChatModelId(modelId: string): boolean {
    const normalizedId = modelId.toLowerCase();
    return !/(?:^|[-_])(asr|tts|voice|voiceclone|voicedesign|embedding|rerank|ocr)(?:$|[-_])/.test(normalizedId)
      && !/(?:image|video-generation|realtime)/.test(normalizedId);
  }

  private getModelCapabilities(model: Record<string, unknown>, modelId: string) {
    const supportedParameters = this.getStringArray(model, ["supported_parameters", "supportedParameters", "supported_features", "supportedFeatures"]);
    const modalities = this.getStringArray(model, ["input_modalities", "inputModalities", "modalities", "supported_modalities", "supportedModalities"]);
    const declaredCapabilities = this.getStringArray(model, ["capabilities", "features"]);
    const architecture = this.isRecord(model.architecture) ? model.architecture : undefined;
    const architectureModalities = architecture
      ? this.getStringArray(architecture, ["input_modalities", "inputModalities", "modalities", "supported_modalities", "supportedModalities"])
      : [];
    const allCapabilities = [...supportedParameters, ...modalities, ...declaredCapabilities, ...architectureModalities]
      .map((value) => value.toLowerCase());
    const normalizedId = modelId.toLowerCase();
    const official = this.getOfficialModelMetadata(normalizedId);
    const inferredImageInput = this.config.hasInferredImageInput?.(normalizedId) ?? false;
    const inferredToolCalling = this.config.hasInferredToolCalling?.(normalizedId) ?? false;
    const inferredReasoning = this.config.hasInferredReasoning?.(normalizedId) ?? false;
    const declaredImageInput = this.getBoolean(model, ["image_input", "imageInput", "vision", "supports_vision", "supportsVision"]);
    const declaredToolCalling = this.getBoolean(model, ["tool_calling", "toolCalling", "supports_tools", "supportsTools"]);
    const declaredReasoning = this.getBoolean(model, ["reasoning", "thinking", "supports_reasoning", "supportsReasoning"]);
    return {
      imageInput: official?.imageInput ?? declaredImageInput ?? (allCapabilities.some((value) =>
        ["image", "image_url", "video", "vision", "multimodal"].includes(value)
      ) || inferredImageInput),
      toolCalling: official?.toolCalling ?? declaredToolCalling ?? (allCapabilities.some((value) =>
        ["tools", "tool_choice", "tool_calls", "function_calling", "function_call"].includes(value)
      ) || inferredToolCalling),
      reasoning: official?.reasoning ?? declaredReasoning ?? (allCapabilities.some((value) =>
        ["thinking", "reasoning_effort", "reasoning", "reasoning_content"].includes(value)
      ) || inferredReasoning),
    };
  }

  private getContextTokens(model: Record<string, unknown>, modelId: string): number {
    const official = this.getOfficialModelMetadata(modelId.toLowerCase());
    if (official?.contextTokens) return official.contextTokens;

    const reported = this.getNumber(model, [
      "context_length",
      "context_window",
      "context_window_tokens",
      "max_context_length",
      "max_context_tokens",
      "max_input_tokens",
      "input_token_limit",
    ]);
    const inferred = this.config.inferContextTokens?.(modelId) ?? 128_000;
    const vendorLimit = this.getVendorContextLimit(modelId);
    return vendorLimit ? Math.min(reported ?? inferred, vendorLimit) : reported ?? inferred;
  }

  private getOfficialModelMetadata(modelId: string) {
    return this.config.getModelMetadata?.(modelId);
  }

  private getVendorContextLimit(modelId: string): number | undefined {
    return this.config.getVendorContextLimit?.(modelId);
  }

  private getNumber(model: Record<string, unknown>, keys: string[]): number | undefined {
    for (const key of keys) {
      const value = model[key];
      const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
      if (Number.isFinite(number) && number > 0) {
        return number;
      }
    }
    return undefined;
  }

  private getBoolean(model: Record<string, unknown>, keys: string[]): boolean | undefined {
    for (const key of keys) {
      const value = model[key];
      if (typeof value === "boolean") return value;
    }
    return undefined;
  }

  private getStringArray(model: Record<string, unknown>, keys: string[]): string[] {
    for (const key of keys) {
      const value = model[key];
      if (Array.isArray(value)) {
        return value.filter((item): item is string => typeof item === "string");
      }
    }
    return [];
  }

  private inferOutputTokens(modelId: string): number {
    return this.config.inferOutputTokens?.(modelId) ?? 16_384;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const configuration = this.configuration;
    const apiKey = configuration ? this.getApiKey(configuration) : undefined;
    if (!apiKey) {
      throw new vscode.LanguageModelError(
        "API Key 未配置",
        { cause: new Error("NoApiKey") }
      );
    }

    // 转换消息格式
    const chatMessages = this.convertMessages(messages) as Array<{ role: "user" | "assistant"; content: string }>;

    const request = this.config.prepareRequest
      ? await this.config.prepareRequest(configuration ?? {}, model.id, apiKey)
      : {
          url: `${this.config.defaultBaseUrl}/v1/chat/completions`,
          headers: this.config.getAuthHeaders(apiKey),
        };
    const modelConfiguration = (options as unknown as {
      modelConfiguration?: Record<string, unknown>;
    }).modelConfiguration;
    const body = this.config.buildRequestBody({
      model: model.id,
      messages: chatMessages,
      stream: true,
      modelOptions: {
        ...(options.modelOptions as Record<string, unknown> | undefined),
        ...modelConfiguration,
      },
      configuration,
    });

    // 带重试的请求
    let response: Response | undefined;
    const logger = ExtensionLogger.get();
    const requestConfig = this.config.request ?? {};
    const maxRetries = requestConfig.maxRetries ?? 3;
    const baseDelay = requestConfig.baseRetryDelayMs ?? 1000;
    const timeoutMs = requestConfig.timeoutMs ?? 120_000;
    const isCancelled = () => token.isCancellationRequested;
    const logCtx = { vendor: this.config.vendor, modelId: model.id };

    const truncate = ExtensionLogger.truncate;

    const sleepFor = (attempt: number) => baseDelay * (attempt + 1) * (attempt + 2) / 2;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (isCancelled()) {
        throw new vscode.LanguageModelError("请求已取消", { cause: new Error("Cancelled") });
      }
      try {
        response = await fetch(request.url, {
          method: "POST",
          headers: { ...request.headers, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: createAbortSignal(token, timeoutMs),
        });
      } catch (err) {
        if (isCancelled()) {
          throw new vscode.LanguageModelError("请求已取消", { cause: new Error("Cancelled") });
        }
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt < maxRetries) {
          logger.warn(`请求失败，${sleepFor(attempt)}ms 后重试: ${msg}`, { ...logCtx, attempt, kind: "NetworkError" });
          try {
            await cancellableSleep(token, sleepFor(attempt));
          } catch {
            throw new vscode.LanguageModelError("请求已取消", { cause: new Error("Cancelled") });
          }
          continue;
        }
        logger.error(`请求失败（已耗尽重试）: ${msg}`, { ...logCtx, attempt, kind: "NetworkError" });
        throw new vscode.LanguageModelError(`${this.config.displayName} 请求失败: ${msg}`, { cause: new Error("NetworkError") });
      }

      if (response.status >= 500 && response.status < 600) {
        const errorText = truncate(await response.text().catch(() => ""));
        if (attempt < maxRetries) {
          logger.warn(`服务器错误 ${response.status}，${sleepFor(attempt)}ms 后重试: ${errorText}`, { ...logCtx, status: response.status, attempt, kind: "ServerError" });
          try {
            await cancellableSleep(token, sleepFor(attempt));
          } catch {
            throw new vscode.LanguageModelError("请求已取消", { cause: new Error("Cancelled") });
          }
          continue;
        }
        logger.error(`服务器错误 ${response.status}（已耗尽重试）: ${errorText}`, { ...logCtx, status: response.status, attempt, kind: "ServerError" });
        throw new vscode.LanguageModelError(`${this.config.displayName} 服务器错误 ${response.status}: ${errorText}`, { cause: new Error("ServerError") });
      }

      if (response.status === 429) {
        const retryAfter = response.headers.get("Retry-After");
        const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : sleepFor(attempt);
        if (attempt < maxRetries) {
          logger.warn(`触发限流，${delay}ms 后重试`, { ...logCtx, status: 429, attempt, kind: "RateLimited" });
          try {
            await cancellableSleep(token, delay);
          } catch {
            throw new vscode.LanguageModelError("请求已取消", { cause: new Error("Cancelled") });
          }
          continue;
        }
        logger.error(`触发限流（已耗尽重试）`, { ...logCtx, status: 429, attempt, kind: "RateLimited" });
      }

      if (response.status === 401 || response.status === 403) {
        logger.error(`API Key 无效或无权限`, { ...logCtx, status: response.status, kind: "AuthenticationError" });
        throw new vscode.LanguageModelError(
          `${this.config.displayName} API Key 无效或无权限，请重新配置该厂商的 API Key`,
          { cause: new Error("AuthenticationError") }
        );
      }

      if (!response.ok) {
        const errorText = truncate(await response.text().catch(() => ""));
        logger.error(`返回错误 ${response.status}: ${errorText}`, { ...logCtx, status: response.status, kind: "HttpError" });
        throw new vscode.LanguageModelError(`${this.config.displayName} 返回错误 ${response.status}: ${errorText}`, { cause: new Error("HttpError") });
      }

      break;
    }

    if (!response) {
      throw new vscode.LanguageModelError("请求未返回响应", { cause: new Error("NoResponse") });
    }
    await this.processStreamResponse(response, progress, token);
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken
  ): Promise<number> {
    const content = typeof text === "string" ? text : this.extractMessageContent(text);
    return estimateTokens(content);
  }

  // ── 私有辅助方法 ──

  protected convertMessages(
    messages: readonly vscode.LanguageModelChatRequestMessage[]
  ): Array<{ role: string; content: string }> {
    return messages.map((m) => ({
      role: m.role === vscode.LanguageModelChatMessageRole.User ? "user" : "assistant",
      content: this.extractMessageContent(m),
    }));
  }

  protected extractMessageContent(msg: vscode.LanguageModelChatRequestMessage): string {
    if (typeof msg.content === "string") {
      return msg.content;
    }
    return msg.content
      .map((part: unknown) => {
        if (
          typeof part === "object" &&
          part !== null &&
          "value" in part &&
          typeof (part as { value: unknown }).value === "string"
        ) {
          return (part as vscode.LanguageModelTextPart).value;
        }
        return "";
      })
      .join("");
  }

  protected async processStreamResponse(
    response: Response,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const reader = response.body?.getReader();
    if (!reader) {
      throw new vscode.LanguageModelError("响应体为空", { cause: new Error("EmptyResponse") });
    }

    const decoder = new TextDecoder();
    const sseParser = new SSEParser();

    const reportEvents = (events: Array<Record<string, unknown>>) => {
      for (const event of events) {
        let parsed: import("../types").ChatStreamChunk | null;
        try {
          parsed = this.config.parseStreamChunk(event);
        } catch {
          continue;
        }

        const content = parsed?.choices?.[0]?.delta?.content;
        if (typeof content === "string" && content.length > 0) {
          progress.report(new vscode.LanguageModelTextPart(content));
        }
      }
    };

    try {
      while (true) {
        if (token.isCancellationRequested) {
          reader.cancel();
          break;
        }

        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        reportEvents(sseParser.feed(chunk));
      }
      reportEvents(sseParser.flush());
    } catch (error) {
      if (token.isCancellationRequested) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      ExtensionLogger.get().error(`流式响应失败: ${message}`, {
        vendor: this.config.vendor,
        kind: "StreamError",
      });
      throw new vscode.LanguageModelError(
        `${this.config.displayName} 流式响应失败: ${message}`,
        { cause: new Error("StreamError") }
      );
    } finally {
      reader.releaseLock();
    }
  }
}
