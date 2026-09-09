#!/usr/bin/env node
/**
 * 定价自动检测脚本
 *
 * 从各厂商官网抓取最新定价，与本地捆绑定价表对比。
 * 检测到变更时输出差异报告（供 GitHub Actions 创建 Issue）。
 *
 * 用法：node scripts/check-pricing.mjs
 * 环境变量 USE_PLAYWRIGHT=1 启用 Playwright（SPA 页面渲染）
 * 输出：Markdown 格式的检测报告
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ── Playwright 加载 ──────────────────────────────────────
let playwright = null;

/**
 * 获取页面渲染后的纯文本（非原始 HTML）
 * 关键：用 page.evaluate(() => document.body.innerText) 而非 page.content()
 */
async function getPageText(url) {
  if (!playwright) {
    try { playwright = await import("playwright"); } catch { return null; }
  }
  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 20_000 });
    return await page.evaluate(() => document.body.innerText);
  } finally {
    await browser.close();
  }
}

// ── 实时汇率 ──────────────────────────────────────────────
const DEFAULT_USD_CNY = 7.3;

async function fetchUsdCnyRate() {
  // 免费汇率 API（无需 key）
  const apis = [
    { url: "https://open.er-api.com/v6/latest/USD", extract: (d) => d.rates?.CNY },
    { url: "https://api.exchangerate-api.com/v4/latest/USD", extract: (d) => d.rates?.CNY },
  ];
  for (const api of apis) {
    try {
      const res = await fetch(api.url, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) continue;
      const data = await res.json();
      const rate = api.extract(data);
      if (typeof rate === "number" && rate > 5 && rate < 10) return rate;
    } catch {
      continue;
    }
  }
  return DEFAULT_USD_CNY;
}

// ── 当前捆绑定价表 ──────────────────────────────────────────
const bundledPricingPath = resolve(ROOT, "src", "config", "pricing.ts");

/**
 * 从 pricing.ts 源码中提取 BUNDLED_PRICING 的条目
 * 简单正则提取，避免需要编译 TS
 */
