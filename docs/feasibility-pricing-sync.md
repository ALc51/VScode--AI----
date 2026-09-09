# 价格与官网同步 — 可行性研究与最优计划

> 研究日期: 2026-09-08 | 项目: VScode国内AI适配插件

---

## 一、当前定价同步机制

### 现有架构（三层回退）

```
BUNDLED_PRICING (捆绑兜底)
    ↓ 失败时回退
CACHE (globalState 缓存，每天检查一次)
    ↓ 过期时拉取
REMOTE (GitHub Gist pricing.json，ETag 去重)
    ↓ 合并
mergePricingManifests(bundled, remote) → 远端优先
```

**关键文件**：
- `src/config/pricing.ts` — 捆绑定价表 + 匹配逻辑
- `src/utils/pricingSync.ts` — 远端同步（GitHub Gist）

**当前问题**：
- 捆绑定价表需要手动更新（代码发版）
- GitHub Gist 需要手动维护（人工编辑 JSON）
- **无法自动感知官网价格变动**

---

## 二、各厂商官网定价数据源分析

### 2.1 DeepSeek

| 项目 | 详情 |
|------|------|
| **定价页面** | https://api-docs.deepseek.com/quick_start/pricing |
| **数据格式** | HTML 表格（Markdown 渲染） |
| **价格单位** | USD / 1M tokens |
| **定价特点** | 有峰谷定价（peak/off-peak）、缓存命中/未命中 |
| **模型** | deepseek-v4-flash, deepseek-v4-pro, deepseek-v4-flash-vision-exp |
| **抓取难度** | ⭐⭐ 中等 — 静态 HTML，结构化表格 |

**最新价格（2026-09-08）**：
| 模型 | Input (cache miss, off-peak) | Output (off-peak) | Input (cache miss, peak) | Output (peak) |
|------|-----|-----|-----|-----|
| deepseek-v4-flash | $0.22/1M | $0.66/1M | $0.44/1M | $1.32/1M |
| deepseek-v4-pro | $0.66/1M | $1.98/1M | $1.32/1M | $3.96/1M |

### 2.2 Kimi (月之暗面)

| 项目 | 详情 |
|------|------|
| **定价页面** | https://platform.kimi.com/docs/pricing |
| **数据格式** | React 组件渲染的表格（JSX DocTable） |
| **价格单位** | CNY / 1M tokens |
| **定价特点** | 有缓存命中价格、高速版溢价 |
| **模型** | kimi-k3, kimi-k2.7-code, kimi-k2.7-code-highspeed, kimi-k2.6 |
| **抓取难度** | ⭐⭐⭐ 较难 — 需要解析 JSX 组件 |

**最新价格（2026-09-08）**：
| 模型 | Input (cache miss) | Input (cache hit) | Output |
|------|-----|-----|-----|
| kimi-k3 | ¥20.00/1M | ¥2.00/1M | ¥100.00/1M |
| kimi-k2.7-code | ¥6.50/1M | ¥1.30/1M | ¥27.00/1M |
| kimi-k2.7-code-highspeed | ¥13.00/1M | ¥2.60/1M | ¥54.00/1M |
| kimi-k2.6 | ¥6.50/1M | ¥1.10/1M | ¥27.00/1M |

### 2.3 小米 MiMo

| 项目 | 详情 |
|------|------|
| **定价页面** | https://mimo.mi.com/docs/price/pay-as-you-go |
| **数据格式** | HTML 表格 |
| **价格单位** | CNY / 1M tokens（国内），USD / 1M tokens（海外） |
| **定价特点** | 简单清晰，无缓存价格 |
| **模型** | mimo-v2.5-pro, mimo-v2.5 |
| **抓取难度** | ⭐ 简单 — 静态 HTML，结构清晰 |

**最新价格（2026-09-08）**：
| 模型 | Input | Output |
|------|-------|--------|
| mimo-v2.5-pro | ¥3.00/1M | ¥6.00/1M |
| mimo-v2.5 | ¥1.00/1M | ¥2.00/1M |

