// 覆盖纯函数（无需 vscode runtime）
import { test } from "node:test";
import assert from "node:assert/strict";

import { estimateTokens } from "../src/utils/tokenEstimator.ts";
import { SSEParser } from "../src/utils/sseParser.ts";
import { getOfficialModelMetadata } from "../src/config/modelMetadata.ts";
import { defaultFormatModelDisplayName } from "../src/providers/displayNameStrategies.ts";
import {
  defaultInferContextTokens,
  defaultInferOutputTokens,
  defaultHasInferredImageInput,
  defaultHasInferredToolCalling,
  defaultHasInferredReasoning,
} from "../src/providers/inferenceStrategies.ts";
import { createAbortSignal, cancellableSleep } from "../src/utils/cancellation.ts";
import { ExtensionLogger } from "../src/utils/logger.ts";
import {
  defaultParseBalanceResponse,
  isBalanceSupported,
  normalizeStreamUsage,
  splitCacheUsage,
  cacheHitRate,
} from "../src/providers/billingStrategies.ts";
import {
  BUNDLED_PRICING,
  diffPricingManifests,
  estimateCost,
  getPricingForModel,
  isPricingManifest,
  mergePricingManifests,
} from "../src/config/pricing.ts";
import { syncPricingManifest } from "../src/utils/pricingSync.ts";
import { getDailyUsage, recordUsage, summarizeUsage } from "../src/utils/usageStore.ts";

// ── tokenEstimator ────────────────────────────────────────────────
test("estimateTokens: 空字符串至少返回 1", () => {
  assert.equal(estimateTokens(""), 1);
});

test("estimateTokens: 中文按 0.7/字 估算", () => {
  assert.equal(estimateTokens("你好世界"), 3);
});

test("estimateTokens: 英文按 0.25/字符 估算", () => {
  // 4 字母 "test" * 0.25 = 1.0 → ceil(max 1, 1) = 1
  assert.equal(estimateTokens("test"), 1);
  // "helloworld" 是 10 字母 * 0.25 = 2.5 → ceil = 3
  assert.equal(estimateTokens("helloworld"), 3);
});

test("estimateTokens: 日文假名按 CJK 估算", () => {
  // 5 假名 * 0.7 = 3.5 → ceil = 4
  assert.equal(estimateTokens("こんにちは"), 4);
});

test("estimateTokens: 韩文按 CJK 估算", () => {
  // 2 假名 * 0.7 = 1.4 → ceil = 2
  assert.equal(estimateTokens("안녕"), 2);
});

test("estimateTokens: 混合不会归零", () => {
  assert.ok(estimateTokens("Hi 你好") >= 1);
});

// ── SSEParser ─────────────────────────────────────────────────────
test("SSEParser: 解析单条 data 事件", () => {
  const p = new SSEParser();
  const events = p.feed('data: {"a":1}\n\n');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { a: 1 });
});

test("SSEParser: 跨 chunk 保留不完整行", () => {
  const p = new SSEParser();
  assert.deepEqual(p.feed('data: {"a":'), []);
  const events = p.feed('1}\n\n');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { a: 1 });
});

test("SSEParser: 跳过注释行与 [DONE]", () => {
  const p = new SSEParser();
  const events = p.feed(': comment\ndata: {"x":1}\ndata: [DONE]\n\n');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { x: 1 });
});

test("SSEParser: flush 解析残余 buffer", () => {
  const p = new SSEParser();
  p.feed('data: {"b":2}');
  const events = p.flush();
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { b: 2 });
});

test("SSEParser: 非法 JSON 不抛异常", () => {
  const p = new SSEParser();
  const events = p.feed("data: not-json\n\n");
  assert.equal(events.length, 0);
});

test("SSEParser: reset 清空 buffer", () => {
  const p = new SSEParser();
  p.feed('data: {"a":');
  p.reset();
  assert.equal(p.flush().length, 0);
});