function extractBundledPrices() {
  const src = readFileSync(bundledPricingPath, "utf-8");
  const entries = [];
  // 匹配每个 entry 块
  const entryRegex =
    /vendor:\s*"([^"]+)",\s*\n\s*pattern:\s*"([^"]+)",\s*\n\s*inputPer1k:\s*([\d.]+),\s*\n\s*outputPer1k:\s*([\d.]+),\s*\n(?:\s*cacheHitPer1k:\s*([\d.]+),\s*\n)?/g;
  let m;
  while ((m = entryRegex.exec(src))) {
    entries.push({
      vendor: m[1],
      pattern: m[2],
      inputPer1k: parseFloat(m[3]),
      outputPer1k: parseFloat(m[4]),
      cacheHitPer1k: m[5] ? parseFloat(m[5]) : undefined,
    });
  }
  return entries;
}

// ── 厂商抓取器 ──────────────────────────────────────────────

/** DeepSeek: 获取渲染后的纯文本 */
async function fetchDeepSeekPrices() {
  try {
    const text = await getPageText("https://api-docs.deepseek.com/quick_start/pricing");
    return text ? { ok: true, text, vendor: "deepseek" } : { ok: false, error: "Playwright 未安装或页面加载失败" };
  } catch (e) { return { ok: false, error: e.message }; }
}

/** MiMo: 获取渲染后的纯文本 */
async function fetchMiMoPrices() {
  try {
    const text = await getPageText("https://mimo.mi.com/docs/price/pay-as-you-go");
    return text ? { ok: true, text, vendor: "xiaomi" } : { ok: false, error: "Playwright 未安装或页面加载失败" };
  } catch (e) { return { ok: false, error: e.message }; }
}

/** Kimi: 获取各模型定价页面纯文本 */
async function fetchKimiPrices() {
  const pages = [
    { model: "kimi-k3", url: "https://platform.kimi.com/docs/pricing/chat-k3" },
    { model: "kimi-k2.7-code", url: "https://platform.kimi.com/docs/pricing/chat-k27-code" },
    { model: "kimi-k2.6", url: "https://platform.kimi.com/docs/pricing/chat-k26" },
  ];
  const results = [];
  for (const p of pages) {
    try {
      const text = await getPageText(p.url);
      results.push(text ? { ...p, ok: true, text } : { ...p, ok: false, error: "页面加载失败" });
    } catch (e) { results.push({ ...p, ok: false, error: e.message }); }
  }
  return { ok: true, vendor: "kimi", pages: results };
}

/** 智谱 */
async function fetchZhipuPrices() {
  try {
    const text = await getPageText("https://open.bigmodel.cn/pricing");
    return text ? { ok: true, text, vendor: "zhipu" } : { ok: false, vendor: "zhipu", error: "页面加载失败" };
  } catch (e) { return { ok: false, vendor: "zhipu", error: e.message }; }
}

/** Qwen */
async function fetchQwenPrices() {
  return { ok: false, vendor: "qwen", error: "Qwen 定价分散在多个页面，暂不支持自动抓取" };
}

// ── 解析器 ──────────────────────────────────────────────────

/**
 * 从 DeepSeek 纯文本中解析定价
 * 文本格式：
 *   1M INPUT TOKENS (CACHE HIT) | OFF-PEAK | $0.007 | $0.022 | $0.007
 *   1M INPUT TOKENS (CACHE MISS) | OFF-PEAK | $0.22 | $0.66 | $0.22
 *   1M OUTPUT TOKENS | OFF-PEAK | $0.66 | $1.98 | $0.66
 * 列顺序: [label] | [sublabel] | flash | pro | vision-exp
 */
function parseDeepSeekPricing(text, usdCny = DEFAULT_USD_CNY) {
  const results = [];
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);

  let hitPrices = null, missPrices = null, outPrices = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 匹配价格行：包含 $ 和 OFF-PEAK
    const priceMatch = line.match(/\$([\d.]+)\s*\|\s*\$([\d.]+)\s*\|\s*\$([\d.]+)/);
    if (!priceMatch) continue;

    // 往回找标签行
    const context = lines.slice(Math.max(0, i - 3), i + 1).join(" ").toUpperCase();

    if (context.includes("CACHE HIT") && context.includes("OFF-PEAK")) {
      hitPrices = [parseFloat(priceMatch[1]), parseFloat(priceMatch[2]), parseFloat(priceMatch[3])];
    } else if (context.includes("CACHE MISS") && context.includes("OFF-PEAK")) {
      missPrices = [parseFloat(priceMatch[1]), parseFloat(priceMatch[2]), parseFloat(priceMatch[3])];
    } else if (context.includes("OUTPUT") && context.includes("OFF-PEAK") && !context.includes("INPUT")) {
      outPrices = [parseFloat(priceMatch[1]), parseFloat(priceMatch[2]), parseFloat(priceMatch[3])];
    }
  }

  if (missPrices && outPrices) {
    const models = ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-flash-vision-exp"];
    for (let i = 0; i < models.length; i++) {
      results.push({
        model: models[i],
        inputPer1M: +(missPrices[i] * usdCny).toFixed(2),
        outputPer1M: +(outPrices[i] * usdCny).toFixed(2),
        cacheHitPer1M: hitPrices ? +(hitPrices[i] * usdCny).toFixed(2) : undefined,
      });
    }
  }
  return results;
}

/**
 * 从 MiMo 纯文本中解析定价
 * 文本格式：
 *   mimo-v2.5-pro | ¥0.025 | ¥3.00 | ¥6.00
 *   mimo-v2.5 | ¥0.02 | ¥1.00 | ¥2.00
 * 列顺序: model | cache_hit | input | output
 */
