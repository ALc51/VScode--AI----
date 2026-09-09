import * as vscode from "vscode";
import type { BillingService } from "./billingService";
import { isBalanceSupported } from "../providers/billingStrategies";
import { summarizeUsage } from "../utils/usageStore";
import type { UsageSummary, UsageRecord } from "../utils/usageStore";

interface TokenSplit { hit: number; miss: number; output: number; hitRate?: number; }
interface TrendDay { date: string; tokens: number; hit: number; miss: number; output: number; cost: number; count: number; hitRate?: number; }
interface ModelRow { model: string; promptTokens: number; completionTokens: number; totalTokens: number; hit: number; miss: number; output: number; hitRate?: number; estimatedCost?: number; currency?: string; count: number; }
interface DashboardSnapshot {
  vendor: string; displayName: string;
  balance?: { available?: number; currency?: string; updatedAt?: number };
  balanceSupported: boolean; consoleUrl?: string;
  today: UsageSummary & TokenSplit; models: ModelRow[]; trend: TrendDay[]; totalTokens: number; availableModels: string[];
  rangeDays: number;
  pricing: { version: number; updatedAt: string }; state: "loading" | "ready" | "error"; message?: string;
}
interface PanelState { selectedModel: string; selectedRange: string; }

export class BillingDashboard implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private readonly listener: vscode.Disposable;
  private ps: PanelState = { selectedModel: "", selectedRange: "14" };

  constructor(private readonly billing: BillingService, private readonly extensionUri: vscode.Uri) {
    this.listener = billing.onDidChange(() => { if (this.panel) void this.render(false); });
  }

  dispose(): void { this.listener.dispose(); this.panel?.dispose(); this.panel = undefined; }

  async open(forceRefresh = false): Promise<void> {
    const vendor = await this.billing.ensureActiveVendor();
    if (!vendor) return;
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel("china-ai.billingDashboard", "国内AI · 用量统计", vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")] });
      this.panel.onDidDispose(() => { this.panel = undefined; });
      this.panel.webview.onDidReceiveMessage((msg: { command?: string; model?: string; range?: string }) => {
        if (msg?.command === "refresh") { void this.render(false); void this.billing.refreshBalance(this.billing.getActiveVendor() as string, true).catch(() => undefined); }
        else if (msg?.command === "switch") void this.switchVendor();
        else if (msg?.command === "console") void vscode.commands.executeCommand("china-ai.openBillingConsole", this.billing.getActiveVendor());
        else if (msg?.command === "setModel") { this.ps.selectedModel = msg.model ?? ""; void this.render(false); }
        else if (msg?.command === "setRange") { this.ps.selectedRange = msg.range ?? "14"; void this.render(false); }
      });
    }
    this.panel.reveal(vscode.ViewColumn.One);
    // 先用缓存秒出面板；余额后台异步刷新
    void this.render(false);
    if (forceRefresh) void this.billing.refreshBalance(vendor, true).catch(() => undefined);
  }

  private async switchVendor(): Promise<void> {
    if (await this.billing.pickActiveVendor()) {
      this.ps = { selectedModel: "", selectedRange: "14" };
      // 先用缓存秒出面板，余额后台异步刷新（避免阻塞 UI）
      void this.render(false);
      void this.billing.refreshBalance(this.billing.getActiveVendor() as string, true).catch(() => undefined);
    }
  }

  private async snapshot(forceRefresh: boolean): Promise<DashboardSnapshot> {
    const vendor = (await this.billing.ensureActiveVendor()) as string;
    const provider = this.billing.findProvider(vendor);
    const displayName = provider?.providerConfig.displayName ?? vendor;
    const supported = provider ? isBalanceSupported(provider.providerConfig) : false;
    let balance = this.billing.getLastKnownBalance(vendor);
    let state: DashboardSnapshot["state"] = balance?.available !== undefined ? "ready" : "loading";
    let message: string | undefined;

    // 余额：仅用缓存值（SWR），不阻塞面板渲染。
    // 首次打开或手动刷新时在后台异步触发网络请求，完成后通过 onDidChange 自动重渲染。
    if (supported && !balance) {
      state = "loading";
      void this.billing.refreshBalance(vendor, forceRefresh).catch(() => undefined);
    }

    const days = parseInt(this.ps.selectedRange, 10) || 14;
    const rawRecords = this.billing.getHistory(days, vendor);
    const allHistory = this.billing.getHistory(90, vendor);
    // 模型下拉：历史用量中出现过的模型 + 厂商已知模型列表（确保无用量时下拉不为空）
    const modelSet = new Set<string>();
    for (const r of allHistory) { if (r.totalTokens > 0) modelSet.add(r.model || "(未知模型)"); }
    for (const id of this.billing.getVendorModelIds(vendor)) { if (id) modelSet.add(id); }
    const availableModels = [...modelSet].sort();

    const filtered = this.ps.selectedModel ? rawRecords.filter((r) => (r.model || "(未知模型)") === this.ps.selectedModel) : rawRecords;

    // 今日汇总同样遵循当前模型筛选，保证卡片与图表口径一致
    const tNow = new Date();
    const todayKey = `${tNow.getFullYear()}-${String(tNow.getMonth() + 1).padStart(2, "0")}-${String(tNow.getDate()).padStart(2, "0")}`;
    const todayRecs = filtered.filter((r) => r.date === todayKey);
    const summary = summarizeUsage(todayRecs);
    const today = { ...summary, hit: summary.cacheHitTokens, miss: summary.cacheMissTokens, output: summary.completionTokens };

    // 填充范围内所有日期（含无数据日），确保图表连续
    const byDate = new Map<string, TrendDay>();
    const now = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now); d.setDate(d.getDate() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      byDate.set(key, { date: key, tokens: 0, hit: 0, miss: 0, output: 0, cost: 0, count: 0 });
    }
    for (const r of filtered) {
      let d = byDate.get(r.date);
      if (!d) { d = { date: r.date, tokens: 0, hit: 0, miss: 0, output: 0, cost: 0, count: 0 }; byDate.set(r.date, d); }
      d.tokens += r.totalTokens; d.hit += r.cacheHitTokens ?? 0; d.miss += r.cacheMissTokens ?? 0;
      d.output += r.completionTokens; d.cost += r.estimatedCost ?? 0; d.count += r.count;
    }
    const trend = [...byDate.values()].sort((a, b) => a.date < b.date ? -1 : 1);
    for (const d of trend) {
      const inp = d.hit + d.miss;
      d.hitRate = inp > 0 ? d.hit / inp : undefined;
      // 口径对齐：堆叠段之和即总量，避免上游 total_tokens 含额外口径导致柱顶与总量错位
      const stacked = d.hit + d.miss + d.output;
      if (stacked > 0) d.tokens = stacked;
    }

    // 模型明细同样遵循当前筛选（范围 + 模型），与卡片/图表口径一致
    const modelMap = new Map<string, ModelRow>();
    for (const r of filtered) {
      const key = r.model || "(未知模型)"; const ex = modelMap.get(key);
      if (ex) { ex.promptTokens += r.promptTokens; ex.completionTokens += r.completionTokens; ex.totalTokens += r.totalTokens; ex.hit += r.cacheHitTokens ?? 0; ex.miss += r.cacheMissTokens ?? 0; ex.output += r.completionTokens; ex.count += r.count; if (r.estimatedCost !== undefined) ex.estimatedCost = (ex.estimatedCost ?? 0) + r.estimatedCost; ex.currency = r.currency; }
      else modelMap.set(key, { model: key, promptTokens: r.promptTokens, completionTokens: r.completionTokens, totalTokens: r.totalTokens, hit: r.cacheHitTokens ?? 0, miss: r.cacheMissTokens ?? 0, output: r.completionTokens, estimatedCost: r.estimatedCost, currency: r.currency, count: r.count });
    }
    const models = [...modelMap.values()];
    for (const m of models) { const inp = m.hit + m.miss; m.hitRate = inp > 0 ? m.hit / inp : undefined; }

    const manifest = this.billing.getPricingManifest();
    const rangeTokens = filtered.reduce((a, r) => a + r.totalTokens, 0);
    return { vendor, displayName, balance: balance ? { available: balance.available, currency: balance.currency, updatedAt: balance.updatedAt } : undefined, balanceSupported: supported, consoleUrl: provider?.providerConfig.billingConsoleUrl, today, models, trend, totalTokens: rangeTokens, availableModels, rangeDays: days, pricing: { version: manifest.version, updatedAt: manifest.updatedAt }, state, message };
  }

  private async render(forceRefresh: boolean): Promise<void> {
    if (!this.panel) return;
    const snap = await this.snapshot(forceRefresh);
    this.panel.title = `${snap.displayName} · 用量统计`;
    this.panel.webview.html = this.html(snap);
  }

  // ── 工具 ──
  private esc(v: string | number | undefined): string { return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  private fr(r?: number) { return r === undefined ? "-" : `${(r * 100).toFixed(1)}%`; }
  private fn(v: number) { return v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : `${v}`; }
  private vendorIconUri(vendor: string): string | undefined {
    if (!this.panel) return undefined;
    const v = (vendor || "").toLowerCase();
    const file = v === "deepseek" ? "deepseek.svg" : v === "qwen" ? "qwen.svg" : v === "zhipu" ? "zhipu.svg" : v === "kimi" ? "kimi.svg" : v === "xiaomi" ? "xiaomi.svg" : undefined;
    if (!file) return undefined;
    return this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "icons", file)).toString();
  }
  private vendorMark(vendor: string): { cls: string; label: string; title: string } {
    const v = (vendor || "").toLowerCase();
    if (v === "deepseek") return { cls: "deepseek", label: "DS", title: "DeepSeek" };
    if (v === "qwen") return { cls: "qwen", label: "QW", title: "通义千问" };
    if (v === "zhipu") return { cls: "zhipu", label: "ZP", title: "智谱 GLM" };
    if (v === "kimi") return { cls: "kimi", label: "KI", title: "Kimi" };
    if (v === "xiaomi") return { cls: "xiaomi", label: "MI", title: "小米 MiMo" };
    return { cls: "fallback", label: "AI", title: vendor || "AI" };
  }

  // ── HTML ──
  private html(s: DashboardSnapshot): string {
    const csp = this.panel?.webview.cspSource ?? "none"; const st = this.ps;
    const bal = !s.balanceSupported
      ? `<span class="muted">暂不支持余额</span><button class="btn-ghost" data-cmd="console">控制台 ↗</button>`
      : s.balance?.available !== undefined
        ? `<div class="bal"><span class="bal-v">${this.esc(s.balance.available)}</span><span class="bal-u">${this.esc(s.balance.currency ?? "CNY")}</span><span class="bal-dot"></span><span class="bal-time">${s.balance.updatedAt ? new Date(s.balance.updatedAt).toLocaleString("zh-CN") : ""}</span></div>`
        : s.state === "loading" ? `<span class="muted">刷新中…</span>` : `<span class="muted">${this.esc(s.message ?? "获取失败")}</span><button class="btn-ghost" data-cmd="refresh">重试</button>`;

    const modelOpts = `<option value="">全部模型</option>` + s.availableModels.map((m) => `<option value="${this.esc(m)}" ${m === st.selectedModel ? "selected" : ""}>${this.esc(m)}</option>`).join("");
    const rangeOpts = [["7", "近 7 天"], ["14", "近 14 天"], ["30", "近 30 天"], ["90", "近 90 天"]].map(([v, l]) => `<option value="${v}" ${v === st.selectedRange ? "selected" : ""}>${l}</option>`).join("");

    const tr = s.models.length === 0 ? `<tr><td colspan="7" class="empty"><div class="empty-ill">◌</div>暂无用量数据<div class="empty-sub">发起一次聊天后，这里会按模型汇总消耗</div></td></tr>`
      : s.models.map((m) => `<tr><td><span class="model-name">${this.esc(m.model)}</span><span class="model-count">${m.count} 次</span></td><td class="r">${this.fn(m.hit)}</td><td class="r">${this.fn(m.miss)}</td><td class="r">${this.fn(m.output)}</td><td class="r"><span class="pill ${m.hitRate !== undefined && m.hitRate >= 0.5 ? "pill-good" : m.hitRate !== undefined ? "pill-warn" : ""}">${this.fr(m.hitRate)}</span></td><td class="r"><b>${this.fn(m.totalTokens)}</b></td><td class="r">${m.estimatedCost !== undefined ? `¥${m.estimatedCost.toFixed(4)}` : "<span class='muted'>-</span>"}</td></tr>`).join("");

    const chart = this.chart(s);
    const hasFilter = !!st.selectedModel;
    const insight = s.totalTokens === 0 ? "" : hasFilter ? `已筛选 <b>${this.esc(st.selectedModel)}</b> · 近 ${s.rangeDays} 天` : `近 ${s.rangeDays} 天 · 日均 ${this.fn(Math.round(s.totalTokens / s.rangeDays))}`;

    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src ${csp} 'unsafe-inline'; img-src ${csp} https: data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
*{box-sizing:border-box;margin:0;padding:0;}
:root{--radius:12px;--radius-sm:8px;}
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:22px 24px;line-height:1.5;max-width:1100px;margin:0 auto;}
/* header */
.topbar{display:flex;align-items:center;gap:14px;margin-bottom:18px;flex-wrap:wrap;}
.brand{display:flex;align-items:center;gap:10px;}
.brand-mark{width:30px;height:30px;border-radius:9px;display:grid;place-items:center;flex-shrink:0;overflow:hidden;background:transparent;}
.brand-mark img{width:100%;height:100%;object-fit:contain;display:block;}
.brand-mark .bm-fallback{width:100%;height:100%;display:grid;place-items:center;color:#fff;font-size:11.5px;font-weight:800;border-radius:9px;}
.brand-mark--deepseek{background:linear-gradient(135deg,#1d4ed8 0%,#06b6d4 100%);}
.brand-mark--qwen{background:linear-gradient(135deg,#ea580c 0%,#f59e0b 55%,#ef4444 100%);}
.brand-mark--zhipu{background:linear-gradient(135deg,#6d28d9 0%,#a78bfa 55%,#ec4899 100%);}
.brand-mark--kimi{background:linear-gradient(135deg,#0f172a 0%,#334155 60%,#64748b 100%);}
.brand-mark--xiaomi{background:linear-gradient(135deg,#ff6900 0%,#ffb800 100%);}
.brand-mark--fallback{background:linear-gradient(135deg,#60a5fa,#a78bfa);}
.brand h1{font-size:15px;font-weight:700;letter-spacing:.2px;}
.brand h1 b{font-weight:400;color:var(--vscode-descriptionForeground);margin-left:6px;font-size:12px;}
.sp{flex:1;}
.bal{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;}
.bal-v{font-size:22px;font-weight:800;letter-spacing:-.5px;font-variant-numeric:tabular-nums;}
.bal-u{font-size:11px;color:var(--vscode-descriptionForeground);font-weight:600;letter-spacing:.3px;}
.bal-dot{width:4px;height:4px;border-radius:50%;background:var(--vscode-descriptionForeground);opacity:.4;margin:0 2px;}
.bal-time{font-size:11px;color:var(--vscode-descriptionForeground);}
.btn-ghost{background:var(--vscode-button-secondaryBackground,transparent);color:var(--vscode-foreground);border:1px solid var(--vscode-panel-border);border-radius:6px;padding:5px 10px;font-size:12px;cursor:pointer;transition:.15s;}
.btn-ghost:hover{background:var(--vscode-button-secondaryHoverBackground);border-color:var(--vscode-focusBorder);}
.btn-primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:1px solid transparent;border-radius:6px;padding:5px 12px;font-size:12px;cursor:pointer;}
.btn-primary:hover{background:var(--vscode-button-hoverBackground);}
.sel{background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));border-radius:6px;padding:6px 10px;font-size:12px;cursor:pointer;min-width:110px;}
.sel:focus{outline:1px solid var(--vscode-focusBorder);}
/* summary */
.summary-head{display:flex;align-items:end;gap:12px;margin-bottom:12px;flex-wrap:wrap;}
.summary-title{font-size:13px;font-weight:700;}
.summary-title span{font-weight:400;color:var(--vscode-descriptionForeground);margin-left:6px;font-size:12px;}
.summary-total{font-size:22px;font-weight:800;letter-spacing:-.5px;font-variant-numeric:tabular-nums;}
.summary-total small{font-size:12px;font-weight:600;color:var(--vscode-descriptionForeground);margin-left:4px;}
.kpi-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:10px;margin-bottom:16px;}
@media(max-width:900px){.kpi-grid{grid-template-columns:repeat(4,1fr);}}
@media(max-width:560px){.kpi-grid{grid-template-columns:repeat(2,1fr);}}
.kpi{border:1px solid var(--vscode-panel-border);border-radius:var(--radius-sm);background:var(--vscode-sideBar-background);padding:12px 13px;position:relative;overflow:hidden;}
.kpi::after{content:"";position:absolute;inset:0 0 auto 0;height:2px;opacity:.9;}
.kpi:nth-child(1)::after{background:#60a5fa;} .kpi:nth-child(2)::after{background:#86efac;} .kpi:nth-child(3)::after{background:#c4b5fd;} .kpi:nth-child(4)::after{background:#fdba74;} .kpi:nth-child(5)::after{background:#5eead4;} .kpi:nth-child(6)::after{background:#f472b6;} .kpi:nth-child(7)::after{background:#facc15;}
.kpi-label{font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:flex;align-items:center;gap:6px;}
.kpi-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0;}
.kpi-value{font-size:18px;font-weight:800;font-variant-numeric:tabular-nums;letter-spacing:-.3px;white-space:nowrap;}
.kpi-value.gr{color:#86efac;} .kpi-value.am{color:#c4b5fd;} .kpi-value.bl{color:#fdba74;}
.kpi-foot{font-size:11px;color:var(--vscode-descriptionForeground);margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
/* chart card */
.cc{border:1px solid var(--vscode-panel-border);border-radius:var(--radius);background:var(--vscode-sideBar-background);padding:16px 16px 10px;margin-bottom:16px;overflow:visible;box-shadow:0 1px 0 rgba(0,0,0,.04);}
.chart-head{display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap;}
.chart-title{font-size:13px;font-weight:700;}
.chart-sub{font-size:11px;color:var(--vscode-foreground);background:var(--vscode-badge-background, rgba(127,127,127,.18));padding:2px 8px;border-radius:999px;opacity:.95;}
.chart-actions{margin-left:auto;display:flex;gap:8px;align-items:center;}
.sparse-note{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--vscode-descriptionForeground);background:rgba(96,165,250,.08);border:1px dashed rgba(96,165,250,.25);border-radius:8px;padding:7px 10px;margin-bottom:10px;}
.sparse-note b{color:var(--vscode-foreground);}
.sparse-note .dot{width:6px;height:6px;border-radius:50%;background:#60a5fa;flex-shrink:0;box-shadow:0 0 0 4px rgba(96,165,250,.15);}
.cl{display:flex;gap:14px;flex-wrap:wrap;align-items:center;font-size:12px;color:var(--vscode-foreground);margin-bottom:10px;padding:8px 10px;border-radius:8px;background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);opacity:.95;}
.cl b{color:var(--vscode-foreground);}
.ld{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:middle;}
.lg-v{font-weight:700;color:var(--vscode-foreground);margin-left:4px;font-variant-numeric:tabular-nums;}
.zero-dot{opacity:.18;}
.bar-ring{stroke:#60a5fa;stroke-width:1;fill:none;opacity:.35;}
.peak-ring{stroke:#60a5fa;stroke-width:1.5;fill:none;opacity:.6;}
.bar-group{cursor:default;}
.bar-group:hover .bar-seg{filter:brightness(1.12) saturate(1.1);}
.bar-seg{transition:filter .15s, opacity .15s;}
.bar-val{font-variant-numeric:tabular-nums;fill:var(--vscode-foreground);font-weight:700;paint-order:stroke;stroke:var(--vscode-sideBar-background);stroke-width:3px;stroke-linejoin:round;}
.bar-val-bg{fill:var(--vscode-sideBar-background);opacity:.85;}
@keyframes grow{from{transform:scaleY(0)}to{transform:scaleY(1)}}
.bar-seg{transform-origin:bottom;animation:grow .5s cubic-bezier(.16,1,.3,1) both;}
.tp{position:absolute;display:none;z-index:20;background:var(--vscode-editorWidget-background);border:1px solid var(--vscode-editorWidget-border);border-radius:8px;padding:10px 12px;font-size:12px;line-height:1.7;pointer-events:none;min-width:190px;box-shadow:0 8px 24px rgba(0,0,0,.22);white-space:nowrap;}
.tp-t{font-weight:700;margin-bottom:4px;font-size:13px;display:flex;align-items:center;gap:6px;}
.tp-r{display:flex;align-items:center;gap:8px;}
.tp-r b{margin-left:auto;font-variant-numeric:tabular-nums;}
.tp-d{display:inline-block;width:8px;height:8px;border-radius:50%;flex-shrink:0;}
.tp-s{color:var(--vscode-descriptionForeground);margin-top:6px;font-size:11px;border-top:1px solid var(--vscode-panel-border);padding-top:6px;}
/* table */
.tc{border:1px solid var(--vscode-panel-border);border-radius:var(--radius);background:var(--vscode-sideBar-background);overflow:hidden;margin-bottom:16px;}
.tt{font-size:13px;font-weight:700;padding:13px 16px;border-bottom:1px solid var(--vscode-panel-border);display:flex;align-items:center;gap:8px;}
.tt small{font-weight:400;color:var(--vscode-descriptionForeground);font-size:11px;}
table{width:100%;border-collapse:collapse;font-size:12px;}
th{text-align:left;padding:10px 12px;color:var(--vscode-descriptionForeground);font-weight:600;border-bottom:1px solid var(--vscode-panel-border);font-size:11px;letter-spacing:.3px;text-transform:uppercase;white-space:nowrap;}
td{padding:10px 12px;border-bottom:1px solid var(--vscode-panel-border);vertical-align:middle;}
td.r{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;}
td.empty{text-align:center;color:var(--vscode-descriptionForeground);padding:28px 16px;}
.empty-ill{font-size:22px;margin-bottom:6px;opacity:.6;}
.empty-sub{font-size:11px;margin-top:4px;opacity:.8;}
tr:last-child td{border-bottom:none;}
tbody tr:hover{background:var(--vscode-list-hoverBackground);}
.model-name{font-weight:600;}
.model-count{margin-left:8px;font-size:11px;color:var(--vscode-foreground);background:var(--vscode-badge-background, rgba(127,127,127,.22));padding:1px 6px;border-radius:999px;vertical-align:middle;opacity:.95;}
.pill{padding:2px 7px;border-radius:999px;font-size:11px;font-weight:700;font-variant-numeric:tabular-nums;background:var(--vscode-badge-background, rgba(127,127,127,.15));}
.pill-good{background:rgba(134,239,172,.18);color:#86efac;border:1px solid rgba(134,239,172,.25);}
.pill-warn{background:rgba(196,181,253,.18);color:#c4b5fd;border:1px solid rgba(196,181,253,.25);}
.muted{color:var(--vscode-descriptionForeground);font-size:12px;}
.footnote{text-align:center;color:var(--vscode-descriptionForeground);font-size:11px;margin-top:4px;}
svg text{fill:var(--vscode-descriptionForeground);}
.x-label{fill:var(--vscode-descriptionForeground);}
.y-label{fill:var(--vscode-descriptionForeground);}
</style></head><body>
<div class="topbar">
  <div class="brand">${(() => { const m = this.vendorMark(s.vendor); const uri = this.vendorIconUri(s.vendor); return uri ? `<img class="brand-mark" src="${this.esc(uri)}" alt="${this.esc(m.title)}" title="${this.esc(m.title)}">` : `<div class="brand-mark brand-mark--${this.esc(m.cls)}" title="${this.esc(m.title)}"><span class="bm-fallback">${this.esc(m.label)}</span></div>`; })()}<h1>${this.esc(s.displayName)}<b>用量统计</b></h1></div>
  <div class="sp"></div>
  <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">${bal}<button class="btn-ghost" data-cmd="switch">切换厂商</button><button class="btn-primary" data-cmd="refresh">刷新</button></div>
</div>

<div class="summary-head">
  <div>
    <div class="summary-title">Token 消耗 <span>${insight}</span></div>
    <div class="summary-total">${this.fn(s.totalTokens)} <small>Tokens</small></div>
  </div>
  <div class="sp"></div>
  <select class="sel" onchange="vscode.postMessage({command:'setModel',model:this.value})">${modelOpts}</select>
  <select class="sel" onchange="vscode.postMessage({command:'setRange',range:this.value})">${rangeOpts}</select>
</div>

<div class="kpi-grid">
  <div class="kpi"><div class="kpi-label"><span class="kpi-dot" style="background:#60a5fa"></span>今日总消耗</div><div class="kpi-value">${this.fn(s.today.totalTokens)}</div><div class="kpi-foot">${s.today.count} 次请求</div></div>
  <div class="kpi"><div class="kpi-label"><span class="kpi-dot" style="background:#86efac"></span>输入 · 命中缓存</div><div class="kpi-value gr">${this.fn(s.today.hit)}</div><div class="kpi-foot">占比 ${s.today.totalTokens ? ((s.today.hit / Math.max(1, s.today.totalTokens)) * 100).toFixed(1) : "0.0"}%</div></div>
  <div class="kpi"><div class="kpi-label"><span class="kpi-dot" style="background:#c4b5fd"></span>输入 · 未命中</div><div class="kpi-value am">${this.fn(s.today.miss)}</div><div class="kpi-foot">占比 ${s.today.totalTokens ? ((s.today.miss / Math.max(1, s.today.totalTokens)) * 100).toFixed(1) : "0.0"}%</div></div>
  <div class="kpi"><div class="kpi-label"><span class="kpi-dot" style="background:#fdba74"></span>输出</div><div class="kpi-value bl">${this.fn(s.today.output)}</div><div class="kpi-foot">占比 ${s.today.totalTokens ? ((s.today.output / Math.max(1, s.today.totalTokens)) * 100).toFixed(1) : "0.0"}%</div></div>
  <div class="kpi"><div class="kpi-label"><span class="kpi-dot" style="background:#5eead4"></span>命中率</div><div class="kpi-value">${this.fr(s.today.hitRate)}</div><div class="kpi-foot">输入命中 / 输入总量</div></div>
  <div class="kpi"><div class="kpi-label"><span class="kpi-dot" style="background:#f472b6"></span>请求数</div><div class="kpi-value">${s.today.count}</div><div class="kpi-foot">今日</div></div>
  <div class="kpi"><div class="kpi-label"><span class="kpi-dot" style="background:#facc15"></span>预估费用</div><div class="kpi-value">¥${s.today.estimatedCost.toFixed(4)}</div><div class="kpi-foot">今日</div></div>
</div>

<div class="cc" id="chart-card">${chart}</div>

<div class="tc"><div class="tt">模型明细 <small>近 ${s.rangeDays} 天${hasFilter ? " · 已筛选 " + this.esc(st.selectedModel) : ""} · ${s.models.length} 个模型</small><span class="sp"></span><span class="muted" style="font-size:11px;">命中率 = 命中 / (命中+未命中)</span></div><table><thead><tr><th>模型</th><th style="text-align:right">输入·命中</th><th style="text-align:right">输入·未命中</th><th style="text-align:right">输出</th><th style="text-align:right">命中率</th><th style="text-align:right">合计</th><th style="text-align:right">预估费用</th></tr></thead><tbody>${tr}</tbody></table></div>
<div class="footnote">定价版本 v${s.pricing.version} · 更新于 ${this.esc(s.pricing.updatedAt)} · 上游未返回缓存字段时命中率显示 "-"</div>
<script>(function(){var vscode=acquireVsCodeApi();window.vscode=vscode;document.querySelectorAll('[data-cmd]').forEach(function(b){b.addEventListener('click',function(){vscode.postMessage({command:b.getAttribute('data-cmd')});});});var tip=document.getElementById('chart-tip');if(!tip)return;var card=document.getElementById('chart-card');document.querySelectorAll('.hz').forEach(function(z){z.addEventListener('mouseenter',function(){tip.innerHTML=z.getAttribute('data-tip')||'';tip.style.display='block';if(!card)return;var cr=card.getBoundingClientRect();var zr=z.getBoundingClientRect();var tx=zr.left-cr.left+zr.width/2;var ty=zr.top-cr.top-8;var tw=tip.offsetWidth,th=tip.offsetHeight;if(tx+tw>cr.width-8)tx=cr.width-tw-8;if(tx<8)tx=8;var top=ty-th;if(top<4)top=zr.bottom-cr.top+8;tip.style.left=tx+'px';tip.style.top=top+'px';});z.addEventListener('mouseleave',function(){tip.style.display='none';});});})();</script>
</body></html>`;
  }

  // ── SVG 图表：堆叠柱（命中 / 未命中 / 输出三段实色） ──
  // 重构说明：总量折线与堆叠柱顶完全重复（总量恒等于三段之和），
  // 且稀疏数据下 Catmull-Rom 平滑曲线会产生误导性插值，故删除折线/面积/圆点，
  // 只保留堆叠柱 + 顶部数值 + 悬停详情，口径更清晰。
  // 稀疏优化：仅 1-2 天有数据时，空日显示基线圆点而非空白，并提示“稀疏”避免误判为断档。
  private chart(s: DashboardSnapshot): string {
    const data = s.trend;
    if (data.length === 0) return `<div class="muted" style="text-align:center;padding:40px 0;">暂无历史数据</div>`;
    const totals = data.map((d) => d.hit + d.miss + d.output);
    const maxV = Math.max(0, ...totals);
    if (maxV <= 0) return `<div class="chart-head"><span class="chart-title">每日 Token 消耗</span><span class="chart-sub">近 ${s.rangeDays} 天暂无用量</span></div><div style="text-align:center;padding:28px 0 18px;"><div style="font-size:28px;opacity:.35;margin-bottom:8px;">◌</div><div class="muted">暂无用量数据</div><div class="muted" style="font-size:11px;margin-top:4px;">发起一次聊天后，这里会按日展示命中 / 未命中 / 输出的堆叠消耗</div></div>`;

    const n = data.length;
    const W = 900, H = 300, pL = 60, pR = 16, pT = 26, pB = 36;
    const cW = W - pL - pR, cH = H - pT - pB;
    const slotW = cW / n;
    const barW = Math.max(8, Math.min(slotW * 0.52, 38));
    const nonZero = totals.filter((t) => t > 0).length;

    // 刻度取整：nMax 为 yTicks 的整数倍，保证刻度标签无小数、无重复
    const yTicks = 4;
    const yStep = Math.max(1, Math.ceil(this.niceMax(maxV) / yTicks));
    const nMax = yStep * yTicks;
    const base = pT + cH;
    const yS = (v: number) => pT + cH * (1 - v / nMax);

    // Y 轴淡网格实线
    const yLines = Array.from({ length: yTicks + 1 }, (_, i) => {
      const v = Math.round((nMax / yTicks) * i); const y = yS(v);
      return `<line x1="${pL}" y1="${y.toFixed(1)}" x2="${W - pR}" y2="${y.toFixed(1)}" stroke="currentColor" stroke-opacity="0.09"/>`
        + `<text class="y-label" x="${pL - 8}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" font-size="10">${this.fn(v)}</text>`;
    }).join("");

    const C_HIT = "#86efac";
    const C_MISS = "#c4b5fd";
    const C_OUT = "#fdba74";
    const GAP = 1.5;

    const labelEvery = n <= 14 ? 1 : n <= 30 ? 3 : Math.ceil(n / 10);
    const isSparse = nonZero > 0 && (nonZero <= 2 || nonZero / n < 0.18);
    const peakIdx = totals.indexOf(maxV);

    const bars = data.map((d, i) => {
      const cx = pL + i * slotW + slotW / 2, bx = cx - barW / 2;
      const total = d.hit + d.miss + d.output;
      const isPeak = i === peakIdx && total > 0;
      const showLabel = (i % labelEvery === 0 || i === n - 1)
        ? `<text class="x-label" x="${cx.toFixed(1)}" y="${(H - 14).toFixed(1)}" text-anchor="middle" font-size="10">${this.esc(d.date.slice(5))}</text>` : "";
      const tip = `<div class="tp-t"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${isPeak ? "#60a5fa" : "var(--vscode-descriptionForeground)"}"></span>${this.esc(d.date)} · ${this.esc(this.fn(total))} Tokens${isPeak ? ' · 峰值' : ''}</div>`
        + `<div class="tp-r"><span class="tp-d" style="background:${C_HIT}"></span>输入（命中缓存）<b>${this.esc(this.fn(d.hit))}</b></div>`
        + `<div class="tp-r"><span class="tp-d" style="background:${C_MISS}"></span>输入（未命中缓存）<b>${this.esc(this.fn(d.miss))}</b></div>`
        + `<div class="tp-r"><span class="tp-d" style="background:${C_OUT}"></span>输出<b>${this.esc(this.fn(d.output))}</b></div>`
        + `<div class="tp-s">命中率 ${this.fr(d.hitRate)} · ¥${d.cost.toFixed(4)} · ${d.count} 次</div>`;
      const hz = `<rect class="hz" x="${(pL + i * slotW + 1).toFixed(1)}" y="${pT}" width="${(slotW - 2).toFixed(1)}" height="${cH}" fill="transparent" data-tip="${this.esc(tip)}"/>`;
      if (total === 0) {
        // 稀疏数据：空日显示基线小圆点，避免大片空白被误判为加载失败
        const dot = `<circle cx="${cx.toFixed(1)}" cy="${base.toFixed(1)}" r="2.2" fill="currentColor" class="zero-dot" opacity="0.22"/>`;
        return `<g class="bar-group">${showLabel}${dot}${hz}</g>`;
      }
      // 自底向上：输出 → 未命中 → 命中，分段胶囊（间隙分隔），顶部数值
      const oH = (cH * d.output) / nMax;
      const mH = (cH * d.miss) / nMax;
      const hH = (cH * d.hit) / nMax;
      const segs: Array<{ h: number; c: string }> = [{ h: oH, c: C_OUT }, { h: mH, c: C_MISS }, { h: hH, c: C_HIT }];
      let y = base;
      const placed: Array<{ x: number; y: number; w: number; h: number; c: string }> = [];
      for (const sg of segs) {
        if (sg.h < 0.5) continue;
        const isBottom = placed.length === 0;
        const drawH = Math.max(sg.h - (isBottom ? 0 : GAP), 1);
        const drawY = y - sg.h + (isBottom ? 0 : GAP);
        placed.push({ x: bx, y: drawY, w: barW, h: drawH, c: sg.c });
        y -= sg.h;
      }
      const topY = y;
      const delay = (i * 28) + "ms";
      const rects = placed.map((p) => `<rect class="bar-seg" x="${p.x.toFixed(1)}" y="${p.y.toFixed(1)}" width="${p.w.toFixed(1)}" height="${p.h.toFixed(1)}" rx="${Math.min(4, p.h / 2).toFixed(1)}" fill="${p.c}" style="animation-delay:${delay}"/>`).join("");
      const barH = base - topY;
      const showVal = nonZero <= 7 || barH > 26;
      // 数值标签带描边/底衬，保证在深色主题下可读
      const valBg = showVal ? `<rect x="${(cx - 18).toFixed(1)}" y="${(topY - 16).toFixed(1)}" width="36" height="12" rx="4" class="bar-val-bg"/>` : "";
      const val = showVal ? `${valBg}<text class="bar-val" x="${cx.toFixed(1)}" y="${(topY - 7).toFixed(1)}" text-anchor="middle" font-size="10">${this.fn(total)}</text>` : "";
      const barRing = barH > 18 ? `<rect x="${(bx - 2).toFixed(1)}" y="${(topY - 2).toFixed(1)}" width="${(barW + 4).toFixed(1)}" height="${(barH + 4).toFixed(1)}" rx="6" class="${isPeak ? 'peak-ring' : 'bar-ring'}"/>` : "";
      return `<g class="bar-group">${showLabel}${barRing}${val}${rects}${hz}</g>`;
    }).join("");

    const sumHit = data.reduce((a, d) => a + d.hit, 0);
    const sumMiss = data.reduce((a, d) => a + d.miss, 0);
    const sumOut = data.reduce((a, d) => a + d.output, 0);
    const sparseNote = isSparse ? `<div class="sparse-note"><span class="dot"></span><span>仅 <b>${nonZero}</b> 天有数据 · 其余为空白属正常（按所选范围展示，无用量日显示基线圆点）</span></div>` : "";

    return `<div class="chart-head"><span class="chart-title">每日 Token 消耗</span><span class="chart-sub">堆叠 = 命中 / 未命中 / 输出 · 近 ${s.rangeDays} 天共 ${this.fn(s.totalTokens)}</span><span class="sp"></span><span class="muted" style="font-size:11px;">日均 ${this.fn(Math.round(s.totalTokens / s.rangeDays))}</span></div>`
      + sparseNote
      + `<div class="cl"><span><span class="ld" style="background:${C_HIT}"></span>输入（命中缓存）<b class="lg-v">${this.fn(sumHit)}</b></span><span><span class="ld" style="background:${C_MISS}"></span>输入（未命中缓存）<b class="lg-v">${this.fn(sumMiss)}</b></span><span><span class="ld" style="background:${C_OUT}"></span>输出<b class="lg-v">${this.fn(sumOut)}</b></span><span class="muted" style="margin-left:auto;font-size:11px;">峰值 ${this.fn(maxV)} · ${data[peakIdx]?.date ?? ""}</span></div>`
      + `<div style="position:relative"><div id="chart-tip" class="tp"></div>`
      + `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="每日 Token 消耗堆叠柱状图" style="overflow:visible"><title>每日 Token 消耗</title>`
      + yLines
      + `<line x1="${pL}" y1="${base}" x2="${W - pR}" y2="${base}" stroke="currentColor" stroke-opacity="0.18"/>`
      + bars
      + `</svg></div>`;
  }

  private niceMax(v: number): number {
    if (v <= 0) return 100;
    const exp = Math.floor(Math.log10(v)), base = Math.pow(10, exp), norm = v / base;
    return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * base;
  }
}
