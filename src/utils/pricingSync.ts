import { BUNDLED_PRICING, isPricingManifest, mergePricingManifests } from "../config/pricing.ts";
import type { PricingManifest } from "../config/pricing.ts";
import { ExtensionLogger } from "./logger.ts";

const CACHE_KEY = "billing.pricingManifest";
const CHECKED_AT_KEY = "billing.pricingCheckedAt";
const ONE_DAY_MS = 6 * 60 * 60 * 1000;

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
 * - force=true：清除缓存，直接使用代码中的 BUNDLED_PRICING（最新定价）
 * - force=false：缓存未过期则返回缓存（与 BUNDLED_PRICING 合并），过期则返回 BUNDLED_PRICING
 */
export async function syncPricingManifest(
  store: PricingStore,
  options?: { force?: boolean }
): Promise<PricingSyncResult> {
  if (options?.force) {
    // 强制刷新：清除缓存，直接用 BUNDLED_PRICING
    await store.update(CACHE_KEY, BUNDLED_PRICING);
    await store.update(CHECKED_AT_KEY, Date.now());
    return { manifest: BUNDLED_PRICING, source: "bundled" };
  }

  const cached = store.get(CACHE_KEY);
  const cachedManifest = isPricingManifest(cached) ? cached : undefined;
  const lastChecked = typeof store.get(CHECKED_AT_KEY) === "number" ? (store.get(CHECKED_AT_KEY) as number) : 0;

  if (Date.now() - lastChecked < ONE_DAY_MS && cachedManifest) {
    // 缓存未过期，但始终与 BUNDLED_PRICING 合并确保代码更新生效
    return { manifest: mergePricingManifests(cachedManifest, BUNDLED_PRICING), source: "cache" };
  }

  // 缓存过期或不存在，使用 BUNDLED_PRICING
  await store.update(CACHE_KEY, BUNDLED_PRICING);
  await store.update(CHECKED_AT_KEY, Date.now());
  return { manifest: BUNDLED_PRICING, source: "bundled" };
}

export function getCachedPricingManifest(store: PricingStore): PricingManifest {
  const cached = store.get(CACHE_KEY);
  if (!isPricingManifest(cached)) return BUNDLED_PRICING;
  return mergePricingManifests(cached, BUNDLED_PRICING);
}