// ── modelMetadata ─────────────────────────────────────────────────
test("modelMetadata: kimi-k3 返回 1M 上下文", () => {
  const m = getOfficialModelMetadata("kimi", "kimi-k3");
  assert.equal(m?.contextTokens, 1_048_576);
  assert.equal(m?.reasoning, true);
});

test("modelMetadata: qwen3.8-max 启用 vision", () => {
  const m = getOfficialModelMetadata("qwen", "qwen3.8-max");
  assert.equal(m?.imageInput, true);
});

test("modelMetadata: zhipu glm-4-long 无工具调用", () => {
  const m = getOfficialModelMetadata("zhipu", "glm-4-long");
  assert.equal(m?.toolCalling, false);
});

test("modelMetadata: 未知厂商/模型返回 undefined", () => {
  assert.equal(getOfficialModelMetadata("unknown", "x"), undefined);
  assert.equal(getOfficialModelMetadata("kimi", "kimi-unknown"), undefined);
});

// ── displayNameStrategies ─────────────────────────────────────────
test("displayName: 优先使用上游 reportedName", () => {
  assert.equal(
    defaultFormatModelDisplayName("kimi-k3", "Kimi K3 旗舰版"),
    "Kimi K3 旗舰版"
  );
});

test("displayName: fallback 时格式化 modelId", () => {
  assert.equal(defaultFormatModelDisplayName("kimi-k3"), "Kimi K3");
  assert.equal(defaultFormatModelDisplayName("deepseek-r1"), "DeepSeek R1");
  // qwen3-max 命中 /^[Qq]wen/ 前缀，会被加 "通义千问 " 前缀
  assert.equal(defaultFormatModelDisplayName("qwen3-max"), "通义千问 Qwen3 Max");
});

// ── inferenceStrategies ───────────────────────────────────────────
test("inference: kimi-k3 输入 1M / 输出 131k", () => {
  assert.equal(defaultInferContextTokens("kimi-k3"), 1_048_576);
  assert.equal(defaultInferOutputTokens("kimi-k3"), 131_072);
});

test("inference: mimo 默认 256k 上下文", () => {
  assert.equal(defaultInferContextTokens("mimo-v2.5"), 262_144);
});

test("inference: 未知模型回落 128k / 16k", () => {
  assert.equal(defaultInferContextTokens("unknown-model"), 128_000);
  assert.equal(defaultInferOutputTokens("unknown-model"), 16_384);
});

test("hasInferred*: 命中正则返回 true", () => {
  assert.equal(defaultHasInferredImageInput("kimi-k2.6"), true);
  assert.equal(defaultHasInferredToolCalling("qwen3-7"), true);
  // REASONING_HINTS = /reason|thinking|kimi-k3|kimi-k2\.6|kimi-k2\.7/
  assert.equal(defaultHasInferredReasoning("kimi-k2.6"), true);
});

test("hasInferred*: 不命中返回 false", () => {
  assert.equal(defaultHasInferredImageInput("text-embedding-v1"), false);
  // mimo-v2.5 会被 TOOL_CALLING_HINTS 命中，所以改用纯 embedding
  assert.equal(defaultHasInferredToolCalling("text-embedding-v1"), false);
});

// ── cancellation ─────────────────────────────────────────────────
test("cancellableSleep: 正常等待", async () => {
  const start = Date.now();
  await cancellableSleep(makeToken(), 30);
  assert.ok(Date.now() - start >= 20);
});

test("cancellableSleep: 已取消立即抛", async () => {
  const token = makeToken(true);
  await assert.rejects(() => cancellableSleep(token, 5_000), /Cancelled/);
});

test("createAbortSignal: token 取消时 signal 立即 abort", () => {
  const token = makeToken();
  const signal = createAbortSignal(token, 10_000);
  assert.equal(signal.aborted, false);
  (token as unknown as { fire(): void }).fire();
  assert.equal(signal.aborted, true);
});