function parseMiMoPricing(text) {
  const results = [];
  const regex = /(mimo-v2\.5\S*)\s*\|\s*¥([\d.]+)\s*\|\s*¥([\d.]+)\s*\|\s*¥([\d.]+)/g;
  let m;
  while ((m = regex.exec(text))) {
    results.push({
      model: m[1],
      cacheHitPer1M: parseFloat(m[2]),
      inputPer1M: parseFloat(m[3]),
      outputPer1M: parseFloat(m[4]),
    });
  }
  return results;
}

/**
 * 从 Kimi 纯文本中解析定价
 * 文本格式（DocTable 渲染后）：
 *   kimi-k3 | 1M tokens | ¥2.00 | ¥20.00 | ¥100.00 | 1,048,576 tokens
 * 列顺序: model | unit | cache_hit | input | output | context
 */
function parseKimiPricing(pages) {
  const results = [];
  for (const page of pages) {
    if (!page.ok) continue;
    const regex = /(kimi-k[\d.a-z-]+)\s*\|\s*1M tokens\s*\|\s*¥([\d.]+)\s*\|\s*¥([\d.]+)\s*\|\s*¥([\d.]+)/;
    const m = page.text.match(regex);
    if (m) {
      results.push({
        model: m[1],
        cacheHitPer1M: parseFloat(m[2]),
        inputPer1M: parseFloat(m[3]),
        outputPer1M: parseFloat(m[4]),
      });
    }
  }
  return results;
}

/**
 * 从智谱纯文本中解析定价
 * 文本格式：
 *   GLM-5.3 ... 输入单价8元 / M 输出单价28元 / M 缓存命中2元 / M
 */
function parseZhipuPricing(text) {
  const results = [];
  // 匹配 GLM-X.X 系列
  const regex = /(GLM-[\d.]+(?:-Flash)?)\s+.*?输入单价([\d.]+)元\s*\/\s*M\s+输出单价([\d.]+)元\s*\/\s*M\s+缓存命中([\d.]+)元\s*\/\s*M/gi;
  let m;
  while ((m = regex.exec(text))) {
    results.push({
      model: m[1].toLowerCase(),
      inputPer1M: parseFloat(m[2]),
      outputPer1M: parseFloat(m[3]),
      cacheHitPer1M: parseFloat(m[4]),
    });
  }
  return results;
}

// ── 对比引擎 ──────────────────────────────────────────────

const USD_TO_CNY = 7.3;

function toPer1k(per1M) {
  return +(per1M / 1000).toFixed(6);
}

function diffVendor(bundled, fetched, vendor) {
  const vendorBundled = bundled.filter((e) => e.vendor === vendor);
  const changes = [];

  for (const f of fetched) {
    // 找到匹配的捆绑条目（按 pattern 正则匹配 model id）
    const matched = vendorBundled.find((b) => {
      try {
        return new RegExp(b.pattern, "i").test(f.model);
      } catch {
        return false;
      }
    });

    if (!matched) {
      changes.push({
        type: "new_model",
        model: f.model,
        input: f.inputPer1M,
        output: f.outputPer1M,
        cacheHit: f.cacheHitPer1M,
      });
      continue;
    }

    const inputBundle = +(matched.inputPer1k * 1000).toFixed(2);
    const outputBundle = +(matched.outputPer1k * 1000).toFixed(2);
    const cacheHitBundle = matched.cacheHitPer1k
      ? +(matched.cacheHitPer1k * 1000).toFixed(2)
      : undefined;

    const inputDiff = f.inputPer1M !== undefined && Math.abs(f.inputPer1M - inputBundle) > 0.01;
    const outputDiff = f.outputPer1M !== undefined && Math.abs(f.outputPer1M - outputBundle) > 0.01;
    const cacheHitDiff =
      f.cacheHitPer1M !== undefined &&
      (!cacheHitBundle || Math.abs(f.cacheHitPer1M - cacheHitBundle) > 0.01);

    if (inputDiff || outputDiff || cacheHitDiff) {
      changes.push({
        type: "price_change",
        model: f.model,
        bundled: { input: inputBundle, output: outputBundle, cacheHit: cacheHitBundle },
        fetched: { input: f.inputPer1M, output: f.outputPer1M, cacheHit: f.cacheHitPer1M },
      });
    }
  }

  return changes;
}

