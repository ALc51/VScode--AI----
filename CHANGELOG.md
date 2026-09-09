# Change Log

## Unreleased

- 修复对话结束后数据不自动刷新：handleUsage 无条件触发 changeEmitter（不再被余额不支持厂商跳过），50ms 延迟等 globalState 落盘
- 修复曲线负值下冲：smoothPath 钳制所有控制点 Y 坐标不超出 baseline（Catmull-Rom 过冲修复）
- 柱子配色柔和化：命中绿 #4ade80 / 未命中紫 #a78bfa / 输出橙 #fb923c，段间 1px 缝隙，统计行同步配色
- 面板完整重设计：统计行+模型下拉+日期选择+趋势图+模型明细表
- 新增模型筛选下拉 + 日期范围选择（7/14/30/90 天）
- 测试 47 项通过，`npm run compile` 通过

## 单厂商面板

- 用量/余额改为仅当前厂商 + 专属 Webview 数据面板（余额卡片/模型明细/趋势图），不再写输出日志
- 当前厂商三路识别：活跃回调记忆 > selectChatModels 探测 > 手动切换；启动不再全量预取余额
- 新增 `切换当前厂商` 命令；Tree/状态栏/用量历史/定价明细均按当前厂商过滤
- 新增用量多厂商过滤测试（43 项通过），`npm run compile` 通过

## 计费基础

- 新增用量/费用/余额：流式真实 usage 累计、定价远端同步+捆绑兜底、余额 SWR 低延迟查询
- 新增命令面板 6 命令、侧边用量面板、状态栏常驻显示
- DeepSeek/Kimi 接入余额端点；通义/智谱/小米标记不支持并跳转控制台
- 测试覆盖 billing/pricing/usage 纯逻辑（42 项通过），`npm run compile` 通过

- 初始版本
- 支持 5 家国内厂商：DeepSeek、通义千问、智谱GLM、Kimi、小米 MiMo
- 通过 `LanguageModelChatProvider` API 注册为 Copilot 原生模型
- 支持加密存储 API Key（VS Code Secret Storage）
- 流式响应支持
- 命令面板快速配置 API Key