### 2.4 智谱 GLM

| 项目 | 详情 |
|------|------|
| **定价页面** | https://open.bigmodel.cn/pricing |
| **数据格式** | React SPA，动态渲染 |
| **价格单位** | CNY / 1M tokens |
| **定价特点** | 有缓存命中价格、限时折扣、分档定价（按上下文长度） |
| **模型** | GLM-5.3, GLM-5.3-Flash, GLM-5.2, GLM-4.7-Flash (免费) |
| **抓取难度** | ⭐⭐⭐⭐ 很难 — SPA 渲染，需要 Playwright |

**最新价格（2026-09-08）**：
| 模型 | Input | Output | Cache Hit |
|------|-------|--------|-----------|
| GLM-5.3 | ¥8.00/1M | ¥28.00/1M | ¥2.00/1M |
| GLM-5.3-Flash | ¥0.80/1M (限时¥0.40) | ¥2.80/1M (限时¥1.40) | ¥0.23/1M |
| GLM-5.2 | ¥8.00/1M | ¥28.00/1M | ¥2.00/1M |
| GLM-4.7-Flash | 免费 | 免费 | 免费 |

### 2.5 通义千问 Qwen

| 项目 | 详情 |
|------|------|
| **定价页面** | https://help.aliyun.com/zh/model-studio/ (模型广场) |
| **数据格式** | 阿里云控制台 SPA，需要登录 |
| **价格单位** | CNY / 1M tokens |
| **定价特点** | 模型众多，价格分散在各模型详情页 |
| **模型** | qwen3.8-max, qwen3.7-plus, qwen3.8-flash, qwen-plus 等 |
| **抓取难度** | ⭐⭐⭐⭐⭐ 极难 — 需要登录，SPA 渲染，反爬严格 |

---

## 三、可行性评估

### 3.1 自动抓取方案

| 方案 | 可行性 | 难度 | 风险 | 说明 |
|------|--------|------|------|------|
| **A. HTTP 直接抓取** | ⚠️ 部分可行 | 中 | 中 | 仅适用于 DeepSeek、MiMo 等静态页面 |
| **B. Playwright 渲染抓取** | ⚠️ 部分可行 | 高 | 高 | 可处理 SPA，但资源消耗大、不稳定 |
| **C. 厂商 API 查询** | ❌ 不可行 | - | - | 所有厂商均无公开定价 API |
| **D. LLM 解析页面** | ⚠️ 理论可行 | 很高 | 很高 | 成本高、延迟大、不准确 |

### 3.2 半自动方案

| 方案 | 可行性 | 难度 | 风险 | 说明 |
|------|--------|------|------|------|
| **E. GitHub Actions 定时抓取** | ✅ 推荐 | 中 | 低 | CI 环境抓取 → 更新 Gist → 扩展拉取 |
| **F. 社区 PR 驱动** | ✅ 推荐 | 低 | 低 | 人工核实 + PR 流程，最可靠 |
| **G. 厂商 Webhook 通知** | ❌ 不可行 | - | - | 厂商不提供价格变更通知 |

### 3.3 混合方案（最优）

**核心思路**：人工审核为主，自动检测为辅

```
┌─────────────────────────────────────────────────────────┐
│                    定价同步管道                           │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐          │
│  │ 官网页面  │───→│ 自动检测  │───→│ 变更通知  │          │
│  │ (5 个厂商)│    │ (定时轮询)│    │ (GitHub   │          │
│  └──────────┘    └──────────┘    │  Issue)   │          │
│                                  └─────┬────┘          │
│                                        │                │
│                                        ▼                │
│                                  ┌──────────┐          │
│                                  │ 人工审核  │          │
│                                  │ (维护者)  │          │
│                                  └─────┬────┘          │
│                                        │                │
│                                        ▼                │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐          │
│  │ 扩展拉取  │◀──│ GitHub   │◀──│ 更新 Gist │          │
│  │ (每天检查)│    │ Gist     │    │ (pricing  │          │
│  └──────────┘    └──────────┘    │  .json)   │          │
│                                  └──────────┘          │
└─────────────────────────────────────────────────────────┘
```

