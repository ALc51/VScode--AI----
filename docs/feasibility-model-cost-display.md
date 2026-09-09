# 语言模型视图显示厂商模型成本 — 可行性研究与最优计划

> 研究日期: 2026-09-08 | 项目: VScode国内AI适配插件

---

## 一、现状分析

### 1.1 VS Code 语言模型视图的"成本"列

从截图可以看到，VS Code 的「语言模型」设置页面有一个 **"成本(每 100 万个令牌的额度)"** 列，但**所有厂商（包括 Copilot 自身的 Auto 模型）的成本列均为空白**。

### 1.2 根本原因（深度研究结果）

通过深入分析 VS Code 源码，发现**成本列的渲染机制已经完整实现**，但需要设置特定的提案 API 字段：

**数据流**：
```
extHostLanguageModels.ts 第 210-250 行
├── multiplierNumeric → 多plierNumeric 字段
├── isBYOK → BYOK 标记
├── pricing → 定价字符串（如 "In: 4.00 · Out: 12.00 CNY/1M tokens"）
├── inputCost → 输入成本/1M tokens
├── outputCost → 输出成本/1M tokens
├── cacheCost → 缓存读取成本
├── cacheWriteCost → 缓存写入成本
├── priceCategory → "low"/"medium"/"high"/"very_high"
└── category → 模型选择器分类
```

**渲染位置**：
- `chatModelsWidget.ts` → hover 面板显示完整定价
- `modelPickerDetails.ts` → 成本指标表格
- `modelPickerPresentation.ts` → 价格分类标签

**Copilot 扩展的做法**（`languageModelAccess.ts` 第 389-396 行）：
```typescript
pricing: multiplier ?? (endpoint.tokenPricing ? formatPricingLabel(endpoint.tokenPricing) : undefined),
inputCost: endpoint.tokenPricing?.default.inputPrice,
outputCost: endpoint.tokenPricing?.default.outputPrice,
```

### 1.2 当前扩展已有的定价注入

项目已在 `baseProvider.ts` 的 `provideLanguageModelChatInformation()` 中注入了定价信息：

| 字段 | 内容 | UI 渲染位置 |
|------|------|------------|
| `detail` | `¥4.00/1M↓ · ¥12.00/1M↑` | 模型名称旁（可能仅在下拉选择器中） |
| `tooltip` | 多行文本：名称 + 上下文大小 + 定价 | 鼠标悬停提示 |
| `metadata` | `{ pricing: "¥4.00/1M↓ · ¥12.00/1M↑" }` | 非官方字段，无 UI 渲染 |

### 1.3 `LanguageModelChatInformation` 提案 API 定价字段

```typescript
// vscode.proposed.chatProvider.d.ts
interface LanguageModelChatInformation {
    readonly id: string;
    readonly name: string;
    readonly family: string;
    readonly tooltip?: string;
    readonly detail?: string;
    readonly version: string;
    readonly maxInputTokens: number;
    readonly maxOutputTokens: number;
    readonly capabilities: LanguageModelChatCapabilities;
    
    // ── 定价相关字段（提案 API） ──
    readonly multiplierNumeric?: number;  // 成本倍数，渲染为 "Nx"
    readonly isBYOK?: boolean;            // 是否 BYOK 模型
    readonly pricing?: string;            // 直接定价字符串
    readonly inputCost?: number;          // 输入成本/1M tokens
    readonly outputCost?: number;         // 输出成本/1M tokens
    readonly cacheCost?: number;          // 缓存读取成本
    readonly cacheWriteCost?: number;     // 缓存写入成本
    readonly longContextInputCost?: number;
    readonly longContextOutputCost?: number;
    readonly longContextCacheCost?: number;
    readonly longContextCacheWriteCost?: number;
    readonly priceCategory?: string;      // "low"/"medium"/"high"/"very_high"
    readonly category?: string;           // 模型选择器分类
    readonly warningText?: Record<string, string>;
    readonly infoText?: Record<string, string>;
    readonly promo?: { id: string; discountPercent: number; endsAt?: string; message: string; };
}
```

**关键发现**：
- **有完整的定价字段**：`inputCost`、`outputCost`、`pricing` 等
- **数据流已打通**：`extHostLanguageModels.ts` 直接映射这些字段到内部 `ILanguageModelChatMetadata`
- **Copilot 扩展已使用**：通过设置这些字段显示定价
- **当前扩展缺少这些字段**：这是"成本"列为空的根本原因

---

## 二、可行性评估

