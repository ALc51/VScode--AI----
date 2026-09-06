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
