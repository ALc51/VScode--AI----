/**
 * Context Window Hook Bridge — 桥接层
 *
 * 通过静态导入 hook 模块（esbuild 打包为单文件，动态 import 无法解析），
 * 初始化时尝试激活 hook；如果 VS Code 内部结构变化导致捕获失败，自动回退到 no-op。
 */
import type * as vscode from "vscode";
import {
  reportUsageToContextWindow as _reportUsage,
  reportProgressWithRequest as _reportProgress,
  clearContextWindowRequest as _clearRequest,
  setOutputBufferForRequest as _setOutputBuffer,
  generateLocalRequestId as _generateId,
  withContextWindowRequest as _withRequest,
  setDiagLogger as _setDiagLogger,
  initializeContextWindowHook as _initializeHook,
  disposeContextWindowHook as _disposeHook,
} from "./contextWindowHook.js";

// ── 默认 no-op 实现 ──
let reportUsageImpl = (_localRequestId: string, _usage: { promptTokens?: number; completionTokens?: number }): boolean => false;
let reportProgressImpl = (
  _localRequestId: string,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  part: vscode.LanguageModelResponsePart,
): void => {
  progress.report(part);
};
let clearRequestImpl = (_localRequestId: string): void => {};
let setOutputBufferImpl = (_localRequestId: string, _outputBuffer: number): void => {};
let generateIdImpl = (): string => `china_ai_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
let withRequestImpl = <T>(_localRequestId: string, fn: () => T): T => fn();

let hookActive = false;

function installNoopImplementations(): void {
  reportUsageImpl = () => false;
  reportProgressImpl = (_id, progress, part) => progress.report(part);
  clearRequestImpl = () => {};
  setOutputBufferImpl = () => {};
  generateIdImpl = () => `china_ai_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  withRequestImpl = (_id, fn) => fn();
}

function installHookImplementations(): void {
  reportUsageImpl = _reportUsage;
  reportProgressImpl = _reportProgress;
  clearRequestImpl = _clearRequest;
  setOutputBufferImpl = _setOutputBuffer;
  generateIdImpl = _generateId;
  withRequestImpl = _withRequest;
  // 传递诊断日志器到 hook 模块
  if (typeof _setDiagLogger === "function") {
    _setDiagLogger((msg) => console.log(msg));
  }
}

// ── 公开 API ──

export function reportUsageToContextWindow(
  localRequestId: string,
  usage: { promptTokens?: number; completionTokens?: number },
): boolean {
  return reportUsageImpl(localRequestId, usage);
}

export function reportProgressWithRequest(
  localRequestId: string,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  part: vscode.LanguageModelResponsePart,
): void {
  reportProgressImpl(localRequestId, progress, part);
}

export function clearContextWindowRequest(localRequestId: string): void {
  clearRequestImpl(localRequestId);
}

export function setOutputBufferForRequest(localRequestId: string, outputBuffer: number): void {
  setOutputBufferImpl(localRequestId, outputBuffer);
}

export function generateLocalRequestId(): string {
  return generateIdImpl();
}

export function withContextWindowRequest<T>(localRequestId: string, fn: () => T): T {
  return withRequestImpl(localRequestId, fn);
}

/**
 * 初始化 bridge — 尝试激活 hook 模块
 * @returns true 如果 hook 成功激活
 */
export async function initializeContextWindowHookBridge(logDiagnostic?: (message: string) => void): Promise<boolean> {
  try {
    const success = await _initializeHook(logDiagnostic);
    if (success) {
      installHookImplementations();
      hookActive = true;
      logDiagnostic?.("contextWindowHook: bridge active — usage will be injected into the Context Window widget");
    } else {
      installNoopImplementations();
      hookActive = false;
      logDiagnostic?.("contextWindowHook: bridge staying in no-op mode (proxy capture failed)");
    }
    return success;
  } catch (err) {
    installNoopImplementations();
    hookActive = false;
    const msg = err instanceof Error ? err.message : String(err);
    logDiagnostic?.(`contextWindowHook: bridge initialization threw — ${msg}`);
    return false;
  }
}

/**
 * 销毁 bridge
 */
export function disposeContextWindowHookBridge(): boolean {
  installNoopImplementations();
  hookActive = false;
  return _disposeHook();
}

installNoopImplementations();
