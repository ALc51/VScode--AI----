import { BUNDLED_PRICING, isPricingManifest, mergePricingManifests } from "../config/pricing.ts";
import type { PricingManifest } from "../config/pricing.ts";
import { ExtensionLogger } from "./logger.ts";

const CACHE_KEY = "billing.pricingManifest";
const ETAG_KEY = "billing.pricingEtag";
const CHECKED_AT_KEY = "billing.pricingCheckedAt";
const ONE_DAY_MS = 6 * 60 * 60 * 1000;

// GitHub raw URL for auto-updated pricing data
const GITHUB_RAW_URL = "https://raw.githubusercontent.com/ALc51/VScode--AI----/main/pricing.json";

export interface PricingStore {
  get(key: string): unknown;
  update(key: string, value: unknown): Promise<void> | void;
}

export interface PricingSyncResult {
  manifest: PricingManifest;
  source: "remote" | "cache" | "bundled";
}

/** 同步定价清单：从 GitHub 获取最新定价，失败时使用捆绑定价 */
export async function syncPricingManifest(
  store: PricingStore,
  options?: { force?: boolean; fetchFn?: typeof fetch; manifestUrl?: string }
): Promise<PricingSyncResult> {
  const cached = store.get(CACHE_KEY);
  const cachedManifest = isPricingManifest(cached) ? cached : undefined;
  const lastChecked = typeof store.get(CHECKED_AT_KEY) === "number" ? (store.get(CHECKED_AT_KEY) as number) : 0;
  if (!options?.force && Date.now() - lastChecked < ONE_DAY_MS && cachedManifest) {
    // 始终与最新 BUNDLED_PRICING 合并，确保代码更新后新定价能生效
    return { manifest: mergePricingManifests(BUNDLED_PRICING, cachedManifest), source: "cache" };
  }

  const fetchFn = options?.fetchFn ?? fetch;
  const url = options?.manifestUrl ?? GITHUB_RAW_URL;
  const etag = typeof store.get(ETAG_KEY) === "string" ? (store.get(ETAG_KEY) as string) : undefined;
  try {
    const response = await fetchFn(url, {
      headers: etag ? { "If-None-Match": etag } : {},
      signal: AbortSignal.timeout(8_000),
    }).catch(() => undefined);
    if (!response) {
      const fallback = cachedManifest ? mergePricingManifests(BUNDLED_PRICING, cachedManifest) : BUNDLED_PRICING;
      return { manifest: fallback, source: cachedManifest ? "cache" : "bundled" };
    }
    if (response.status === 304) {
      await store.update(CHECKED_AT_KEY, Date.now());
      await response.body?.cancel().catch(() => undefined);
      const fallback = cachedManifest ? mergePricingManifests(BUNDLED_PRICING, cachedManifest) : BUNDLED_PRICING;
      return { manifest: fallback, source: cachedManifest ? "cache" : "bundled" };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      const fallback = cachedManifest ? mergePricingManifests(BUNDLED_PRICING, cachedManifest) : BUNDLED_PRICING;
      return { manifest: fallback, source: cachedManifest ? "cache" : "bundled" };
    }
    const payload = (await response.json().catch(() => undefined)) as unknown;
    if (!isPricingManifest(payload)) {
      const fallback = cachedManifest ? mergePricingManifests(BUNDLED_PRICING, cachedManifest) : BUNDLED_PRICING;
      return { manifest: fallback, source: cachedManifest ? "cache" : "bundled" };
    }
    const merged = mergePricingManifests(BUNDLED_PRICING, payload);
    await store.update(CACHE_KEY, merged);
    const nextEtag = response.headers?.get?.("ETag") ?? undefined;
    if (nextEtag) await store.update(ETAG_KEY, nextEtag);
    await store.update(CHECKED_AT_KEY, Date.now());
    return { manifest: merged, source: "remote" };
  } catch (err) {
    const fallback = cachedManifest ? mergePricingManifests(BUNDLED_PRICING, cachedManifest) : BUNDLED_PRICING;
    return { manifest: fallback, source: cachedManifest ? "cache" : "bundled" };
  }
}

export function getCachedPricingManifest(store: PricingStore): PricingManifest {
  const cached = store.get(CACHE_KEY);
  if (!isPricingManifest(cached)) return BUNDLED_PRICING;
  // 始终与最新 BUNDLED_PRICING 合并，确保代码更新后新定价能生效
  return mergePricingManifests(BUNDLED_PRICING, cached);
}
