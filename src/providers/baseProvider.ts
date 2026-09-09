import * as vscode from "vscode";
import type { BalanceResult, ChatStreamUsage, ModelConfig, ProviderConfig, VendorConfiguration } from "../types";
import { SSEParser } from "../utils/sseParser";
import { estimateTokens, estimateStructuredTokenCount, MESSAGE_TOKEN_OVERHEAD, MESSAGE_NAME_TOKEN_OVERHEAD, TOOL_CALL_TOKEN_OVERHEAD, TOOL_RESULT_TOKEN_OVERHEAD, IMAGE_TOKEN_ESTIMATE } from "../utils/tokenEstimator";
import { createAbortSignal, cancellableSleep } from "../utils/cancellation";
import { ExtensionLogger } from "../utils/logger";
import { defaultParseBalanceResponse, isBalanceSupported, normalizeStreamUsage } from "./billingStrategies";
import { recordUsage } from "../utils/usageStore";
import { getCachedPricingManifest } from "../utils/pricingSync";
import { getPricingForModel, BUNDLED_PRICING } from "../config/pricing";
import { KNOWN_CHAT_MODELS } from "../config/models";
import { getOfficialModelMetadata } from "../config/modelMetadata";
import {
  generateLocalRequestId,
  reportUsageToContextWindow,
  reportProgressWithRequest,
  setOutputBufferForRequest,
  clearContextWindowRequest,
  withContextWindowRequest,
} from "../utils/contextWindowHookBridge";

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
  /** 余额并发合并 + 30s 去重窗口（SWR：内存存最新值，持久层存上次已知值） */
  private balancePromise?: Promise<BalanceResult>;
  private lastBalanceAt = 0;
  private lastBalance?: BalanceResult;
  /** 流式 usage 回调（由 BillingService/extension 注册，用于 UsageStore 累加与余额去抖刷新） */
  private usageListener?: (usage: ChatStreamUsage, modelId: string) => void;
  /** 活跃厂商回调列表（每次 VS Code 调用该厂商时触发） */
  private activityListeners: ((vendor: string, modelId?: string) => void)[] = [];

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

    // 优先使用 VS Code 传入的 BYOK configuration
    const apiKey = configuration ? this.getApiKey(configuration) : undefined;

    // 如果 configuration 中有 apiKey，缓存到 secret storage，使后续 silent 调用也能返回模型
    if (apiKey && this.modelCache) {
      try {
        await this.modelCache.update(`language-models.${this.config.vendor}.apiKey`, apiKey);
      } catch { /* ignore */ }
    }

    // 如果 configuration 没有 apiKey，尝试从 secret storage 恢复（VS Code 首次 silent 调用时 configuration 为 undefined）
    if (!apiKey && configuration === undefined) {
      const cachedKey = this.modelCache?.get<string>(`language-models.${this.config.vendor}.apiKey`);
      if (cachedKey) {
        this.configuration = { apiKey: cachedKey } as VendorConfiguration;
      } else {
        // 无 API Key 且无缓存：返回空，VS Code 会触发配置流程
        return [];
      }
    } else if (!apiKey) {
      return [];
    } else {
      this.configuration = configuration;
    }
    // 注意：不要在模型枚举（provideLanguageModelChatInformation）中标记活跃。
    // Chat UI 会频繁枚举全部厂商，若在此 markActive 会不断覆盖用户手动选择的厂商，
    // 并高频触发 onDidChange 导致面板反复重渲染（卡顿）。活跃追踪只在真实聊天请求时进行。

    if (!this.cachedModels) {
      this.cachedModels = this.modelCache?.get<ModelConfig[]>(this.getModelCacheKey());
    }

    const keyForRefresh = apiKey ?? (this.configuration as VendorConfiguration)?.apiKey;
    if (keyForRefresh) {
      if (this.cachedModels && this.cachedModels.length > 0) {
        void this.refreshModels(keyForRefresh);
      } else {
        await this.refreshModels(keyForRefresh);
      }
    }

    // 获取当前定价清单，用于注入模型定价信息（使用捆绑兜底表；远端同步由 BillingService 驱动）
    const pricingManifest = BUNDLED_PRICING;

    return (this.cachedModels ?? []).map((m) => {
      const pricingEntry = getPricingForModel(this.config.vendor, m.id, pricingManifest);
      // 以每 1M tokens 展示定价
      // inputPer1k = 缓存未命中（cache miss）输入价格；cacheHitPer1k = 缓存命中（cache hit）输入价格
      const inputMiss1M = pricingEntry ? (pricingEntry.inputPer1k * 1000).toFixed(2) : undefined;
      const output1M = pricingEntry ? (pricingEntry.outputPer1k * 1000).toFixed(2) : undefined;
      const inputHit1M = pricingEntry?.cacheHitPer1k ? (pricingEntry.cacheHitPer1k * 1000).toFixed(2) : undefined;

      // 价格分类：根据缓存未命中输入价格判定（CNY/1M tokens）
      const priceCategory = inputMiss1M
        ? parseFloat(inputMiss1M) <= 2 ? "low"
          : parseFloat(inputMiss1M) <= 8 ? "medium"
          : parseFloat(inputMiss1M) <= 15 ? "high"
          : "very_high"
        : undefined;

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
        detail: inputMiss1M
          ? inputHit1M
            ? `输入未命中¥${inputMiss1M}/1M · 输入命中¥${inputHit1M}/1M · 输出¥${output1M}/1M`
            : `输入¥${inputMiss1M}/1M · 输出¥${output1M}/1M`
          : undefined,
        tooltip: [
          m.name,
          `上下文: ${m.maxInputTokens.toLocaleString()} tokens`,
          inputMiss1M ? `输入(未命中) ¥${inputMiss1M}/1M · 输出 ¥${output1M}/1M (${pricingEntry!.currency})` : "定价: 暂无",
          inputHit1M ? `输入(命中)   ¥${inputHit1M}/1M` : null,
          `来源: ${pricingEntry?.sourceUrl ?? "捆绑数据"} · ${pricingEntry?.effectiveDate ?? "-"}`,
        ].filter(Boolean).join("\n"),
        // ── VS Code 语言模型视图定价字段（提案 API） ──
        // 这些字段被 extHostLanguageModels 直接映射到 ILanguageModelChatMetadata，
        // 语言模型视图的"成本"列、hover 面板、model picker 详情均依赖这些字段。
        // inputCost = 缓存未命中输入价格，cacheCost = 缓存命中输入价格
        isBYOK: true,
        pricing: inputMiss1M
          ? inputHit1M
            ? `输入(未命中): ${inputMiss1M} · 输入(命中): ${inputHit1M} · 输出: ${output1M} CNY/1M tokens`
            : `输入: ${inputMiss1M} · 输出: ${output1M} CNY/1M tokens`
          : undefined,
        inputCost: inputMiss1M ? parseFloat(inputMiss1M) : undefined,
        outputCost: output1M ? parseFloat(output1M) : undefined,
        cacheCost: inputHit1M ? parseFloat(inputHit1M) : undefined,
        priceCategory,
        multiplierNumeric: inputMiss1M ? parseFloat(inputMiss1M) : undefined,
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
      const maxRetries = this.config.request?.maxRetries ?? 2;
      const baseDelay = this.config.request?.baseRetryDelayMs ?? 1_000;
      const timeoutMs = this.config.request?.listModelsTimeoutMs ?? 8_000;

      // 重试 + 指数退避
      let lastError: string | undefined;
      let response: Response | undefined;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          response = await fetch(endpoint, {
            headers: this.config.getAuthHeaders(apiKey),
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (response.ok) break;
          // 非 2xx 不重试（除 429/5xx）
          const status = response.status;
          if (status === 429 || status >= 500) {
            lastError = `HTTP ${status}`;
            await response.body?.cancel().catch(() => undefined);
            response = undefined;
          } else {
            // 4xx（非 429）直接放弃
            await response.body?.cancel().catch(() => undefined);
            logger.warn(`模型列表返回非 200`, { vendor: this.config.vendor, status, kind: "ModelListError" });
            return;
          }
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          response = undefined;
        }
        // 退避等待（最后一次不等）
        if (attempt < maxRetries) {
          const delay = baseDelay * Math.pow(2, attempt);
          logger.info(`模型列表拉取重试 (${attempt + 1}/${maxRetries})，${delay}ms 后重试`, {
            vendor: this.config.vendor,
            kind: "ModelListRetry",
          });
          await new Promise((r) => setTimeout(r, delay));
        }
      }

      if (!response || !response.ok) {
        logger.warn(`模型列表拉取失败（已重试 ${maxRetries} 次）: ${lastError}`, {
          vendor: this.config.vendor,
          kind: "ModelListError",
        });
        // 网络全失败时：若有缓存则保留，若无缓存则回退到本地已知模型列表
        if (!this.cachedModels || this.cachedModels.length === 0) {
          this.cachedModels = this.buildFallbackModels();
          if (this.cachedModels.length > 0) {
            logger.info(`回退到本地已知模型列表（${this.cachedModels.length} 个模型）`, {
              vendor: this.config.vendor,
              kind: "ModelListFallback",
            });
          }
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

  /** 网络全失败时，用本地已知模型表 + modelMetadata 生成兜底列表 */
  private buildFallbackModels(): ModelConfig[] {
    const knownIds = KNOWN_CHAT_MODELS[this.config.vendor] ?? [];
    if (knownIds.length === 0) return [];
    return knownIds.map((modelId) => {
      const meta = this.config.getModelMetadata?.(modelId)
        ?? getOfficialModelMetadata(this.config.vendor, modelId);
      return {
        id: modelId,
        name: this.getModelDisplayName(modelId),
        vendor: this.config.vendor,
        family: modelId.split("-")[0],
        version: "latest",
        maxInputTokens: meta?.contextTokens
          ?? this.config.inferContextTokens?.(modelId)
          ?? 32_768,
        maxOutputTokens: this.config.inferOutputTokens?.(modelId) ?? 4_096,
        capabilities: {
          imageInput: meta?.imageInput ?? this.config.hasInferredImageInput?.(modelId),
          toolCalling: meta?.toolCalling ?? this.config.hasInferredToolCalling?.(modelId),
          reasoning: meta?.reasoning ?? this.config.hasInferredReasoning?.(modelId),
        },
      };
    });
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
    this.markActive(model.id);

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
    const logCtx = { vendor: this.config.vendor, modelId: model.id };
    const requestConfig = this.config.request ?? {};
    const maxRetries = requestConfig.maxRetries ?? 3;
    const baseDelay = requestConfig.baseRetryDelayMs ?? 1000;
    const timeoutMs = requestConfig.timeoutMs ?? 120_000;
    const isCancelled = () => token.isCancellationRequested;

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
    // 预估输入 token 数，作为 fallback 传给 processStreamResponse
    const estimatedPromptTokens = messages.reduce(
      (sum, msg) => sum + this.estimateChatMessageTokenCount(msg), 0
    );
    // 生成本地请求 ID 用于 context window hook 追踪
    const localRequestId = generateLocalRequestId();
    // 设置输出缓冲区（maxOutputTokens）供 context window 计算预留区
    const maxOutput = model.maxOutputTokens ?? 4096;
    setOutputBufferForRequest(localRequestId, maxOutput);
    try {
      await this.processStreamResponse(response, progress, token, model.id, estimatedPromptTokens, localRequestId);
    } finally {
      clearContextWindowRequest(localRequestId);
    }
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken
  ): Promise<number> {
    if (typeof text === "string") return Math.max(1, estimateTokens(text));
    return Math.max(1, this.estimateChatMessageTokenCount(text));
  }

  private estimateChatMessageTokenCount(msg: vscode.LanguageModelChatRequestMessage): number {
    const roleRaw = (msg as unknown as { role?: unknown }).role;
    const role = typeof roleRaw === "string" ? roleRaw : typeof roleRaw === "number" ? String(roleRaw) : "";
    const name = typeof (msg as unknown as { name?: unknown }).name === "string" ? String((msg as unknown as { name?: unknown }).name) : "";
    const parts = Array.isArray(msg.content) ? (msg.content as unknown[]) : [];
    const contentTokens = parts.map((p) => this.partToTokenCount(p)).reduce((a, b) => a + b, 0);
    return MESSAGE_TOKEN_OVERHEAD + estimateTokens(role) + (name ? MESSAGE_NAME_TOKEN_OVERHEAD + estimateTokens(name) : 0) + contentTokens;
  }

  private partToTokenCount(part: unknown): number {
    // 优先 instanceof，兼容 VS Code 传入的实例
    if (part instanceof vscode.LanguageModelTextPart) return estimateTokens((part as vscode.LanguageModelTextPart).value);
    if (part instanceof vscode.LanguageModelToolResultPart) {
      const p = part as vscode.LanguageModelToolResultPart;
      const contentTokens = (p.content as unknown[]).map((c) => this.partToTokenCount(c)).reduce((a, b) => a + b, 0);
      return TOOL_RESULT_TOKEN_OVERHEAD + estimateTokens(p.callId) + contentTokens;
    }
    if (part instanceof vscode.LanguageModelToolCallPart) {
      const p = part as vscode.LanguageModelToolCallPart;
      return TOOL_CALL_TOKEN_OVERHEAD + estimateTokens(p.callId) + estimateTokens(p.name) + estimateStructuredTokenCount(p.input);
    }
    if (part instanceof vscode.LanguageModelDataPart) {
      const p = part as vscode.LanguageModelDataPart;
      if (p.mimeType === "application/vnd.opencode.usage+json" || p.mimeType === "usage" || p.mimeType === "application/vnd.opencode.reasoning+json") return 0;
      if (p.mimeType.startsWith("image/")) return IMAGE_TOKEN_ESTIMATE;
      if (p.mimeType.startsWith("text/") || p.mimeType === "application/json") {
        try { return estimateTokens(new TextDecoder().decode((p as unknown as { data: Uint8Array }).data)); } catch { return Math.max(1, Math.ceil((p as unknown as { data: Uint8Array }).data.byteLength / 4)); }
      }
      return Math.max(1, Math.ceil((p as unknown as { data: Uint8Array }).data.byteLength / 4));
    }
    // 兜底：鸭子类型，兼容 plain object 形式的 part（VS Code 可能传 plain object）
    if (typeof part === "string") return estimateTokens(part);
    if (part !== null && typeof part === "object") {
      const p = part as Record<string, unknown>;
      if (typeof p["value"] === "string") return estimateTokens(p["value"] as string);
      if (typeof p["callId"] === "string" && typeof p["name"] === "string") return TOOL_CALL_TOKEN_OVERHEAD + estimateTokens(p["callId"] as string) + estimateTokens(p["name"] as string) + estimateStructuredTokenCount(p["input"]);
      if (typeof p["callId"] === "string" && Array.isArray(p["content"])) {
        const contentTokens = (p["content"] as unknown[]).map((c) => this.partToTokenCount(c)).reduce((a, b) => a + b, 0);
        return TOOL_RESULT_TOKEN_OVERHEAD + estimateTokens(p["callId"] as string) + contentTokens;
      }
      if (typeof p["mimeType"] === "string") {
        const mime = p["mimeType"] as string;
        if (mime === "application/vnd.opencode.usage+json" || mime === "usage" || mime === "application/vnd.opencode.reasoning+json") return 0;
        if (mime.startsWith("image/")) return IMAGE_TOKEN_ESTIMATE;
      }
      return estimateStructuredTokenCount(part);
    }
    return 0;
  }

  /** 只读暴露当前厂商配置（供后台余额命令复用 apiKey，不泄露 key 本身） */
  get currentConfiguration(): VendorConfiguration | undefined {
    return this.configuration;
  }

  get vendor(): string {
    return this.config.vendor;
  }

  get providerConfig(): ProviderConfig {
    return this.config;
  }

  /** 注册流式 usage 监听（用量累计 + 余额去抖刷新） */
  onUsage(listener: (usage: ChatStreamUsage, modelId: string) => void): void {
    this.usageListener = listener;
  }

  /** 注册活跃厂商监听（每次 VS Code 调用该厂商时触发，支持多个监听器） */
  onActivity(listener: (vendor: string, modelId?: string) => void): void {
    this.activityListeners.push(listener);
  }

  private markActive(modelId?: string): void {
    try {
      for (const listener of this.activityListeners) {
        listener(this.config.vendor, modelId);
      }
    } catch {
      // 活跃追踪异常不影响主流程
    }
  }

  /** 上次已知余额（SWR 秒显用，不做网络请求） */
  getCachedBalance(): BalanceResult | undefined {
    if (this.lastBalance) return this.lastBalance;
    const persisted = this.modelCache?.get<BalanceResult>(this.getBalanceCacheKey());
    if (persisted && typeof persisted.updatedAt === "number") {
      this.lastBalance = persisted;
      this.lastBalanceAt = persisted.updatedAt;
      return persisted;
    }
    return undefined;
  }

  /** 返回该厂商已知的模型 ID 列表（缓存/刷新后的模型列表，可能为空） */
  getKnownModelIds(): string[] {
    return (this.cachedModels ?? []).map((m) => m.id);
  }

  /**
   * 查询账户余额（低延迟 SWR）：
   * - 30s 去重窗口内合并并发请求，不重复打网络
   * - forceRefresh=true 跳过去重（手动刷新用）
   * - unsupported（无 endpoint / 404/403）抛 cause=Unsupported 的 LanguageModelError
   */
  async getBalance(options?: { forceRefresh?: boolean; timeoutMs?: number }): Promise<BalanceResult> {
    if (!isBalanceSupported(this.config)) {
      throw new vscode.LanguageModelError(`${this.config.displayName} 暂不支持余额查询`, {
        cause: new Error("Unsupported"),
      });
    }
    const endpoint = this.config.balanceEndpoint as string;
    const apiKey = this.configuration ? this.getApiKey(this.configuration) : undefined;
    if (!apiKey) {
      throw new vscode.LanguageModelError("API Key 未配置，请先触发一次聊天完成配置", {
        cause: new Error("NoApiKey"),
      });
    }
    const now = Date.now();
    if (!options?.forceRefresh && this.balancePromise) return this.balancePromise;
    if (!options?.forceRefresh && this.lastBalance && now - this.lastBalanceAt < 30_000) {
      return this.lastBalance;
    }

    const logger = ExtensionLogger.get();
    this.balancePromise = (async () => {
      const response = await fetch(endpoint, {
        headers: this.config.getAuthHeaders(apiKey),
        signal: AbortSignal.timeout(options?.timeoutMs ?? this.config.request?.listModelsTimeoutMs ?? 8_000),
      }).catch((err) => {
        logger.warn(`余额查询失败: ${err instanceof Error ? err.message : String(err)}`, {
          vendor: this.config.vendor,
          kind: "NetworkError",
        });
        return undefined;
      });
      if (!response) {
        throw new vscode.LanguageModelError(`${this.config.displayName} 余额查询网络失败`, {
          cause: new Error("NetworkError"),
        });
      }
      if (response.status === 404 || response.status === 403) {
        await response.body?.cancel().catch(() => undefined);
        logger.warn(`余额接口不可用: ${response.status}`, {
          vendor: this.config.vendor,
          status: response.status,
          kind: "HttpError",
        });
        throw new vscode.LanguageModelError(`${this.config.displayName} 暂不支持余额查询`, {
          cause: new Error("Unsupported"),
        });
      }
      if (response.status === 401) {
        await response.body?.cancel().catch(() => undefined);
        logger.error("余额查询鉴权失败", { vendor: this.config.vendor, status: 401, kind: "AuthenticationError" });
        throw new vscode.LanguageModelError(`${this.config.displayName} API Key 无效或无权限`, {
          cause: new Error("AuthenticationError"),
        });
      }
      if (response.status === 429) {
        const retryAfter = response.headers.get("Retry-After");
        logger.warn(`余额查询限流${retryAfter ? `，${retryAfter}s 后重试` : ""}`, {
          vendor: this.config.vendor,
          status: 429,
          kind: "RateLimited",
        });
        await response.body?.cancel().catch(() => undefined);
        // 限流时回退上次已知值，避免 UI 空白
        if (this.lastBalance) return this.lastBalance;
        throw new vscode.LanguageModelError(`${this.config.displayName} 余额查询限流，请稍后重试`, {
          cause: new Error("RateLimited"),
        });
      }
      if (!response.ok) {
        const text = ExtensionLogger.truncate(await response.text().catch(() => ""));
        logger.error(`余额查询失败 ${response.status}: ${text}`, {
          vendor: this.config.vendor,
          status: response.status,
          kind: "HttpError",
        });
        throw new vscode.LanguageModelError(`${this.config.displayName} 余额查询失败 ${response.status}`, {
          cause: new Error("HttpError"),
        });
      }
      const payload = (await response.json().catch(() => undefined)) as unknown;
      const parser = this.config.parseBalanceResponse ?? defaultParseBalanceResponse(this.config.vendor);
      const result = parser(payload, this.config.vendor);
      if (!result || result.available === undefined) {
        logger.warn("余额响应解析失败", { vendor: this.config.vendor, kind: "HttpError" });
        throw new vscode.LanguageModelError(`${this.config.displayName} 余额响应解析失败`, {
          cause: new Error("HttpError"),
        });
      }
      this.lastBalance = result;
      this.lastBalanceAt = Date.now();
      await this.modelCache?.update(this.getBalanceCacheKey(), result);
      return result;
    })().finally(() => {
      this.balancePromise = undefined;
    });

    return this.balancePromise;
  }

  private getBalanceCacheKey(): string {
    return `billing.balance.${this.config.vendor}`;
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
    if (typeof msg.content === "string") return msg.content;
    const parts = msg.content as unknown[];
    if (!Array.isArray(parts)) return String(msg.content ?? "");
    return parts
      .map((part: unknown) => {
        if (typeof part === "string") return part;
        if (typeof part !== "object" || part === null) return "";
        const p = part as Record<string, unknown>;
        // TextPart
        if (typeof p["value"] === "string") return p["value"] as string;
        if (typeof p["text"] === "string") return p["text"] as string;
        // ToolCallPart: { callId, name, input }
        if (typeof p["callId"] === "string" && typeof p["name"] === "string") {
          try { return `${p["name"]}:${JSON.stringify(p["input"])}`; } catch { return String(p["name"]); }
        }
        // ToolResultPart: { callId, content: [...] }
        if (typeof p["callId"] === "string" && Array.isArray(p["content"])) {
          try {
            return (p["content"] as unknown[]).map((c) => {
              if (typeof c === "string") return c;
              if (typeof c === "object" && c !== null && typeof (c as Record<string, unknown>)["value"] === "string") return String((c as Record<string, unknown>)["value"]);
              try { return JSON.stringify(c); } catch { return String(c); }
            }).join("\n");
          } catch { return String(p["content"]); }
        }
        // DataPart / PromptTsxPart
        if (p["mimeType"] || p["mime"] || p["data"] !== undefined) {
          try { return JSON.stringify(part); } catch { return String(part); }
        }
        // 兜底：常见字段
        for (const k of ["content", "input", "output", "data"]) {
          if (typeof p[k] === "string") return p[k] as string;
        }
        // 最后兜底：序列化整个 part，避免漏计导致 0
        try {
          const s = JSON.stringify(part);
          return s && s !== "{}" ? s : "";
        } catch { return ""; }
      })
      .filter(Boolean)
      .join("\n");
  }

  protected async processStreamResponse(
    response: Response,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
    modelId?: string,
    estimatedPromptTokens?: number,
    localRequestId?: string
  ): Promise<void> {
    const reader = response.body?.getReader();
    if (!reader) {
      throw new vscode.LanguageModelError("响应体为空", { cause: new Error("EmptyResponse") });
    }

    const decoder = new TextDecoder();
    const sseParser = new SSEParser();
    /** 追踪流式 usage 最终值，用于透出到 VS Code 原生 UI */
    let finalUsage: import("../types").ChatStreamUsage | undefined;

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
          const textPart = new vscode.LanguageModelTextPart(content);
          if (localRequestId) {
            reportProgressWithRequest(localRequestId, progress, textPart);
          } else {
            progress.report(textPart);
          }
        }
        // usage 透出：优先上游真实值（需请求体开启 stream_options.include_usage）
        const usage = normalizeStreamUsage(event)
          ?? (parsed?.usage
            ? {
              prompt_tokens: typeof parsed.usage.prompt_tokens === "number" ? parsed.usage.prompt_tokens : undefined,
              completion_tokens: typeof parsed.usage.completion_tokens === "number" ? parsed.usage.completion_tokens : undefined,
              total_tokens: typeof parsed.usage.total_tokens === "number" ? parsed.usage.total_tokens : undefined,
              prompt_cache_hit_tokens: typeof parsed.usage.prompt_cache_hit_tokens === "number" ? parsed.usage.prompt_cache_hit_tokens : undefined,
              prompt_cache_miss_tokens: typeof parsed.usage.prompt_cache_miss_tokens === "number" ? parsed.usage.prompt_cache_miss_tokens : undefined,
              cached_tokens: typeof parsed.usage.cached_tokens === "number" ? parsed.usage.cached_tokens : undefined,
            }
            : undefined);
        if (usage && (usage.total_tokens !== undefined || usage.prompt_tokens !== undefined || usage.completion_tokens !== undefined)) {
          finalUsage = usage;
          try {
            this.usageListener?.(usage, modelId ?? "");
          } catch { /* ignore */ }
          // 同步写入 UsageStore
          try {
            if (this.modelCache) {
              const cache = this.modelCache;
              const backend = {
                get: (k: string): unknown => cache.get(k),
                update: (k: string, v: unknown): void => {
                  void cache.update(k, v);
                },
              };
              recordUsage(
                backend,
                this.config.vendor,
                modelId ?? "",
                usage,
                getCachedPricingManifest(backend)
              );
            }
          } catch {
            // 存储异常不影响流式输出
          }
        }
      }
    };

    try {
      while (true) {
        if (token.isCancellationRequested) {
          reader.cancel();
          break;
        }

        let done: boolean;
        let value: Uint8Array | undefined;
        try {
          ({ done, value } = await reader.read());
        } catch (err) {
          // undici 内部 Missing dataLength 错误：流可恢复，不要整体中断
          if (err instanceof TypeError && /dataLength/i.test(err.message)) {
            continue;
          }
          throw err;
        }
        if (done) break;
        if (!value) continue; // 容错跳过空块

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

    // 透出 usage 到 VS Code 原生 ChatContextUsageWidget（与 Copilot BYOK 路径一致）
    // 优先使用上游真实值，无则用预估值兜底
    try {
      const promptTokens = finalUsage?.prompt_tokens ?? estimatedPromptTokens ?? 0;
      const completionTokens = finalUsage?.completion_tokens ?? 0;
      const totalTokens = finalUsage?.total_tokens ?? promptTokens + completionTokens;
      const cachedTokens = finalUsage?.prompt_cache_hit_tokens ?? finalUsage?.cached_tokens ?? 0;

      // Layer 1: LanguageModelDataPart（公开 API 通道）
      const usagePayload = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
        prompt_tokens_details: {
          cached_tokens: cachedTokens,
        },
      };
      const usageData = new TextEncoder().encode(JSON.stringify(usagePayload));
      const usagePart = new vscode.LanguageModelDataPart(usageData, "usage");
      if (localRequestId) {
        reportProgressWithRequest(localRequestId, progress, usagePart);
      } else {
        progress.report(usagePart);
      }

      // Layer 2: contextWindowHook 注入（猴子补丁通道，使原生 Widget 更新）
      if (localRequestId) {
        reportUsageToContextWindow(localRequestId, {
          promptTokens,
          completionTokens,
        });
      }
    } catch { /* usage 透出异常不影响主流程 */ }
  }
}
