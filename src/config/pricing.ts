/** 捆绑兜底定价表：远端同步失败时回退。单价为每 1K tokens 价格，展示时换算为每 1M tokens。 */
export interface PricingEntry {
  vendor: string;
  /** 正则源码，用于匹配 modelId（大小写不敏感） */
  pattern: string;
  /** 输入价格 — 缓存未命中（cache miss），每 1K tokens */
  inputPer1k: number;
  /** 输出价格，每 1K tokens */
  outputPer1k: number;
  /** 输入价格 — 缓存命中（cache hit），每 1K tokens，可选 */
  cacheHitPer1k?: number;
  /** 缓存写入价格（每 1K tokens），可选 */
  cacheWritePer1k?: number;
  currency: string;
  effectiveDate: string;
  sourceUrl?: string;
}

export interface PricingManifest {
  version: number;
  updatedAt: string;
  entries: PricingEntry[];
}

export const BUNDLED_PRICING_VERSION = 2;

/**
 * 捆绑兜底价（2026-09-08 整理，数据来源见各条目 sourceUrl）。
 * 换算规则：官网价格（元/百万tokens）÷ 1000 = inputPer1k / outputPer1k
 *
 * 各厂商定价来源：
 * - DeepSeek: https://api-docs.deepseek.com/quick_start/pricing （USD 价格，按 1 USD ≈ 7.3 CNY 换算）
 * - Kimi: https://platform.kimi.com/docs/pricing （各模型独立定价页）
 * - MiMo: https://mimo.mi.com/docs/price/pay-as-you-go
 * - 智谱: https://open.bigmodel.cn/pricing
 * - Qwen: https://help.aliyun.com/zh/model-studio/ （模型广场）
 */