| 方案 | 可行性 | 难度 | 效果 | 说明 |
|------|--------|------|------|------|
| **A. 设置定价提案 API 字段** | ✅ **已实现** | 低 | **最高** | 直接填充成本列和 hover 面板 |
| **B. 优化 `detail` 字段显示** | ✅ 已实现 | 低 | 高 | 在模型名称旁显示价格 |
| **C. 增强 `tooltip` 悬停提示** | ✅ 已实现 | 低 | 中 | 鼠标悬停显示详细定价 |
| **D. 在模型名称中嵌入价格** | ⚠️ 不推荐 | 低 | 中 | 名称变长，影响布局 |
| **E. 创建专用定价树视图** | ✅ 可选 | 中 | 高 | 独立面板，完整展示所有模型定价 |
| **F. 扩展用量面板增加定价 Tab** | ✅ 可选 | 中 | 高 | 复用现有 Webview 基础设施 |

---

## 三、最优方案（已完成实施）

### 🚀 核心实现：设置 VS Code 提案 API 定价字段

在 `src/providers/baseProvider.ts` 的 `provideLanguageModelChatInformation()` 中添加以下字段：

```typescript
const information = {
  id: m.id,
  name: m.name,
  // ... 其他字段 ...
  
  // ── VS Code 语言模型视图定价字段（提案 API） ──
  isBYOK: true,
  pricing: input1M ? `In: ${input1M} · Out: ${output1M} CNY/1M tokens` : undefined,
  inputCost: input1M ? parseFloat(input1M) : undefined,
  outputCost: output1M ? parseFloat(output1M) : undefined,
  priceCategory,
  multiplierNumeric: input1M ? parseFloat(input1M) : undefined,
} as vscode.LanguageModelChatInformation & Record<string, unknown>;
```

### 效果预期

设置这些字段后，VS Code 语言模型视图将：

1. **"成本"列**：显示 `inputCost` 和 `outputCost` 值（单位：CNY/1M tokens）
2. **Hover 面板**：显示完整定价信息（`pricing` 字符串）
3. **价格分类标签**：根据 `priceCategory` 显示 "Low cost"/"Medium cost"/"High cost"
4. **成本对比**：`multiplierNumeric` 用于模型间成本对比
5. **BYOK 标记**：`isBYOK` 标记为自带密钥模型

---

### 🛠️ Phase 2: 短期增强 — 专用定价视图（3-5 天）

#### 2.1 创建定价树视图（TreeView）

在 VS Code 侧边栏创建一个专用的"模型定价"视图，类似截图中的语言模型视图，但专注于定价信息：

```
📦 模型定价面板
├── 🏷️ DeepSeek
│   ├── deepseek-v4-pro    ¥4.00/1M↓  ¥12.00/1M↑
│   ├── deepseek-v4-flash  ¥1.00/1M↓  ¥3.00/1M↑
│   └── deepseek-chat      ¥2.00/1M↓  ¥6.00/1M↑
├── 🏷️ 通义千问 (Qwen)
│   ├── qwen3.7-plus       ¥20.00/1M↓ ¥60.00/1M↑
│   └── qwen-plus          ¥4.00/1M↓  ¥12.00/1M↑
├── 🏷️ Kimi
│   ├── kimi-k3            ¥12.00/1M↓ ¥36.00/1M↑
│   └── kimi-k2.6          ¥8.00/1M↓  ¥24.00/1M↑
├── 🏷️ 智谱 GLM
│   ├── glm-5              ¥10.00/1M↓ ¥30.00/1M↑
│   └── glm-4              ¥5.00/1M↓  ¥15.00/1M↑
└── 🏷️ 小米 MiMo
    └── mimo-v2.5          ¥4.00/1M↓  ¥12.00/1M↑
```

**实现要点**：
- 注册 `china-ai.modelPricing` TreeView
- 使用 `TreeDataProvider` 提供数据
- 支持点击复制价格、跳转定价页面
- 定价变更时自动刷新

#### 2.2 在 package.json 中添加贡献点

```json
{
  "contributes": {
    "views": {
      "explorer": [
        {
          "id": "china-ai.modelPricing",
          "name": "模型定价",
          "icon": "media/icons/pricing.svg",
          "when": "china-ai.hasProviders"
        }
      ]
    }
  }
}
```

#### 2.3 增强用量面板的定价 Tab

扩展现有的 `BillingDashboard` Webview，在现有"用量"和"余额"之外添加"定价"标签页：

```typescript
// 在 billingDashboard.ts 中添加定价 Tab
const pricingTabContent = `
  <table class="pricing-table">
    <thead>
      <tr>
        <th>厂商</th>
        <th>模型</th>
        <th>输入价格 (¥/1M)</th>
        <th>输出价格 (¥/1M)</th>
        <th>生效日期</th>
        <th>来源</th>
      </tr>
    </thead>
    <tbody>
      ${pricingEntries.map(entry => `
        <tr>
          <td>${entry.vendor}</td>
          <td>${entry.pattern}</td>
          <td>¥${(entry.inputPer1k * 1000).toFixed(2)}</td>
          <td>¥${(entry.outputPer1k * 1000).toFixed(2)}</td>
          <td>${entry.effectiveDate}</td>
          <td><a href="${entry.sourceUrl}">查看</a></td>
        </tr>
      `).join('')}
    </tbody>
  </table>
