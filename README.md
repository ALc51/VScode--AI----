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
