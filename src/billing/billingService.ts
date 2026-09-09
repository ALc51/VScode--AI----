import * as vscode from "vscode";
import type { BalanceResult, ChatStreamUsage } from "../types";
import type { BaseLanguageModelProvider } from "../providers/baseProvider";
import { isBalanceSupported } from "../providers/billingStrategies";
import { ExtensionLogger } from "../utils/logger";
import { getCachedPricingManifest, syncPricingManifest } from "../utils/pricingSync";
import { diffPricingManifests } from "../config/pricing";
import { getDailyUsage, getUsageHistory, summarizeUsage } from "../utils/usageStore";
import type { UsageSummary, UsageRecord } from "../utils/usageStore";
import { KNOWN_CHAT_MODELS } from "../config/models";

/**
 * 账单服务：持有 5 个 provider 引用，统一调度余额/用量/定价。
 * - 只加载当前厂商：activeVendor 由 provider 活跃回调 + selectChatModels 探测 + 手动选择三路确定
 * - SWR：先返回上次已知值，后台刷新后触发 onDidChange
 * - 聊天完成去抖 5s 后刷新余额（避免每次 token 回调都打网络）
 */
export class BillingService implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly lastKnown = new Map<string, BalanceResult>();
  private disposeState = false;
  /** 当前厂商（只加载此厂商的数据；未知时回退 undefined，由调用方提示选择） */
  private activeVendor?: string;
  private activeModelId?: string;

  constructor(
    private readonly providers: BaseLanguageModelProvider[],
    private readonly state: vscode.Memento,
    private readonly onPricingRefreshed?: () => void
  ) {
    for (const p of providers) {
      p.onUsage((usage: ChatStreamUsage, modelId: string) => this.handleUsage(p.vendor, usage, modelId));
      p.onActivity((vendor: string, modelId?: string) => this.setActiveVendor(vendor, modelId, false));
    }
    const persisted = typeof state.get<string>("billing.activeVendor") === "string"
      ? (state.get<string>("billing.activeVendor") as string)
      : undefined;
    const persistedModel = typeof state.get<string>("billing.activeModelId") === "string"
      ? (state.get<string>("billing.activeModelId") as string)
      : undefined;
    if (persisted && this.findProvider(persisted)) {
      this.activeVendor = persisted;
      if (persistedModel) this.activeModelId = persistedModel;
    }
  }

  dispose(): void {
    this.disposeState = true;
    for (const t of this.debounceTimers.values()) clearTimeout(t);
    this.debounceTimers.clear();
    this.changeEmitter.dispose();
  }

  getProviders(): BaseLanguageModelProvider[] {
    return this.providers;
  }

  findProvider(vendor: string): BaseLanguageModelProvider | undefined {
    return this.providers.find((p) => p.vendor === vendor);
  }

  /** 返回指定厂商已知的模型 ID 列表（模型列表缓存 + 兜底目录，用于面板下拉筛选） */
  getVendorModelIds(vendor: string): string[] {
    const p = this.findProvider(vendor);
    const cached = p?.getKnownModelIds() ?? [];
    const catalog = KNOWN_CHAT_MODELS[vendor] ?? [];
    // 合并去重：缓存优先（更准确），兜底目录补充
    const set = new Set<string>(cached);
    for (const id of catalog) set.add(id);
    return [...set].sort();
  }

  /** 当前厂商识别三路：活跃回调已设置 > selectChatModels 探测 > 持久化/手动选择 */
  getActiveVendor(): string | undefined {
    return this.activeVendor;
  }

  getActiveModelId(): string | undefined {
    return this.activeModelId;
  }

  setActiveVendor(vendor: string, modelId?: string, persist = true): void {
    if (!this.findProvider(vendor)) return;
    const changed = this.activeVendor !== vendor || (modelId && this.activeModelId !== modelId);
    this.activeVendor = vendor;
    if (modelId) this.activeModelId = modelId;
    if (persist) {
      void this.state.update("billing.activeVendor", vendor);
      if (modelId) void this.state.update("billing.activeModelId", modelId);
    }
    if (changed) this.changeEmitter.fire();
  }

  /** 探测当前聊天模型（只读，不触发计费请求）：按本插件 vendor 逐个 selectChatModels */
  async detectActiveVendor(): Promise<string | undefined> {
    if (this.activeVendor) return this.activeVendor;
    for (const p of this.providers) {
      try {
        const models = await vscode.lm.selectChatModels({ vendor: p.vendor });
        if (models.length > 0) {
          this.setActiveVendor(p.vendor, models[0]?.id);
          return p.vendor;
        }
      } catch {
        continue;
      }
    }
    return this.activeVendor;
  }

  /** 让用户明确选择当前厂商（面板/命令无上下文时的兜底） */
  async pickActiveVendor(placeHolder = "选择当前使用的厂商（只加载该厂商数据）"): Promise<string | undefined> {
    const items = this.providers.map((p) => ({
      label: p.providerConfig.displayName,
      description: p.vendor,
      detail: isBalanceSupported(p.providerConfig) ? "支持余额查询" : "不支持余额查询（控制台查看）",
    }));
    const picked = await vscode.window.showQuickPick(items, { placeHolder });
    if (picked?.description) {
      this.setActiveVendor(picked.description);
      return picked.description;
    }
    return undefined;
  }

  /** 确保拿到当前厂商：已记忆 > 探测 > 手动选择 */
  async ensureActiveVendor(): Promise<string | undefined> {
    if (this.activeVendor) return this.activeVendor;
    const detected = await this.detectActiveVendor();
    if (detected) return detected;
    return this.pickActiveVendor();
  }

  /** SWR：同步返回上次已知值（可能 undefined），再后台刷新 */
  getLastKnownBalance(vendor: string): BalanceResult | undefined {
    const cached = this.lastKnown.get(vendor);
    if (cached) return cached;
    const p = this.findProvider(vendor);
    const known = p?.getCachedBalance();
    if (known) this.lastKnown.set(vendor, known);
    return known;
  }

  /** 后台刷新单个厂商余额（SWR 后半段），完成后 fire onDidChange */
  async refreshBalance(vendor: string, force = false): Promise<BalanceResult | undefined> {
    const p = this.findProvider(vendor);
    if (!p) return undefined;
    if (!isBalanceSupported(p.providerConfig)) return undefined;
    try {
      const result = await p.getBalance({ forceRefresh: force });
      this.lastKnown.set(vendor, result);
      this.changeEmitter.fire();
      return result;
    } catch (err) {
      const cause = (err as { cause?: Error })?.cause;
      // Unsupported/NoApiKey 不记 error，只记 info 级别由调用方展示
      if (cause?.message === "Unsupported" || cause?.message === "NoApiKey") return undefined;
      ExtensionLogger.get().warn(`余额刷新失败: ${err instanceof Error ? err.message : String(err)}`, {
        vendor,
        kind: "NetworkError",
      });
      return this.lastKnown.get(vendor) ?? p.getCachedBalance();
    }
  }

  /** 并行刷新全部支持余额的厂商（已废弃：只加载当前厂商，保留兼容手动刷新当前项） */
  async refreshAllBalances(force = false): Promise<Map<string, BalanceResult>> {
    const out = new Map<string, BalanceResult>();
    const vendor = await this.ensureActiveVendor();
    if (!vendor) return out;
    const result = await this.refreshBalance(vendor, force);
    if (result?.available !== undefined) out.set(vendor, result);
    return out;
  }

  /** 刷新当前厂商余额（单厂商加载：只打这一个请求） */
  async refreshActiveBalance(force = false): Promise<BalanceResult | undefined> {
    const vendor = await this.ensureActiveVendor();
    if (!vendor) return undefined;
    return this.refreshBalance(vendor, force);
  }

  /** 聊天 usage 回调：立即触发面板刷新（等50ms让 globalState 落盘），余额去抖5s刷新 */
  private handleUsage(vendor: string, _usage: ChatStreamUsage, _modelId: string): void {
    if (this.disposeState) return;
    // 面板刷新：等 50ms 让 globalState.update 异步写入完成后重读
    setTimeout(() => {
      if (!this.disposeState) this.changeEmitter.fire();
    }, 50);
    // 余额去抖：仅余额支持的厂商
    const p = this.findProvider(vendor);
    if (!p || !isBalanceSupported(p.providerConfig)) return;
    const prev = this.debounceTimers.get(vendor);
    if (prev) clearTimeout(prev);
    this.debounceTimers.set(
      vendor,
      setTimeout(() => {
        this.debounceTimers.delete(vendor);
        void this.refreshBalance(vendor, false);
      }, 5_000)
    );
  }

  getTodaySummary(vendor?: string): UsageSummary {
    const v = vendor ?? this.activeVendor;
    const records = getDailyUsage(this.adaptStore());
    return summarizeUsage(v ? records.filter((r) => r.vendor === v) : records);
  }

  getHistory(days = 30, vendor?: string): ReturnType<typeof getUsageHistory> {
    const v = vendor ?? this.activeVendor;
    const history = getUsageHistory(this.adaptStore(), days);
    return v ? history.filter((r) => r.vendor === v) : history;
  }

  getPricingManifest(): ReturnType<typeof getCachedPricingManifest> {
    return getCachedPricingManifest(this.adaptStore());
  }

  /** 定价同步（启动异步一次 + 手动），不阻塞 */
  async syncPricing(force = false): Promise<void> {
    const oldManifest = getCachedPricingManifest(this.adaptStore());
    const result = await syncPricingManifest(this.adaptStore(), { force });

    // 强制刷新时重新注册 provider，强制 VS Code 重新查询模型信息（包括定价）
    if (force) {
      this.onPricingRefreshed?.();
    }

    // 检测定价变更并通知用户
    const changes = diffPricingManifests(oldManifest, result.manifest);
    if (changes.length > 0) {
      const vendors = [...new Set(changes.map((c) => c.vendor))];
      ExtensionLogger.get().info(
        `[定价同步] source=${result.source}, version=${result.manifest.version}, 变更=${changes.length}项`
      );
      void vscode.window.showInformationMessage(
        `💰 定价已刷新 (${vendors.join(", ")}) [${result.source === "remote" ? "远端" : "本地"}]`
      );
    } else if (force) {
      void vscode.window.showInformationMessage(`💰 定价已是最新 [${result.source === "remote" ? "远端" : "本地"}]`);
    }

    this.changeEmitter.fire();
  }

  private adaptStore(): { get(key: string): unknown; update(key: string, value: unknown): void } {
    const state = this.state;
    return {
      get: (key: string) => state.get(key),
      update: (key: string, value: unknown) => {
        void state.update(key, value);
      },
    };
  }
}
