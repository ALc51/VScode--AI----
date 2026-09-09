import * as vscode from "vscode";
import type { BillingService } from "./billingService";
import { isBalanceSupported } from "../providers/billingStrategies";
import type { BillingDashboard } from "./billingDashboard";

/**
 * 命令面板（单厂商 + 专属面板）：
 * - 所有数据展示走 BillingDashboard Webview，不再写 OutputChannel
 * - 只加载当前厂商：记忆 > 探测 > 手动选择
 */
export function registerBillingCommands(
  context: vscode.ExtensionContext,
  billing: BillingService,
  dashboard: BillingDashboard
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("china-ai.showBalance", async () => {
      await dashboard.open(false);
    }),

    vscode.commands.registerCommand("china-ai.showUsage", async () => {
      await dashboard.open(false);
    }),

    vscode.commands.registerCommand("china-ai.showCostDashboard", async () => {
      await dashboard.open(false);
    }),

    vscode.commands.registerCommand("china-ai.refreshBalance", async () => {
      const vendor = await billing.ensureActiveVendor();
      if (!vendor) return;
      await billing.refreshBalance(vendor, true);
      await dashboard.open(false);
    }),

    vscode.commands.registerCommand("china-ai.refreshPricing", async () => {
      await billing.syncPricing(true);
      await dashboard.open(false);
    }),

    vscode.commands.registerCommand("china-ai.switchVendor", async () => {
      const vendor = await billing.pickActiveVendor();
      if (vendor) await dashboard.open(true);
    }),

    vscode.commands.registerCommand("china-ai.openBillingConsole", async (vendor?: string) => {
      const target = typeof vendor === "string" ? vendor : await billing.ensureActiveVendor();
      if (!target) return;
      const provider = billing.findProvider(target);
      if (!provider) return;
      if (isBalanceSupported(provider.providerConfig)) {
        // 支持余额的厂商也允许手动打开控制台
      }
      const url = provider.providerConfig.billingConsoleUrl;
      if (url) void vscode.env.openExternal(vscode.Uri.parse(url));
      else void vscode.window.showWarningMessage("该厂商未配置控制台链接");
    })
  );
}