test("createAbortSignal: timeout 到期时 signal abort", async () => {
  const signal = createAbortSignal(makeToken(), 20);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(signal.aborted, true);
});

// ── logger ──────────────────────────────────────────────────────
test("logger.truncate: 超长截断到 200 字符", () => {
  const long = "x".repeat(500);
  const out = ExtensionLogger.truncate(long);
  assert.ok(out.length <= 201);
  assert.ok(out.endsWith("…"));
});

test("logger.truncate: 短文本原样返回", () => {
  assert.equal(ExtensionLogger.truncate("ok"), "ok");
});

test("logger: 未 init 时打日志不抛异常", () => {
  const logger = ExtensionLogger.get();
  logger.info("hello");
  logger.warn("warn");
  logger.error("err");
});

function makeToken(preCancelled = false): unknown {
  const handlers: Array<() => void> = [];
  return {
    isCancellationRequested: preCancelled,
    onCancellationRequested(h: () => void) {
      handlers.push(h);
      return { dispose: () => {} };
    },
    fire() {
      this.isCancellationRequested = true;
      for (const h of handlers) h();
    },
  };
}

// ── billingStrategies ───────────────────────────────────────────
test("billing: DeepSeek balance_infos 解析", () => {
  const parse = defaultParseBalanceResponse("deepseek");
  const r = parse(
    { balance_infos: [{ currency: "CNY", total_balance: 10.5, granted_balance: 2, topped_up_balance: 8.5 }] },
    "deepseek"
  );
  assert.equal(r?.available, 10.5);
  assert.equal(r?.currency, "CNY");
});

test("billing: Kimi 多形态余额兼容", () => {
  const parse = defaultParseBalanceResponse("kimi");
  assert.equal(parse({ available_balance: 3.2 }, "kimi")?.available, 3.2);
  assert.equal(parse({ data: { balance: "7" } }, "kimi")?.available, 7);
  assert.equal(parse({ nope: 1 }, "kimi"), undefined);
});

test("billing: normalizeStreamUsage 兼容 input/output 命名", () => {
  assert.deepEqual(normalizeStreamUsage({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }), {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
    prompt_cache_hit_tokens: undefined,
    prompt_cache_miss_tokens: undefined,
    cached_tokens: undefined,
  });
  const alt = normalizeStreamUsage({ choices: [{ usage: { input_tokens: 4, output_tokens: 6 } }] });
  assert.equal(alt?.prompt_tokens, 4);
  assert.equal(alt?.total_tokens, 10);
  assert.equal(normalizeStreamUsage({ choices: [{}] }), undefined);
});

test("billing: 缓存命中多形态归一化（details/cached_tokens）", () => {
  const a = normalizeStreamUsage({ usage: { prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 30, prompt_cache_miss_tokens: 70 } });
  assert.equal(a?.prompt_cache_hit_tokens, 30);
  assert.equal(a?.prompt_cache_miss_tokens, 70);
  const b = normalizeStreamUsage({ usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 40 } } });
  assert.equal(b?.prompt_cache_hit_tokens, 40);
  const c = normalizeStreamUsage({ usage: { prompt_tokens: 50, cached_tokens: 20 } });
  assert.equal(c?.prompt_cache_hit_tokens, 20);
});

test("billing: splitCacheUsage 拆分命中/未命中/输出并钳制异常", () => {
  assert.deepEqual(splitCacheUsage({ prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 30 }), { hit: 30, miss: 70, output: 20 });
  // 未返回缓存字段：命中 0、未命中 = 输入
  assert.deepEqual(splitCacheUsage({ prompt_tokens: 100, completion_tokens: 5 }), { hit: 0, miss: 100, output: 5 });
  // hit > prompt 防御钳制
  assert.deepEqual(splitCacheUsage({ prompt_tokens: 10, prompt_cache_hit_tokens: 99 }), { hit: 10, miss: 0, output: 0 });
  assert.equal(cacheHitRate(30, 70), 0.3);
  assert.equal(cacheHitRate(0, 0), undefined);
});

