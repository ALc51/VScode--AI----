import { estimateCost, getPricingForModel } from "../config/pricing.ts";
import type { PricingManifest } from "../config/pricing.ts";
import type { ChatStreamUsage } from "../types.ts";
import { splitCacheUsage } from "../providers/billingStrategies.ts";

export interface UsageRecord {
  date: string;
  vendor: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 输入（命中缓存）累计 */
  cacheHitTokens: number;
  /** 输入（未命中缓存）累计 */
  cacheMissTokens: number;
  estimatedCost?: number;
  currency?: string;
  count: number;
  updatedAt: number;
}

export interface UsageStoreBackend {
  get(key: string): unknown;
  update(key: string, value: unknown): Promise<void> | void;
}

const USAGE_KEY = "billing.usage.v1";
const MAX_DAYS = 90;

/** 兼容旧版无缓存字段的记录（前向兼容） */
function withCacheDefaults(r: UsageRecord): UsageRecord {
  r.cacheHitTokens ??= 0;
  r.cacheMissTokens ??= 0;
  return r;
}

function dayKey(date = new Date()): string {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, "0");
  const d = `${date.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function loadAll(store: UsageStoreBackend): UsageRecord[] {
  const raw = store.get(USAGE_KEY);
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[])
    .filter((r): r is UsageRecord => {
      if (typeof r !== "object" || r === null) return false;
      const v = r as Record<string, unknown>;
      return (
        typeof v["date"] === "string" &&
        typeof v["vendor"] === "string" &&
        typeof v["model"] === "string" &&
        typeof v["totalTokens"] === "number"
      );
    })
    .map((r) => withCacheDefaults(r as UsageRecord));
}

function saveAll(store: UsageStoreBackend, records: UsageRecord[]): void {
  const sorted = [...records].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, MAX_DAYS * 32);
  void store.update(USAGE_KEY, sorted);
}

/** 累加一次流式 usage（真实 usage 优先，调用方负责降级估算） */
export function recordUsage(
  store: UsageStoreBackend,
  vendor: string,
  model: string,
  usage: ChatStreamUsage,
  pricing?: PricingManifest
): UsageRecord {
  const prompt = Math.max(0, Math.floor(usage.prompt_tokens ?? 0));
  const completion = Math.max(0, Math.floor(usage.completion_tokens ?? 0));
  const total = Math.max(0, Math.floor(usage.total_tokens ?? prompt + completion));
  const { hit, miss } = splitCacheUsage(usage);
  const date = dayKey();
  const records = loadAll(store);
  const entry = pricing ? getPricingForModel(vendor, model, pricing) : undefined;
  const cost = entry ? estimateCost(entry, prompt, completion) : undefined;
  const existing = records.find((r) => r.date === date && r.vendor === vendor && r.model === model);
  if (existing) {
    existing.promptTokens += prompt;
    existing.completionTokens += completion;
    existing.totalTokens += total;
    existing.cacheHitTokens = (existing.cacheHitTokens ?? 0) + hit;
    existing.cacheMissTokens = (existing.cacheMissTokens ?? 0) + miss;
    existing.count += 1;
    existing.updatedAt = Date.now();
    if (cost !== undefined) {
      existing.estimatedCost = (existing.estimatedCost ?? 0) + cost;
      existing.currency = entry?.currency;
    }
    saveAll(store, records);
    return existing;
  }
  const created: UsageRecord = {
    date,
    vendor,
    model,
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total,
    cacheHitTokens: hit,
    cacheMissTokens: miss,
    estimatedCost: cost,
    currency: entry?.currency,
    count: 1,
    updatedAt: Date.now(),
  };
  records.push(created);
  saveAll(store, records);
  return created;
}

export function getDailyUsage(store: UsageStoreBackend, date = dayKey()): UsageRecord[] {
  return loadAll(store).filter((r) => r.date === date);
}

export function getUsageHistory(store: UsageStoreBackend, days = 30): UsageRecord[] {
  return loadAll(store)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .slice(0, days * 32);
}

export interface UsageSummary {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  /** 缓存命中率（0-1），无输入时 undefined */
  hitRate?: number;
  estimatedCost: number;
  count: number;
}

export function summarizeUsage(records: UsageRecord[]): UsageSummary {
  const acc = records.reduce(
    (a, r) => ({
      promptTokens: a.promptTokens + r.promptTokens,
      completionTokens: a.completionTokens + r.completionTokens,
      totalTokens: a.totalTokens + r.totalTokens,
      cacheHitTokens: a.cacheHitTokens + (r.cacheHitTokens ?? 0),
      cacheMissTokens: a.cacheMissTokens + (r.cacheMissTokens ?? 0),
      estimatedCost: a.estimatedCost + (r.estimatedCost ?? 0),
      count: a.count + r.count,
    }),
    { promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, estimatedCost: 0, count: 0 }
  );
  const input = acc.cacheHitTokens + acc.cacheMissTokens;
  return { ...acc, hitRate: input > 0 ? acc.cacheHitTokens / input : undefined };
}
