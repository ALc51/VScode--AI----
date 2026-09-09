import { BUNDLED_PRICING, isPricingManifest, mergePricingManifests } from "../config/pricing.ts";
import type { PricingManifest } from "../config/pricing.ts";
import { ExtensionLogger } from "./logger.ts";

const CACHE_KEY = "billing.pricingManifest";
const ETAG_KEY = "billing.pricingEtag";
const CHECKED_AT_KEY = "billing.pricingCheckedAt";
const ONE_DAY_MS = 6 * 60 * 60 * 1000;

// GitHub 仓库中的 pricing.json（由 Actions 每天自动更新）
const REMOTE_URL = "https://raw.githubusercontent.com/ALc51/VScode--AI----/main/pricing.json";

export interface PricingStore {
  get(key: string): unknown;
  update(key: string, value: unknown): Promise<void> | void;
}

export interface PricingSyncResult {
  manifest: PricingManifest;
  source: "remote" | "cache" | "bundled";
}

/**
 * 同步定价清单。
 * - force=true：先尝试从 GitHub 拉取最新 pricing.json，失败则用 BUNDLED_PRICING
 * - force=false：缓存未过期返回缓存，过期则拉取远端
 * 合并策略：BUNDLED_PRICING 始终作为兜底，远端数据叠加在上
 */
export async function syncPricingManifest(
  store: PricingStore,
  options?: { force?: boolean }
): Promise<PricingSyncResult> {
  const cached = store.get(CACHE_KEY);
  const cachedManifest = isPricingManifest(cached) ? cached : undefined;
  const lastChecked = typeof store.get(CHECKED_AT_KEY) === "number" ? (store.get(CHECKED_AT_KEY) as number) : 0;

  // 非强制模式：缓存未过期则直接返回
  if (!options?.force && Date.now() - lastChecked < ONE_DAY_MS && cachedManifest) {
    return { manifest: mergePricingManifests(cachedManifest, BUNDLED_PRICING), source: "cache" };
  }

  // 尝试从 GitHub 拉取最新 pricing.json
  const etag = typeof store.get(ETAG_KEY) === "string" ? (store.get(ETAG_KEY) as string) : undefined;
  try {
    const response = await fetch(REMOTE_URL, {
      headers: etag ? { "If-None-Match": etag } : {},
      signal: AbortSignal.timeout(8_000),
    }).catch(() => undefined);

    if (response?.ok) {
      const payload = (await response.json().catch(() => undefined)) as unknown;
      if (isPricingManifest(payload)) {
        // 远端有效 → 合并：远端叠加在 BUNDLED_PRICING 之上（远端更新覆盖捆绑）
        const merged = mergePricingManifests(BUNDLED_PRICING, payload);
        await store.update(CACHE_KEY, merged);
        const nextEtag = response.headers?.get?.("ETag") ?? undefined;
        if (nextEtag) await store.update(ETAG_KEY, nextEtag);
        await store.update(CHECKED_AT_KEY, Date.now());
        ExtensionLogger.get().info(`[定价同步] 远端拉取成功, version=${merged.version}`);
        return { manifest: merged, source: "remote" };
      }
    }
    if (response?.status === 304) {
      await store.update(CHECKED_AT_KEY, Date.now());
      return { manifest: mergePricingManifests(cachedManifest ?? BUNDLED_PRICING, BUNDLED_PRICING), source: "cache" };
    }
  } catch (e) {
    ExtensionLogger.get().warn(`[定价同步] 远端拉取失败: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 远端失败 → 使用 BUNDLED_PRICING
  await store.update(CACHE_KEY, BUNDLED_PRICING);
  await store.update(CHECKED_AT_KEY, Date.now());
  return { manifest: BUNDLED_PRICING, source: "bundled" };
}

export function getCachedPricingManifest(store: PricingStore): PricingManifest {
  const cached = store.get(CACHE_KEY);
  if (!isPricingManifest(cached)) return BUNDLED_PRICING;
  return mergePricingManifests(cached, BUNDLED_PRICING);
}