// ── 主流程 ──────────────────────────────────────────────

async function main() {
  const bundled = extractBundledPrices();
  const allChanges = {};
  const errors = {};

  // 获取实时汇率
  const usdCny = await fetchUsdCnyRate();

  // 并发抓取所有厂商（Playwright 渲染后取 innerText）
  const [deepseek, mimo, kimi, zhipu, qwen] = await Promise.all([
    fetchDeepSeekPrices(),
    fetchMiMoPrices(),
    fetchKimiPrices(),
    fetchZhipuPrices(),
    fetchQwenPrices(),
  ]);

  // DeepSeek
  if (deepseek.ok) {
    const fetched = parseDeepSeekPricing(deepseek.text, usdCny);
    if (fetched.length > 0) {
      allChanges.deepseek = diffVendor(bundled, fetched, "deepseek");
    } else {
      errors.deepseek = "无法从页面文本中解析定价数据";
    }
  } else {
    errors.deepseek = deepseek.error;
  }

  // MiMo
  if (mimo.ok) {
    const fetched = parseMiMoPricing(mimo.text);
    if (fetched.length > 0) {
      allChanges.xiaomi = diffVendor(bundled, fetched, "xiaomi");
    } else {
      errors.xiaomi = "无法从页面文本中解析定价数据";
    }
  } else {
    errors.xiaomi = mimo.error;
  }

  // Kimi
  if (kimi.ok) {
    const fetched = parseKimiPricing(kimi.pages);
    if (fetched.length > 0) {
      allChanges.kimi = diffVendor(bundled, fetched, "kimi");
    } else {
      errors.kimi = "无法从页面文本中解析定价数据";
    }
  } else {
    errors.kimi = kimi.error;
  }

  // 智谱
  if (zhipu.ok) {
    const fetched = parseZhipuPricing(zhipu.text);
    if (fetched.length > 0) {
      allChanges.zhipu = diffVendor(bundled, fetched, "zhipu");
    } else {
      errors.zhipu = "无法从页面文本中解析定价数据";
    }
  } else {
    errors.zhipu = zhipu.error;
  }

  // Qwen
  errors.qwen = qwen.error;

  // ── 输出报告 ──────────────────────────────────────────
  const now = new Date().toISOString().slice(0, 10);
  const lines = [`# 🔔 定价检测报告 — ${now}`, ""];


  let hasChanges = false;

  for (const [vendor, changes] of Object.entries(allChanges)) {
    if (changes.length === 0) {
      lines.push(`## ✅ ${vendor} — 无变更`);
      lines.push("");
      continue;
    }

    hasChanges = true;
    lines.push(`## ⚠️ 价格变更 — ${vendor}`);
    lines.push("");
    lines.push("| 模型 | 类型 | 捆绑价格 | 官网价格 | 差异 |");
    lines.push("|------|------|----------|----------|------|");

    for (const c of changes) {
      if (c.type === "new_model") {
        lines.push(
          `| ${c.model} | 新模型 | — | 入¥${c.input}/出¥${c.output}${c.cacheHit ? `/缓¥${c.cacheHit}` : ""} | 🆕 |`
        );
      } else {
        const { bundled: b, fetched: f } = c;
        if (f.input !== undefined && Math.abs(f.input - b.input) > 0.01) {
          const pct = (((f.input - b.input) / b.input) * 100).toFixed(0);
          lines.push(
            `| ${c.model} | 输入(未命中) | ¥${b.input} | ¥${f.input} | ${pct > 0 ? "+" : ""}${pct}% |`
          );
        }
        if (f.output !== undefined && Math.abs(f.output - b.output) > 0.01) {
          const pct = (((f.output - b.output) / b.output) * 100).toFixed(0);
          lines.push(
            `| ${c.model} | 输出 | ¥${b.output} | ¥${f.output} | ${pct > 0 ? "+" : ""}${pct}% |`
          );
        }
        if (f.cacheHit !== undefined && (!b.cacheHit || Math.abs(f.cacheHit - b.cacheHit) > 0.01)) {
          lines.push(
            `| ${c.model} | 输入(命中) | ${b.cacheHit ? "¥" + b.cacheHit : "—"} | ¥${f.cacheHit} | ${b.cacheHit ? "变更" : "🆕"} |`
          );
        }
      }
    }
    lines.push("");
  }

  // 错误/跳过的厂商
  const skippedVendors = Object.entries(errors).filter(([, e]) => e);
  if (skippedVendors.length > 0) {
    lines.push("## ⏭️ 跳过的厂商");
    lines.push("");
    for (const [vendor, error] of skippedVendors) {
      lines.push(`- **${vendor}**: ${error}`);
    }
    lines.push("");
  }

  if (!hasChanges) {
    lines.push("## ✅ 所有可检测厂商定价无变更");
    lines.push("");
  }

  // 如果检测到变更，更新 pricing.json
  if (hasChanges) {
    try {
      const pricingJsonPath = resolve(ROOT, "pricing.json");
      const currentPricing = JSON.parse(readFileSync(pricingJsonPath, "utf-8"));
      
      // 合并新的定价数据
      const updatedEntries = [...currentPricing.entries];
      
      for (const [vendor, changes] of Object.entries(allChanges)) {
        for (const change of changes) {
          if (change.type === "new_model") {
            // 添加新模型
            updatedEntries.push({
              vendor: vendor,
              pattern: change.model,
              inputPer1k: change.input,
              outputPer1k: change.output,
              cacheHitPer1k: change.cacheHit,
              currency: "CNY",
              effectiveDate: new Date().toISOString().split("T")[0]
            });
          } else {
            // 更新现有模型
            const idx = updatedEntries.findIndex(e => 
              e.vendor === vendor && e.pattern === change.model
            );
            if (idx >= 0) {
              const entry = updatedEntries[idx];
              if (change.fetched.input !== undefined) {
                entry.inputPer1k = change.fetched.input;
              }
              if (change.fetched.output !== undefined) {
                entry.outputPer1k = change.fetched.output;
              }
              if (change.fetched.cacheHit !== undefined) {
                entry.cacheHitPer1k = change.fetched.cacheHit;
              }
              entry.effectiveDate = new Date().toISOString().split("T")[0];
            }
          }
        }
      }
      
      const updatedPricing = {
        version: currentPricing.version + 1,
        updatedAt: new Date().toISOString().split("T")[0],
        entries: updatedEntries
      };
      
      writeFileSync(pricingJsonPath, JSON.stringify(updatedPricing, null, 2) + "\n");
      lines.push(`> 📝 已更新 pricing.json (版本 ${updatedPricing.version})`);
    } catch (e) {
      lines.push(`> ❌ 更新 pricing.json 失败: ${e.message}`);
    }
  }

  lines.push("---");
  lines.push(`> 检测时间: ${new Date().toISOString()}`);
  lines.push("> 数据来源: 各厂商官网公开定价页面");
  lines.push(`> 汇率: 1 USD ≈ ${usdCny.toFixed(4)} CNY（${usdCny === DEFAULT_USD_CNY ? "默认值，汇率 API 不可用" : "实时获取"}）`);
  lines.push("> 注意: DeepSeek 价格为 USD 按实时汇率换算 CNY");

  const report = lines.join("\n");
  console.log(report);

  // 退出码：有变更返回 0（GitHub Actions 用 issue 创建代替）
  // 无变更也返回 0
  process.exit(0);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
