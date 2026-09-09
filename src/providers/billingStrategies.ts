import type { BalanceResult, ChatStreamUsage, ProviderConfig } from "../types.ts";

/** 通用数字解析：兼容 string/number，失败返回 undefined */
function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value.trim());
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 从 payload 中按候选 key 查找数字（支持嵌套 data 对象一层） */
function findNumber(payload: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const v = toNumber(payload[key]);
    if (v !== undefined) return v;
  }
  const nested = payload["data"];
  if (isRecord(nested)) {
    for (const key of keys) {
      const v = toNumber(nested[key]);
      if (v !== undefined) return v;
    }
  }
  return undefined;
}

function findString(payload: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = payload[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  const nested = payload["data"];
  if (isRecord(nested)) {
    for (const key of keys) {
      const v = nested[key];
      if (typeof v === "string" && v.length > 0) return v;
    }
  }
  return undefined;
}

/**
 * DeepSeek GET /user/balance 解析
 * 形如 { is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }
 */
function parseDeepseekBalance(payload: unknown, vendor: string): BalanceResult | undefined {
  if (!isRecord(payload)) return undefined;
  const infos = payload["balance_infos"];
  const list = Array.isArray(infos) ? infos : isRecord(payload["data"]) && Array.isArray((payload["data"] as Record<string, unknown>)["balance_infos"])
    ? (payload["data"] as Record<string, unknown>)["balance_infos"] as unknown[]
    : undefined;
  if (list && list.length > 0 && isRecord(list[0])) {
    const first = list[0] as Record<string, unknown>;
    const total = toNumber(first["total_balance"]);
    const granted = toNumber(first["granted_balance"]);
    const toppedUp = toNumber(first["topped_up_balance"]);
    const currency = typeof first["currency"] === "string" ? (first["currency"] as string) : "CNY";
    if (total !== undefined) {
      return { vendor, available: total, total, granted, toppedUp, currency, raw: payload, updatedAt: Date.now() };
    }
  }
  // 降级：通用字段
  return parseGenericBalance(payload, vendor);
}

/** Kimi GET /v1/users/me/balance 解析（文档不稳定，多形态兼容） */
function parseKimiBalance(payload: unknown, vendor: string): BalanceResult | undefined {
  if (!isRecord(payload)) return undefined;
  const available = findNumber(payload, [
    "available_balance", "available", "balance", "remaining_balance",
    "cash_balance", "total_balance", "credit", "quota",
  ]);
  const currency = findString(payload, ["currency", "unit"]) ?? "CNY";
  if (available !== undefined) {
    return {
      vendor,
      available,
      currency,
      total: findNumber(payload, ["total_balance", "total", "cash_balance"]),
      granted: findNumber(payload, ["voucher_balance", "granted_balance", "gift_balance"]),
      toppedUp: findNumber(payload, ["topped_up_balance", "recharge_balance"]),
      raw: payload,
      updatedAt: Date.now(),
    };
  }
  return parseGenericBalance(payload, vendor);
}

/** 通用 OpenAI 兼容解析：多候选 key */
function parseGenericBalance(payload: unknown, vendor: string): BalanceResult | undefined {
  if (!isRecord(payload)) return undefined;
  const available = findNumber(payload, [
    "available", "available_balance", "balance", "remaining", "remaining_balance",
    "total_balance", "credit_balance", "credit", "quota", "funds",
  ]);
  if (available === undefined) return undefined;
  return {
    vendor,
    available,
    currency: findString(payload, ["currency", "unit"]) ?? "CNY",
    total: findNumber(payload, ["total", "total_balance"]),
    granted: findNumber(payload, ["granted", "granted_balance", "voucher_balance"]),
    toppedUp: findNumber(payload, ["topped_up", "topped_up_balance"]),
    raw: payload,
    updatedAt: Date.now(),
  };
}

/** 按 vendor 分发的默认余额解析（供各厂商复用，可被 ProviderConfig.parseBalanceResponse 覆盖） */
export const defaultParseBalanceResponse =
  (vendor: string) =>
  (payload: unknown): BalanceResult | undefined => {
    if (vendor === "deepseek") return parseDeepseekBalance(payload, vendor);
    if (vendor === "kimi") return parseKimiBalance(payload, vendor);
    return parseGenericBalance(payload, vendor);
  };

/** 是否支持余额查询（默认以 balanceEndpoint 是否存在判定） */
export function isBalanceSupported(config: ProviderConfig): boolean {
  return config.supportsBalance ?? (typeof config.balanceEndpoint === "string" && config.balanceEndpoint.length > 0);
}

/**
 * 从流式事件中提取 usage（兼容顶层 usage / choices[0].usage / message.usage）
 * 返回归一化后的 ChatStreamUsage，无则 undefined
 */
export function normalizeStreamUsage(event: Record<string, unknown>): ChatStreamUsage | undefined {
  const candidates: unknown[] = [event["usage"]];
  if (Array.isArray(event["choices"]) && event["choices"].length > 0) {
    const first = event["choices"][0] as unknown;
    if (isRecord(first)) candidates.push(first["usage"]);
  }
  const message = event["message"];
  if (isRecord(message)) candidates.push(message["usage"]);
  for (const c of candidates) {
    if (!isRecord(c)) continue;
    const prompt = toNumber(c["prompt_tokens"] ?? c["input_tokens"] ?? c["promptTokens"]);
    const completion = toNumber(c["completion_tokens"] ?? c["output_tokens"] ?? c["completionTokens"]);
    const total = toNumber(c["total_tokens"] ?? c["totalTokens"])
      ?? (prompt !== undefined || completion !== undefined ? (prompt ?? 0) + (completion ?? 0) : undefined);
    // 缓存命中拆分：兼容 prompt_cache_hit_tokens / cached_tokens / prompt_tokens_details.cached_tokens
    const details = isRecord(c["prompt_tokens_details"]) ? (c["prompt_tokens_details"] as Record<string, unknown>) : undefined;
    const hit = toNumber(
      c["prompt_cache_hit_tokens"] ?? c["cached_tokens"] ?? c["cache_hit_tokens"] ?? c["cache_read_tokens"]
      ?? details?.["cached_tokens"] ?? details?.["cache_hit_tokens"]
    );
    const miss = toNumber(c["prompt_cache_miss_tokens"] ?? c["cache_miss_tokens"] ?? details?.["cache_miss_tokens"]);
    if (prompt !== undefined || completion !== undefined || total !== undefined) {
      return {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: total ?? (prompt ?? 0) + (completion ?? 0),
        prompt_cache_hit_tokens: hit,
        prompt_cache_miss_tokens: miss,
        cached_tokens: toNumber(c["cached_tokens"]) ?? hit,
      };
    }
  }
  return undefined;
}

/** 从归一化 usage 中拆出 输入(命中缓存) / 输入(未命中缓存) / 输出 */
export function splitCacheUsage(usage: ChatStreamUsage): { hit: number; miss: number; output: number } {
  const prompt = Math.max(0, Math.floor(usage.prompt_tokens ?? 0));
  const output = Math.max(0, Math.floor(usage.completion_tokens ?? 0));
  const rawHit = usage.prompt_cache_hit_tokens ?? usage.cached_tokens;
  let hit = rawHit !== undefined ? Math.max(0, Math.floor(rawHit)) : 0;
  let miss = usage.prompt_cache_miss_tokens !== undefined ? Math.max(0, Math.floor(usage.prompt_cache_miss_tokens)) : prompt - hit;
  // 防御：上游偶发 hit > prompt 时钳制，避免 miss 为负
  if (hit > prompt) hit = prompt;
  if (miss < 0) miss = 0;
  if (hit + miss > prompt && prompt > 0) miss = prompt - hit;
  return { hit, miss: Math.max(0, miss), output };
}

/** 缓存命中率 = 命中 / 输入总量（无输入时返回 undefined，由 UI 显示“-”） */
export function cacheHitRate(hit: number, miss: number): number | undefined {
  const total = hit + miss;
  return total > 0 ? hit / total : undefined;
}