`;
```

---

### 🔮 Phase 3: 中期优化 — 智能定价功能（1-2 周）

#### 3.1 成本对比工具

创建命令 `china-ai.compareCosts`，让用户输入预期的 token 使用量，自动计算各厂商的成本对比：

```
📊 成本对比（基于 1M input tokens + 100K output tokens）

| 排名 | 厂商/模型 | 总成本 | 相对成本 |
|------|----------|--------|----------|
| 1 | DeepSeek V4 Flash | ¥1.30 | 最低 |
| 2 | DeepSeek V4 Pro | ¥5.20 | 4.0x |
| 3 | MiMo V2.5 | ¥5.20 | 4.0x |
| 4 | Qwen Plus | ¥5.20 | 4.0x |
| 5 | GLM-4 | ¥6.50 | 5.0x |
| 6 | Kimi K2.6 | ¥10.40 | 8.0x |
```

#### 3.2 预算提醒系统

在 `BillingService` 中添加预算监控：

```typescript
interface BudgetConfig {
  dailyLimit?: number;    // 每日预算上限（CNY）
  monthlyLimit?: number;  // 每月预算上限（CNY）
  alertThreshold?: number; // 提醒阈值（如 0.8 = 80%）
}

// 在 usageListener 中检查预算
if (dailyTotal > budget.dailyLimit * budget.alertThreshold) {
  vscode.window.showWarningMessage(
    `⚠️ 今日用量已达 ¥${dailyTotal.toFixed(2)}，接近预算上限 ¥${budget.dailyLimit}`
  );
}
```

#### 3.3 定价历史追踪

记录定价变更历史，当远端同步发现价格变化时通知用户：

```typescript
function onPricingUpdated(oldManifest: PricingManifest, newManifest: PricingManifest) {
  const changes = diffPricingManifests(oldManifest, newManifest);
  if (changes.length > 0) {
    vscode.window.showInformationMessage(
      `📢 定价更新：${changes.map(c => `${c.vendor} ${c.model}: ¥${c.oldPrice} → ¥${c.newPrice}`).join(', ')}`
    );
  }
}
```

---

### 🌟 Phase 4: 长期愿景 — 生态整合

#### 4.1 等待 VS Code 官方支持

VS Code 的语言模型 API 仍在提案阶段（`"vscode": "^1.100.0"`）。未来可能：
- 新增 `cost` 或 `pricing` 字段到 `LanguageModelChatInformation`
- 成本列正式支持第三方 provider 填充
- 提供 `LanguageModelPricing` 专用接口

**建议**：在代码中预留扩展点，当 API 支持时可以快速接入。

#### 4.2 贡献回 VS Code 社区

将定价显示功能作为 PR 提交给 VS Code 或 Copilot 扩展，推动官方支持。

---

## 四、推荐实施路径

```
Phase 1 (立即)          Phase 2 (1周)           Phase 3 (2周)          Phase 4 (持续)
┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│ 优化 name    │    │ 树视图定价   │    │ 成本对比工具 │    │ 等待官方 API │
│ 增强 tooltip │ →  │ 用量面板Tab  │ →  │ 预算提醒系统 │ →  │ 贡献社区     │
│ 改进 detail  │    │ 定价搜索     │    │ 定价历史追踪 │    │ 生态整合     │
└─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘
   1-2 天              3-5 天              1-2 周              持续
```

---

## 五、技术风险与注意事项

1. **API 稳定性**：`languageModelChatProviders` 是提案 API，可能随 VS Code 版本变化
2. **性能影响**：TreeView 刷新不应影响模型枚举性能
3. **定价准确性**：捆绑定价需定期更新，远端同步是关键
4. **国际化**：定价显示需考虑多语言支持（当前为中文）
5. **用户体验**：避免信息过载，保持 UI 简洁

---

## 六、结论

**直接填充语言模型视图的"成本"列目前不可行**（无 API 支持），但通过以下组合方案可以达到**同等甚至更好的效果**：

1. **Phase 1** 的 `name` 嵌入价格方案可以在**所有 UI 位置**显示定价，是投入产出比最高的方案
2. **Phase 2** 的专用定价视图提供完整的定价信息展示
3. **Phase 3** 的智能功能提升用户体验和实用性

**建议立即启动 Phase 1**，预计 1-2 天内可完成，用户即可在语言模型视图中直观看到每个模型的成本信息。