export const BUNDLED_PRICING: PricingManifest = {
  version: BUNDLED_PRICING_VERSION,
  updatedAt: "2026-09-08",
  entries: [
    // ── DeepSeek ──
    // DeepSeek V4 Pro: $0.66/1M input (off-peak) → ~¥4.82/1M; $1.98/1M output → ~¥14.45/1M
    {
      vendor: "deepseek",
      pattern: "^deepseek-v4-pro$",
      inputPer1k: 0.0048,
      outputPer1k: 0.0144,
      cacheHitPer1k: 0.0016,
      currency: "CNY",
      effectiveDate: "2026-09-08",
      sourceUrl: "https://api-docs.deepseek.com/quick_start/pricing",
    },
    // DeepSeek V4 Flash: $0.22/1M input (off-peak) → ~¥1.61/1M; $0.66/1M output → ~¥4.82/1M
    {
      vendor: "deepseek",
      pattern: "^deepseek-v4-flash",
      inputPer1k: 0.0016,
      outputPer1k: 0.0048,
      cacheHitPer1k: 0.00005,
      currency: "CNY",
      effectiveDate: "2026-09-08",
      sourceUrl: "https://api-docs.deepseek.com/quick_start/pricing",
    },
    // DeepSeek 通用兜底（chat/reasoner 等旧模型）
    {
      vendor: "deepseek",
      pattern: "deepseek",
      inputPer1k: 0.002,
      outputPer1k: 0.006,
      currency: "CNY",
      effectiveDate: "2026-09-08",
      sourceUrl: "https://api-docs.deepseek.com/quick_start/pricing",
    },

    // ── Kimi（月之暗面）──
    // Kimi K3: input ¥20/1M, output ¥100/1M, cache hit ¥2/1M
    {
      vendor: "kimi",
      pattern: "^kimi-k3$",
      inputPer1k: 0.020,
      outputPer1k: 0.100,
      cacheHitPer1k: 0.002,
      currency: "CNY",
      effectiveDate: "2026-09-08",
      sourceUrl: "https://platform.kimi.com/docs/pricing/chat-k3",
    },
    // Kimi K2.7 Code: input ¥6.50/1M, output ¥27/1M, cache hit ¥1.30/1M
    {
      vendor: "kimi",
      pattern: "^kimi-k2\\.7-code$",
      inputPer1k: 0.0065,
      outputPer1k: 0.027,
      cacheHitPer1k: 0.0013,
      currency: "CNY",
      effectiveDate: "2026-09-08",
      sourceUrl: "https://platform.kimi.com/docs/pricing/chat-k27-code",
    },
    // Kimi K2.7 Code HighSpeed: input ¥13/1M, output ¥54/1M, cache hit ¥2.60/1M
    {
      vendor: "kimi",
      pattern: "^kimi-k2\\.7-code-highspeed$",
      inputPer1k: 0.013,
      outputPer1k: 0.054,
      cacheHitPer1k: 0.0026,
      currency: "CNY",
      effectiveDate: "2026-09-08",
      sourceUrl: "https://platform.kimi.com/docs/pricing/chat-k27-code",
    },
    // Kimi K2.6: input ¥6.50/1M, output ¥27/1M, cache hit ¥1.10/1M
    {
      vendor: "kimi",
      pattern: "^kimi-k2\\.6$",
      inputPer1k: 0.0065,
      outputPer1k: 0.027,
      cacheHitPer1k: 0.0011,
      currency: "CNY",
      effectiveDate: "2026-09-08",
      sourceUrl: "https://platform.kimi.com/docs/pricing/chat-k26",
    },
    // Kimi 通用兜底
    {
      vendor: "kimi",
      pattern: "kimi|moonshot",
      inputPer1k: 0.008,
      outputPer1k: 0.027,
      currency: "CNY",
      effectiveDate: "2026-09-08",
      sourceUrl: "https://platform.kimi.com/docs/pricing",
    },

    // ── 通义千问 Qwen ──
    // Qwen3.8-max / Qwen3.7-plus: 高端模型，约 ¥20/1M input, ¥60/1M output
    {
      vendor: "qwen",
      pattern: "^qwen3\\.(7-plus|8-max)|^qwen-max",
      inputPer1k: 0.020,
      outputPer1k: 0.060,
      currency: "CNY",
      effectiveDate: "2026-09-08",
      sourceUrl: "https://help.aliyun.com/zh/model-studio/text-generation-model/",
    },
    // Qwen 通用兜底（qwen-plus, qwen-flash 等）
    {
      vendor: "qwen",
      pattern: "qwen",
      inputPer1k: 0.004,
      outputPer1k: 0.012,
      currency: "CNY",
      effectiveDate: "2026-09-08",
      sourceUrl: "https://help.aliyun.com/zh/model-studio/text-generation-model/",
    },

    // ── 智谱 GLM ──
    // GLM-5.3: input ¥8/1M, output ¥28/1M, cache hit ¥2/1M
    {
      vendor: "zhipu",
      pattern: "^glm-5\\.3$",
      inputPer1k: 0.008,
      outputPer1k: 0.028,
      cacheHitPer1k: 0.002,
      currency: "CNY",
      effectiveDate: "2026-09-08",
      sourceUrl: "https://open.bigmodel.cn/pricing",
    },
    // GLM-5.3-Flash: input ¥0.80/1M, output ¥2.80/1M, cache hit ¥0.23/1M
    {
      vendor: "zhipu",
      pattern: "^glm-5\\.3-flash",
      inputPer1k: 0.0008,
      outputPer1k: 0.0028,
      cacheHitPer1k: 0.00023,
      currency: "CNY",
      effectiveDate: "2026-09-08",
      sourceUrl: "https://open.bigmodel.cn/pricing",
    },
    // GLM-5.2: input ¥8/1M, output ¥28/1M, cache hit ¥2/1M
    {
      vendor: "zhipu",
      pattern: "^glm-5\\.2$",
      inputPer1k: 0.008,
      outputPer1k: 0.028,
      cacheHitPer1k: 0.002,
      currency: "CNY",
      effectiveDate: "2026-09-08",
      sourceUrl: "https://open.bigmodel.cn/pricing",
    },
    // GLM-5 系列兜底
    {
      vendor: "zhipu",
      pattern: "^glm-5",
      inputPer1k: 0.008,
      outputPer1k: 0.028,
      cacheHitPer1k: 0.002,
      currency: "CNY",
      effectiveDate: "2026-09-08",
      sourceUrl: "https://open.bigmodel.cn/pricing",
    },
    // GLM-4 系列: input ¥5/1M, output ¥15/1M
    {
      vendor: "zhipu",
      pattern: "^glm-4",
      inputPer1k: 0.005,
      outputPer1k: 0.015,
      currency: "CNY",
      effectiveDate: "2026-09-08",
      sourceUrl: "https://open.bigmodel.cn/pricing",
    },
    // GLM 通用兜底
    {
      vendor: "zhipu",
      pattern: "glm",
      inputPer1k: 0.005,
      outputPer1k: 0.015,
      currency: "CNY",
      effectiveDate: "2026-09-08",
      sourceUrl: "https://open.bigmodel.cn/pricing",
    },

    // ── 小米 MiMo ──
    // MiMo V2.5 Pro: input ¥3/1M, output ¥6/1M, cache hit ¥0.025/1M
    {
      vendor: "xiaomi",
      pattern: "^mimo-v2\\.5-pro",
      inputPer1k: 0.003,
      outputPer1k: 0.006,
      cacheHitPer1k: 0.000025,
      currency: "CNY",
      effectiveDate: "2026-09-08",
      sourceUrl: "https://mimo.mi.com/docs/price/pay-as-you-go",
    },
    // MiMo V2.5: input ¥1/1M, output ¥2/1M, cache hit ¥0.025/1M
    {
      vendor: "xiaomi",
      pattern: "^mimo-v2\\.5",
      inputPer1k: 0.001,
      outputPer1k: 0.002,
      cacheHitPer1k: 0.000025,
      currency: "CNY",
      effectiveDate: "2026-09-08",
      sourceUrl: "https://mimo.mi.com/docs/price/pay-as-you-go",
    },
    // MiMo 通用兜底
    {
      vendor: "xiaomi",
      pattern: "mimo",
      inputPer1k: 0.002,
      outputPer1k: 0.004,
      currency: "CNY",
      effectiveDate: "2026-09-08",
      sourceUrl: "https://mimo.mi.com/docs/price/pay-as-you-go",
    },
  ],
};

