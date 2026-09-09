import * as vscode from "vscode";
import type { BillingService } from "./billingService";
import type { VendorDetector } from "../utils/vendorDetector";

/**
 * 状态栏：仅当 Chat 面板选中本插件支持的厂商时显示。
 * 通过 VendorDetector 轮询 VS Code 内部状态库（state.vscdb）实时感知厂商切换。
 */
export class BillingStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly listener: vscode.Disposable;
  private vendorListener?: vscode.Disposable;
  private timer?: ReturnType<typeof setInterval>;
  private vendorPollTimer?: ReturnType<typeof setInterval>;
  private renderDebounce?: ReturnType<typeof setTimeout>;
  /** 当前是否应该显示（由 VendorDetector 驱动） */
  private shouldShow = false;

  constructor(
    private readonly billing: BillingService,
    private readonly vendorDetector?: VendorDetector
  ) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = "china-ai.showCostDashboard";
    this.listener = billing.onDidChange(() => {
      if (this.renderDebounce) clearTimeout(this.renderDebounce);
      this.renderDebounce = setTimeout(() => this.render(), 200);
    });

    // 监听 VendorDetector 的厂商切换事件
    if (vendorDetector) {
      this.vendorListener = vendorDetector.onDidChangeVendor((vendor) => {
        this.shouldShow = vendorDetector.isSupported;
        if (this.shouldShow && vendor) {
          this.billing.setActiveVendor(vendor);
        }
        this.render();
      });
      // 初始状态由 VendorDetector 首次 check 决定
      this.shouldShow = vendorDetector.isSupported;
    }

    this.render();
    const intervalSec = Math.max(15, vscode.workspace.getConfiguration("china-ai.billing").get<number>("refreshIntervalSec", 60) ?? 60);
    this.timer = setInterval(() => {
      void this.billing.refreshActiveBalance(false).then(() => this.render());
    }, intervalSec * 1000);

    // 每5秒检查 vendorDetector 状态，确保打开已有对话时能及时隐藏/显示状态栏
    this.vendorPollTimer = setInterval(() => {
      if (!vendorDetector) { return; }
      const supported = vendorDetector.isSupported;
      if (supported !== this.shouldShow) {
        this.shouldShow = supported;
        if (supported) {
          const v = vendorDetector.vendor;
          if (v) { this.billing.setActiveVendor(v); }
        }
        this.render();
      }
    }, 5000);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.vendorPollTimer) clearInterval(this.vendorPollTimer);
    if (this.renderDebounce) clearTimeout(this.renderDebounce);
    this.vendorListener?.dispose();
    this.listener.dispose();
    this.item.dispose();
  }

  render(): void {
    const cfg = vscode.workspace.getConfiguration("china-ai.billing");
    if (!cfg.get<boolean>("statusBar", true) || !this.shouldShow) {
      this.item.hide();
      return;
    }
    const vendor = this.billing.getActiveVendor();
    const provider = vendor ? this.billing.findProvider(vendor) : undefined;
    const name = provider?.providerConfig.displayName ?? vendor ?? "国内AI";
    const today = this.billing.getTodaySummary(vendor);
    const balance = vendor ? this.billing.getLastKnownBalance(vendor) : undefined;
    const balanceText = balance?.available !== undefined ? ` · 余额 ${balance.available}${balance.currency ?? ""}` : "";
    const rateText = today.hitRate !== undefined ? ` · 命中 ${(today.hitRate * 100).toFixed(0)}%` : "";
    this.item.text = `$(credit-card) ${name} 今 ${today.totalTokens}${rateText}${balanceText}`;
    this.item.tooltip = `今日：输入命中 ${today.cacheHitTokens} / 未命中 ${today.cacheMissTokens} / 输出 ${today.completionTokens}（仅当前厂商），点击打开数据面板`;
    this.item.show();
  }
}