test("billing: isBalanceSupported 以 endpoint 判定", () => {
  assert.equal(isBalanceSupported({ vendor: "a", displayName: "a", defaultBaseUrl: "https://x", getAuthHeaders: () => ({}), buildRequestBody: () => ({}), parseStreamChunk: () => null, balanceEndpoint: "https://x/b" } as never), true);
  assert.equal(isBalanceSupported({ vendor: "a", displayName: "a", defaultBaseUrl: "https://x", getAuthHeaders: () => ({}), buildRequestBody: () => ({}), parseStreamChunk: () => null, supportsBalance: false } as never), false);
});

// ── pricing ─────────────────────────────────────────────────────
test("pricing: 精确条目优先于通用回退", () => {
  const pro = getPricingForModel("deepseek", "deepseek-v4-pro");
  assert.equal(pro?.inputPer1k, 0.0048);
  const flash = getPricingForModel("deepseek", "deepseek-v4-flash-thinking");
  assert.equal(flash?.inputPer1k, 0.0016);
  assert.equal(getPricingForModel("qwen", "unknown-xyz"), undefined);
});

test("pricing: estimateCost 按 1K 单价计算", () => {
  const entry = getPricingForModel("kimi", "kimi-k3");
  // Kimi K3: input ¥20/1M → 0.020/1K, output ¥100/1M → 0.100/1K
  // 1000 input + 1000 output = 0.020 + 0.100 = 0.120
  assert.ok(Math.abs((estimateCost(entry, 1000, 1000) ?? 0) - 0.120) < 1e-9);
  assert.equal(estimateCost(undefined, 1, 1), undefined);
});

test("pricing: 远端覆盖本地同 key", () => {
  const merged = mergePricingManifests(BUNDLED_PRICING, {
    version: 2,
    updatedAt: "2026-09-07",
    entries: [{ vendor: "kimi", pattern: "^kimi-k3$", inputPer1k: 0.02, outputPer1k: 0.05, currency: "CNY", effectiveDate: "2026-09-07" }],
  });
  assert.equal(getPricingForModel("kimi", "kimi-k3", merged)?.inputPer1k, 0.02);
  assert.equal(merged.version, 2);
});

test("pricing: 非法 manifest 判定失败", () => {
  assert.equal(isPricingManifest({ entries: [{ vendor: "x" }] }), false);
  assert.equal(isPricingManifest(BUNDLED_PRICING), true);
});

test("pricing: diffPricingManifests 检测变更", () => {
  const changes = diffPricingManifests(BUNDLED_PRICING, {
    version: 3,
    updatedAt: "2026-09-10",
    entries: [
      // 价格变更
      { vendor: "kimi", pattern: "^kimi-k3$", inputPer1k: 0.025, outputPer1k: 0.100, currency: "CNY", effectiveDate: "2026-09-10" },
      // 未变更
      ...BUNDLED_PRICING.entries.filter((e) => !(e.vendor === "kimi" && e.pattern === "^kimi-k3$")),
    ],
  });
  assert.ok(changes.length > 0);
  assert.equal(changes[0].vendor, "kimi");
  assert.equal(changes[0].field, "输入(未命中)");
  // 相同清单应返回空变更
  const noChanges = diffPricingManifests(BUNDLED_PRICING, BUNDLED_PRICING);
  assert.equal(noChanges.length, 0);
});

test("pricingSync: 远端失败回退捆绑表", async () => {
  const mem = new Map<string, unknown>();
  const store = { get: (k: string) => mem.get(k), update: (k: string, v: unknown) => { mem.set(k, v); } };
  const failing = async () => { throw new Error("down"); };
  const r = await syncPricingManifest(store, { force: true, fetchFn: failing as never });
  assert.equal(r.source, "bundled");
  assert.equal(r.manifest.version, BUNDLED_PRICING.version);
});