/** 按 vendor + 正则匹配单价，首个命中即返回（精确条目放前面） */
export function getPricingForModel(
  vendor: string,
  modelId: string,
  manifest: PricingManifest = BUNDLED_PRICING
): PricingEntry | undefined {
  const id = modelId.toLowerCase();
  for (const entry of manifest.entries) {
    if (entry.vendor !== vendor) continue;
    try {
      if (new RegExp(entry.pattern, "i").test(id)) return entry;
    } catch {
      continue;
    }
  }
  return undefined;
}

export function estimateCost(
  entry: PricingEntry | undefined,
  promptTokens: number,
  completionTokens: number
): number | undefined {
  if (!entry) return undefined;
  return (promptTokens / 1000) * entry.inputPer1k + (completionTokens / 1000) * entry.outputPer1k;
}

/** 远端清单覆盖本地：以 vendor+pattern 为 key，远端优先 */
export function mergePricingManifests(bundled: PricingManifest, remote: PricingManifest): PricingManifest {
  const key = (e: PricingEntry) => `${e.vendor}\u0000${e.pattern}`;
  const map = new Map<string, PricingEntry>();
  for (const e of bundled.entries) map.set(key(e), e);
  for (const e of remote.entries) map.set(key(e), e);
  return {
    version: Math.max(bundled.version, remote.version),
    updatedAt: remote.updatedAt ?? bundled.updatedAt,
    entries: [...map.values()],
  };
}

export function isPricingManifest(value: unknown): value is PricingManifest {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v["entries"])) return false;
  return (v["entries"] as unknown[]).every((e) => {
    if (typeof e !== "object" || e === null) return false;
    const r = e as Record<string, unknown>;
    return (
      typeof r["vendor"] === "string" &&
      typeof r["pattern"] === "string" &&
      typeof r["inputPer1k"] === "number" &&
      typeof r["outputPer1k"] === "number" &&
      typeof r["currency"] === "string" &&
      typeof r["effectiveDate"] === "string"
    );
  });
}

/** 定价变更描述 */
export interface PricingChange {
  vendor: string;
  model: string;
  field: string;
  oldValue: number | undefined;
  newValue: number | undefined;
}

/** 对比两份定价清单，返回变更列表 */
export function diffPricingManifests(
  oldManifest: PricingManifest,
  newManifest: PricingManifest
): PricingChange[] {
  const changes: PricingChange[] = [];
  const oldMap = new Map<string, (typeof oldManifest.entries)[0]>();
  for (const e of oldManifest.entries) oldMap.set(`${e.vendor}\u0000${e.pattern}`, e);

  for (const entry of newManifest.entries) {
    const key = `${entry.vendor}\u0000${entry.pattern}`;
    const old = oldMap.get(key);
    if (!old) {
      changes.push({ vendor: entry.vendor, model: entry.pattern, field: "新模型", oldValue: undefined, newValue: entry.inputPer1k });
      continue;
    }
    if (Math.abs(entry.inputPer1k - old.inputPer1k) > 1e-9) {
      changes.push({ vendor: entry.vendor, model: entry.pattern, field: "输入(未命中)", oldValue: old.inputPer1k, newValue: entry.inputPer1k });
    }
    if (Math.abs(entry.outputPer1k - old.outputPer1k) > 1e-9) {
      changes.push({ vendor: entry.vendor, model: entry.pattern, field: "输出", oldValue: old.outputPer1k, newValue: entry.outputPer1k });
    }
    if ((entry.cacheHitPer1k ?? 0) !== (old.cacheHitPer1k ?? 0)) {
      changes.push({ vendor: entry.vendor, model: entry.pattern, field: "输入(命中)", oldValue: old.cacheHitPer1k, newValue: entry.cacheHitPer1k });
    }
  }
  return changes;
}