---

## 四、最优实施计划

### Phase 1: 增强现有同步机制（1-2 天）

#### 1.1 更新捆绑定价表

当前捆绑定价表已过时（2026-09-06），需要更新为最新价格：

**需要更新的价格**：
- Kimi K3: input ¥20.00/1M, output ¥100.00/1M（当前 ¥12.00/1M, ¥36.00/1M）
- Kimi K2.7 Code: input ¥6.50/1M, output ¥27.00/1M（当前 ¥8.00/1M, ¥24.00/1M）
- Kimi K2.6: input ¥6.50/1M, output ¥27.00/1M（当前 ¥8.00/1M, ¥24.00/1M）
- MiMo V2.5 Pro: input ¥3.00/1M, output ¥6.00/1M（当前 ¥4.00/1M, ¥12.00/1M）
- MiMo V2.5: input ¥1.00/1M, output ¥2.00/1M（当前 ¥4.00/1M, ¥12.00/1M）
- GLM-5.3: input ¥8.00/1M, output ¥28.00/1M（当前 ¥10.00/1M, ¥30.00/1M）

#### 1.2 添加缓存命中价格字段

扩展 `PricingEntry` 接口，支持缓存命中价格：

```typescript
export interface PricingEntry {
  vendor: string;
  pattern: string;
  inputPer1k: number;
  outputPer1k: number;
  cacheHitPer1k?: number;      // 新增：缓存命中价格
  cacheWritePer1k?: number;    // 新增：缓存写入价格
  currency: string;
  effectiveDate: string;
  sourceUrl?: string;
}
```

### Phase 2: GitHub Actions 自动检测（3-5 天）

#### 2.1 创建价格检测工作流

```yaml
# .github/workflows/pricing-check.yml
name: Pricing Check
on:
  schedule:
    - cron: '0 8 * * 1'  # 每周一早上 8 点
  workflow_dispatch:

jobs:
  check-pricing:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: node scripts/check-pricing.mjs
      - uses: peter-evans/create-issue-from-file@v5
        if: failure()
        with:
          title: "🔔 定价变更检测"
          content-filepath: pricing-diff.md
          labels: pricing-update
```

#### 2.2 创建价格检测脚本

```javascript
// scripts/check-pricing.mjs
// 针对每个厂商创建专门的解析器
const parsers = {
  deepseek: parseDeepSeekPricing,  // 静态 HTML 解析
  kimi: parseKimiPricing,          // JSX 组件解析
  xiaomi: parseXiaomiPricing,      // 静态 HTML 解析
  zhipu: parseZhipuPricing,        // 需要 Playwright
  qwen: parseQwenPricing,          // 需要 API 或手动
};
```

### Phase 3: 社区驱动更新（持续）

#### 3.1 创建定价更新模板

```markdown
<!-- .github/ISSUE_TEMPLATE/pricing-update.md -->
---
name: 定价更新
about: 报告厂商价格变更
---

**厂商**: [DeepSeek/Kimi/Qwen/智谱/小米]
**模型**: [模型名称]
**变更类型**: [价格调整/新模型/模型下线]
**新价格**:
- 输入: ¥X.XX/1M tokens
- 输出: ¥X.XX/1M tokens
- 缓存命中: ¥X.XX/1M tokens

**来源**: [官网链接]
**生效日期**: [YYYY-MM-DD]
```

#### 3.2 定价变更通知机制

在扩展中添加定价变更检测：

```typescript
// 当远端定价与本地缓存不同时，通知用户
if (remoteSource === "remote" && hasPricingChanges(cached, merged)) {
  vscode.window.showInformationMessage(
    `📢 检测到定价更新：${getChangedVendors(cached, merged).join(", ")}。` +
    `打开用量面板查看详情。`,
    "查看详情"
  );
}
```

---

## 五、各厂商抓取策略详情

### 5.1 DeepSeek — HTTP 抓取 ✅