test("pricingSync: 304 沿用缓存", async () => {
  const mem = new Map<string, unknown>([["billing.pricingManifest", BUNDLED_PRICING]]);
  const store = { get: (k: string) => mem.get(k), update: (k: string, v: unknown) => { mem.set(k, v); } };
  const notModified = async () => ({ status: 304, ok: false, body: { cancel: async () => undefined }, headers: { get: () => null } });
  const r = await syncPricingManifest(store, { force: true, fetchFn: notModified as never });
  assert.equal(r.source, "cache");
});

// ── usageStore ──────────────────────────────────────────────────
function makeMemStore(): { get(k: string): unknown; update(k: string, v: unknown): void; mem: Map<string, unknown> } {
  const mem = new Map<string, unknown>();
  return { mem, get: (k: string) => mem.get(k), update: (k: string, v: unknown) => { mem.set(k, v); } };
}

test("usageStore: 累加同日同模型用量与费用", () => {
  const s = makeMemStore();
  recordUsage(s, "kimi", "kimi-k3", { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 }, BUNDLED_PRICING);
  recordUsage(s, "kimi", "kimi-k3", { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 }, BUNDLED_PRICING);
  const daily = getDailyUsage(s);
  assert.equal(daily.length, 1);
  assert.equal(daily[0].totalTokens, 3000);
  assert.equal(daily[0].count, 2);
  assert.ok((daily[0].estimatedCost ?? 0) > 0);
  const sum = summarizeUsage(daily);
  assert.equal(sum.totalTokens, 3000);
});

test("usageStore: 无定价时仅记 tokens", () => {
  const s = makeMemStore();
  const r = recordUsage(s, "x", "m", { total_tokens: 9 });
  assert.equal(r.totalTokens, 9);
  assert.equal(r.estimatedCost, undefined);
});

test("usageStore: 多厂商混合时可按 vendor 过滤（单厂商面板用）", () => {
  const s = makeMemStore();
  recordUsage(s, "kimi", "kimi-k3", { total_tokens: 100 }, BUNDLED_PRICING);
  recordUsage(s, "deepseek", "deepseek-v4-pro", { total_tokens: 200 }, BUNDLED_PRICING);
  const kimiOnly = getDailyUsage(s).filter((r) => r.vendor === "kimi");
  assert.equal(kimiOnly.length, 1);
  assert.equal(summarizeUsage(kimiOnly).totalTokens, 100);
  const dsOnly = getDailyUsage(s).filter((r) => r.vendor === "deepseek");
  assert.equal(summarizeUsage(dsOnly).totalTokens, 200);
});

test("usageStore: 缓存命中拆分累计与命中率", () => {
  const s = makeMemStore();
  recordUsage(s, "deepseek", "deepseek-v4-pro", { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_cache_hit_tokens: 30, prompt_cache_miss_tokens: 70 }, BUNDLED_PRICING);
  recordUsage(s, "deepseek", "deepseek-v4-pro", { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_cache_hit_tokens: 50, prompt_cache_miss_tokens: 50 }, BUNDLED_PRICING);
  const sum = summarizeUsage(getDailyUsage(s));
  assert.equal(sum.cacheHitTokens, 80);
  assert.equal(sum.cacheMissTokens, 120);
  assert.equal(sum.completionTokens, 40);
  assert.ok(Math.abs((sum.hitRate ?? 0) - 0.4) < 1e-9);
});

test("usageStore: 无缓存字段时命中率 undefined（UI 显示 -）", () => {
  const s = makeMemStore();
  recordUsage(s, "kimi", "kimi-k3", { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  const sum = summarizeUsage(getDailyUsage(s));
  assert.equal(sum.cacheHitTokens, 0);
  assert.equal(sum.cacheMissTokens, 10);
  assert.equal(sum.hitRate, 0);
});
