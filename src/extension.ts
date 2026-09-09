import * as vscode from "vscode";
import { BaseLanguageModelProvider } from "./providers/baseProvider";
import { createDeepseekConfig } from "./providers/deepseek";
import { createQwenConfig } from "./providers/qwen";
import { createZhipuConfig } from "./providers/zhipu";
import { createKimiConfig } from "./providers/kimi";
import { createXiaomiConfig } from "./providers/xiaomi";
import { ExtensionLogger } from "./utils/logger";
import type { ProviderConfig } from "./types";
import { BillingService } from "./billing/billingService";
import { BillingStatusBar } from "./billing/billingStatusBar";
import { BillingDashboard } from "./billing/billingDashboard";
import { registerBillingCommands } from "./billing/billingCommands";
import { VendorDetector } from "./utils/vendorDetector";
import {
  initializeContextWindowHookBridge,
  disposeContextWindowHookBridge,
} from "./utils/contextWindowHookBridge";

export function activate(context: vscode.ExtensionContext) {
  console.error("[国内AI适配插件] activate() called — build timestamp:", new Date().toISOString());
  const outputChannel = vscode.window.createOutputChannel("国内AI适配插件");
  context.subscriptions.push(outputChannel);
  ExtensionLogger.get().init(outputChannel);
  ExtensionLogger.get().info("扩展 activate() 开始执行");

  // 清除旧定价缓存，确保代码更新后 BUNDLED_PRICING 立即生效
  void context.globalState.update("billing.pricingManifest", undefined);
  void context.globalState.update("billing.pricingEtag", undefined);
  void context.globalState.update("billing.pricingCheckedAt", undefined);

  const vendorConfigs: ProviderConfig[] = [
    createDeepseekConfig(),
    createQwenConfig(),
    createZhipuConfig(),
    createKimiConfig(),
    createXiaomiConfig(),
  ];

  const providers: BaseLanguageModelProvider[] = [];
  for (const config of vendorConfigs) {
    const provider = new BaseLanguageModelProvider(config, context.globalState);
    providers.push(provider);
    context.subscriptions.push(provider);
    context.subscriptions.push(
      vscode.lm.registerLanguageModelChatProvider(config.vendor, provider)
    );
  }

  // 账单服务：余额/用量/定价统一调度（单厂商 + SWR + 去重 + 去抖）
  const billing = new BillingService(providers, context.globalState);
  context.subscriptions.push(billing);
  const dashboard = new BillingDashboard(billing, context.extensionUri);
  context.subscriptions.push(dashboard);
  registerBillingCommands(context, billing, dashboard);

  // 厂商探测：轮询 VS Code 内部状态库（state.vscdb）感知 Chat 面板当前选中的模型厂商
  const supportedVendors = vendorConfigs.map((c) => c.vendor);
  const vendorDetector = new VendorDetector(context, supportedVendors);
  context.subscriptions.push(vendorDetector);

  // Provider 被 VS Code 调用时通知 VendorDetector（用于检测用户切回非扩展厂商对话）
  for (const p of providers) {
    p.onActivity(() => vendorDetector.markProviderActivity());
  }

  // 状态栏：仅当 Chat 面板选中本插件支持的厂商时显示
  const statusBar = new BillingStatusBar(billing, vendorDetector);
  context.subscriptions.push(statusBar);

  // VendorDetector 检测到支持的厂商时，同步更新 BillingService 的 activeVendor
  vendorDetector.onDidChangeVendor((vendor) => {
    if (vendor && supportedVendors.includes(vendor)) {
      billing.setActiveVendor(vendor);
    }
  });

  // 定价远端同步：用 setTimeout 分散到空闲帧，避免启动时多个异步链并发打网络
  setTimeout(() => {
    void billing.syncPricing(false).catch(() => undefined);
  }, 0);

  // Context Window Hook：猴子补丁注入 usage 到原生 Widget
  void initializeContextWindowHookBridge((msg) => ExtensionLogger.get().info(msg)).then((ok) => {
    if (ok) {
      ExtensionLogger.get().info("Context Window Hook 已激活 — 原生上下文窗口 Widget 将显示 token 用量");
    } else {
      ExtensionLogger.get().info("Context Window Hook 未激活（Copilot Chat 内部结构不兼容），回退到 DataPart 通道");
    }
  }).catch((err) => {
    ExtensionLogger.get().error(`Context Window Hook 初始化异常: ${err instanceof Error ? err.message : String(err)}`);
  });
  context.subscriptions.push({ dispose: () => disposeContextWindowHookBridge() });

  ExtensionLogger.get().info(`已注册 ${vendorConfigs.length} 个厂商 Provider（含用量/余额/费用面板）`);
}

export function deactivate() {}