```javascript
// 直接抓取 Markdown 源文件
const response = await fetch(
  "https://raw.githubusercontent.com/deepseek-ai/api-docs/main/docs/quick_start/pricing.md"
);
const markdown = await response.text();
// 解析 Markdown 表格
const prices = parseMarkdownTable(markdown);
```

**优点**：DeepSeek 文档开源在 GitHub，可以直接抓取 Markdown 源文件
**风险**：低，Markdown 格式稳定

### 5.2 Kimi — API 文档抓取 ⚠️

```javascript
// Kimi 使用 Mintlify 文档框架，有 llms.txt
const response = await fetch("https://platform.kimi.com/docs/llms.txt");
// 或直接抓取各定价页面
const k3 = await fetch("https://platform.kimi.com/docs/pricing/chat-k3");
```

**优点**：Mintlify 框架有标准化的 llms.txt
**风险**：中等，JSX 组件需要特殊解析

### 5.3 小米 MiMo — HTTP 抓取 ✅

```javascript
const response = await fetch("https://mimo.mi.com/docs/price/pay-as-you-go");
const html = await response.text();
// 解析 HTML 表格
const prices = parseHtmlTable(html);
```

**优点**：静态 HTML，结构清晰
**风险**：低

### 5.4 智谱 — 需要 Playwright ⚠️

```javascript
// 智谱是 SPA，需要浏览器渲染
const browser = await playwright.chromium.launch();
const page = await browser.newPage();
await page.goto("https://open.bigmodel.cn/pricing");
await page.waitForSelector(".pricing-table");
const prices = await page.evaluate(() => {
  // 提取定价数据
});
```

**优点**：可以获取完整渲染后的内容
**风险**：高，需要 Playwright，反爬风险

### 5.5 通义千问 — 最难 ⚠️

```javascript
// 方案 1: 通过百炼 API 查询（如果有的话）
// 方案 2: 抓取帮助文档页面
// 方案 3: 手动维护
```

**优点**：无
**风险**：很高，阿里云反爬严格，价格分散

---

## 六、推荐实施路径

```
Phase 1 (立即)          Phase 2 (1周)           Phase 3 (持续)
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│ 更新捆绑定价 │    │ GitHub      │    │ 社区 PR     │
│ 添加缓存价格 │ →  │ Actions     │ →  │ 驱动更新    │
│ 优化同步逻辑 │    │ 自动检测    │    │ 变更通知    │
└─────────────┘    └─────────────┘    └─────────────┘
   1-2 天              3-5 天              持续
```

### 优先级排序

1. **🔥 立即**：更新捆绑定价表（当前价格已过时）
2. **🔥 立即**：添加缓存命中价格支持
3. **📅 本周**：创建 GitHub Actions 检测工作流
4. **📅 本月**：实现 DeepSeek + MiMo 自动抓取
5. **🔮 未来**：实现 Kimi + 智谱自动抓取
6. **🔮 未来**：Qwen 定价自动同步（最难）

---

## 七、风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 官网改版 | 抓取脚本失效 | 多层回退机制 + 监控告警 |
| 反爬封禁 | 无法获取数据 | 限制频率 + User-Agent + 代理 |
| 价格格式变化 | 解析失败 | Schema 校验 + 人工审核 |
| 限时折扣 | 数据不准确 | 记录 effectiveDate + 来源 URL |
| 汇率波动 | USD/CNY 转换 | 统一使用官网原始币种 |

---

## 八、结论

**完全自动同步所有厂商定价目前不可行**，原因：
1. 智谱和 Qwen 是 SPA，需要浏览器渲染
2. 各厂商定价格式差异大（USD/CNY、峰谷价、缓存价、限时折扣）
3. 无公开定价 API

**最优方案是混合策略**：
- **DeepSeek + MiMo**：可实现 HTTP 自动抓取（成功率 90%+）
- **Kimi**：可通过 Mintlify llms.txt 半自动抓取（成功率 70%+）
- **智谱 + Qwen**：建议人工维护 + 社区 PR 驱动

**建议立即执行 Phase 1**（更新捆绑定价表），当前价格已明显过时。
