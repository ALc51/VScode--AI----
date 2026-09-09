import type * as vscode from "vscode";

/** 错误分类：用于监控聚合与用户提示 */
export type ErrorKind =
  | "NoApiKey"
  | "AuthenticationError"
  | "NetworkError"
  | "ServerError"
  | "RateLimited"
  | "HttpError"
  | "StreamError"
  | "EmptyResponse"
  | "NoResponse"
  | "Cancelled"
  | "TimeoutError"
  | "ModelListError"
  | "ModelListRetry"
  | "ModelListFallback"
  | "Unknown";

export interface LogContext {
  vendor?: string;
  modelId?: string;
  status?: number;
  attempt?: number;
  kind?: ErrorKind;
}

/**
 * 集中式日志：统一打到 OutputChannel + console。
 * - 不记录 apiKey / secret（调用方只传脱敏后的上下文）
 * - 错误体截断到 200 字符
 */
export class ExtensionLogger {
  private static instance?: ExtensionLogger;
  private channel?: vscode.OutputChannel;

  static get(): ExtensionLogger {
    if (!ExtensionLogger.instance) {
      ExtensionLogger.instance = new ExtensionLogger();
    }
    return ExtensionLogger.instance;
  }

  /** extension.ts 在 activate 时调用一次 */
  init(channel: vscode.OutputChannel): void {
    this.channel = channel;
  }

  private write(level: "INFO" | "WARN" | "ERROR", message: string, ctx?: LogContext): void {
    const parts = [`[${new Date().toISOString()}]`, `[${level}]`];
    if (ctx?.vendor) parts.push(`[${ctx.vendor}]`);
    if (ctx?.modelId) parts.push(`[${ctx.modelId}]`);
    if (ctx?.kind) parts.push(`[${ctx.kind}]`);
    if (ctx?.status !== undefined) parts.push(`[status=${ctx.status}]`);
    if (ctx?.attempt !== undefined) parts.push(`[attempt=${ctx.attempt}]`);
    const line = `${parts.join(" ")} ${message}`;
    this.channel?.appendLine(line);
    if (level === "ERROR") {
      console.error(line);
    } else if (level === "WARN") {
      console.warn(line);
    } else {
      console.log(line);
    }
  }

  info(message: string, ctx?: LogContext): void {
    this.write("INFO", message, ctx);
  }

  warn(message: string, ctx?: LogContext): void {
    this.write("WARN", message, ctx);
  }

  error(message: string, ctx?: LogContext): void {
    this.write("ERROR", message, ctx);
  }

  /** 截断上游错误体，避免暴露完整堆栈 */
  static truncate(text: string, max = 200): string {
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }
}

/** 把 LanguageModelError 的 cause 映射回 ErrorKind（结构类型，不依赖 vscode runtime） */
export function classifyError(err: unknown): ErrorKind {
  const cause = (err as { cause?: unknown } | null)?.cause;
  const name = cause instanceof Error ? cause.message : String(cause ?? "");
  const known: ErrorKind[] = [
    "NoApiKey",
    "AuthenticationError",
    "NetworkError",
    "ServerError",
    "RateLimited",
    "HttpError",
    "StreamError",
    "EmptyResponse",
    "NoResponse",
    "Cancelled",
    "TimeoutError",
    "ModelListError",
  ];
  if (known.includes(name as ErrorKind)) {
    return name as ErrorKind;
  }
  if (err instanceof Error && /abort|cancel/i.test(err.message)) {
    return "Cancelled";
  }
  return "Unknown";
}
