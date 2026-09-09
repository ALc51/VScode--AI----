# 国内AI适配插件

将国内主流 AI 厂商注册为 VS Code Copilot 的原生模型供应商。配置、模型选择和聊天交互全部使用 VS Code/Copilot 原生 UI。

## ✨ 支持的厂商

| 厂商 | Vendor ID | 模型 |
|------|-----------|------|
| DeepSeek | `deepseek` | DeepSeek Chat, DeepSeek Reasoner |
| 通义千问 | `qwen` | Qwen Plus, Qwen Turbo, Qwen Max |
| 智谱GLM | `zhipu` | GLM-4 Plus, GLM-4 Flash |
| Kimi | `kimi` | Kimi 128K, Kimi 32K |
| 小米 MiMo | `xiaomi` | MiMo V2 Flash |

## 🚀 安装与使用

### 开发调试

```bash
# 1. 安装依赖
npm install

# 2. 编译
npm run compile

# 3. 按 F5 启动调试
```

### 配置与使用

打开 Copilot Chat 的模型选择器，使用 VS Code 原生的“添加模型”入口，选择厂商并填写其 API 配置。密钥由 VS Code 原生语言模型配置流程管理；配置完成后，模型会直接出现在同一个模型选择器中。

### 使用模型

配置完成后，打开 **Copilot Chat**，在模型下拉菜单中即可看到国内厂商的模型选项，直接选择使用。

## 💰 用量 / 费用 / 余额（仅当前厂商 + 专属数据面板）

- 命令面板：`国内AI: 用量/余额数据面板` / `查看当前厂商余额` / `查看当前厂商今日用量` / `刷新当前厂商余额` / `刷新定价` / `切换当前厂商` / `打开账单控制台`
- 数据面板（Webview）：余额卡片 + 今日三段拆分（输入·命中 / 输入·未命中 / 输出 + 命中率堆叠条）+ 模型明细表（含命中率列）+ 近 14 天堆叠柱状图（命中/未命中/输出三段）+ 命中率折线（悬停看费用与次数），不再写输出日志
- 侧边栏「国内AI → 用量/余额」：只展示当前厂商（记忆 > 探测 > 手动选择），今日拆分为命中/未命中/输出/命中率四行，历史 14 天同口径
- 状态栏：只显示当前厂商今日总量 + 命中率 + 余额，点击打开数据面板（`china-ai.billing.statusBar` 开关，`china-ai.billing.refreshIntervalSec` 间隔，最小 15s）
- 当前厂商识别：聊天/模型调用时自动记忆 > `selectChatModels` 探测 > 手动 `切换当前厂商`；余额/用量/定价明细均按该厂商过滤，启动不再全量预取

| 厂商 | 余额查询 | 说明 |
|------|----------|------|
| DeepSeek | ✅ `GET /user/balance` | 同 API Key + Bearer，需联网验证返回字段 |
| Kimi | ✅ `GET /v1/users/me/balance` | 文档不稳定，多形态兼容解析 |
| 通义千问 | ❌ | DashScope compatible-mode 无同 Key 余额接口，跳转控制台 |
| 智谱GLM | ❌ | 暂无公开接口，跳转控制台 |
| 小米 MiMo | ❌ | 暂无公开接口，跳转控制台 |

- 用量：流式真实 `usage` 优先（DeepSeek/Kimi/通义默认开启 `stream_options.include_usage`，智谱/小米待验证暂关闭），`tokenEstimator` 仅降级；缓存拆分兼容 `prompt_cache_hit/miss_tokens`、`cached_tokens`、`prompt_tokens_details.cached_tokens`，缺字段时命中计 0、命中率显示“-”
- 定价：远端清单自动同步（ETag + 每日 + 手动 `刷新定价`），失败回退 `src/config/pricing.ts` 捆绑值；UI 展示生效日期，远端地址发布前替换 `PRICING_MANIFEST_URL`
- 余额延迟：SWR + 30s 去重 + 聊天完成 5s 去抖刷新 + 启动预取，感知延迟 1-2s；不支持硬实时轮询（易 429）

## 📁 项目结构

```
src/
├── extension.ts              # 入口文件
├── types.ts                  # 类型定义
├── config/
│   └── models.ts             # 模型注册表
├── providers/
│   ├── baseProvider.ts       # Provider 基类
│   ├── deepseek.ts           # DeepSeek 适配
│   ├── qwen.ts               # 通义千问适配
│   ├── zhipu.ts              # 智谱适配
│   ├── kimi.ts               # Kimi 适配
│   └── xiaomi.ts             # 小米 MiMo 适配
└── utils/
    ├── sseParser.ts          # SSE 流式解析
    └── tokenEstimator.ts     # Token 估算
```

## 🔧 扩展更多厂商

1. 在 `src/config/models.ts` 的 `MODEL_REGISTRY` 中添加模型配置
2. 在 `src/config/models.ts` 的 `API_BASE_URLS` 中添加 API 地址
3. 创建 `src/providers/新厂商.ts`（参考 `deepseek.ts`）
4. 在 `package.json` 的 `languageModelChatProviders` 中添加声明
5. 在 `src/extension.ts` 中注册新 Provider

## 📝 API Key 获取地址

- **DeepSeek**: https://platform.deepseek.com/api_keys
- **通义千问**: https://dashscope.console.aliyun.com/apiKey
- **智谱**: https://open.bigmodel.cn/usercenter/apikeys
- **Kimi**: https://platform.moonshot.cn/console/api-keys
- **小米 MiMo**: https://platform.xiaomimimo.com

## License

MIT
