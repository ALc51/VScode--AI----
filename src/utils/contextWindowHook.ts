/**
 * Context Window Hook — 猴子补丁注入 usage 到 VS Code 原生 ChatContextUsageWidget
 *
 * 原理：捕获 Copilot Chat 内部的 $handleProgressChunk 代理，在流式响应结束时
 * 注入 { kind:"usage", promptTokens, completionTokens } chunk，
 * 使原生上下文窗口 Widget 显示正确的 token 使用量。
 *
 * 参考：ltmoerdani/opencode-copilot-chat/src/contextWindowHook.ts
 */
import { AsyncLocalStorage } from "node:async_hooks";
import * as vscode from "vscode";

type HandleProgressChunkFn = (requestId: string, chunks: unknown[]) => Promise<void>;
type SetAddFn = typeof Set.prototype.add;
type SetDeleteFn = typeof Set.prototype.delete;

interface CapturedProxy {
  proxyTarget: Record<string, unknown>;
  originalHandleProgressChunk: HandleProgressChunkFn;
}

interface ContextWindowUsage {
  promptTokens: number;
  completionTokens: number;
  outputBuffer?: number;
}

// ── 内部状态 ──
let originalHandleProgressChunk: HandleProgressChunkFn | null = null;
let patchedHandleProgressChunk: HandleProgressChunkFn | null = null;
let proxyTarget: Record<string, unknown> | null = null;
let originalSetAdd: SetAddFn | null = null;
let originalSetDelete: SetDeleteFn | null = null;
let patchedSetAdd: SetAddFn | null = null;
let patchedSetDelete: SetDeleteFn | null = null;
let requestTrackingInstalled = false;
let hookInstalled = false;
let initializationGeneration = 0;

const inFlightRequestIds = new Map<string, true>();
const localToVsCodeRequestIds = new Map<string, string>();
const vsCodeToLocalRequestIds = new Map<string, string>();
const pendingUsage = new Map<string, ContextWindowUsage>();
const pendingUsageByLocalRequestId = new Map<string, ContextWindowUsage>();
const outputBuffersByLocalRequestId = new Map<string, number>();
const requestContextStorage = new AsyncLocalStorage<string>();
const queuedProgressLocalRequestIds: string[] = [];
const queuedProgressLocalRequestIdsSet = new Set<string>();

const CONTEXT_HOOK_PROBE_DELAY_MS = 150;

// ── 诊断日志（启动后可查看 Output Channel 或 console） ──
let _log: ((msg: string) => void) | undefined;
function diag(msg: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] [contextWindowHook] ${msg}`;
  console.log(line);
  _log?.(line);
}
export function setDiagLogger(log?: (msg: string) => void): void { _log = log; }

// ── 辅助函数 ──

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createUsageChunk(usage: ContextWindowUsage): {
  kind: "usage";
  promptTokens: number;
  completionTokens: number;
  outputBuffer?: number;
} {
  return {
    kind: "usage",
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    ...(usage.outputBuffer === undefined ? {} : { outputBuffer: usage.outputBuffer }),
  };
}

function queueProgressBinding(localRequestId: string): void {
  if (localToVsCodeRequestIds.has(localRequestId) || queuedProgressLocalRequestIdsSet.has(localRequestId)) {
    return;
  }
  queuedProgressLocalRequestIds.push(localRequestId);
  queuedProgressLocalRequestIdsSet.add(localRequestId);
}

function discardQueuedProgressBinding(localRequestId: string): void {
  queuedProgressLocalRequestIdsSet.delete(localRequestId);
}

function takeQueuedProgressBinding(): string | undefined {
  while (queuedProgressLocalRequestIds.length > 0) {
    const localRequestId = queuedProgressLocalRequestIds.shift();
    if (!localRequestId) continue;
    if (!queuedProgressLocalRequestIdsSet.delete(localRequestId)) continue;
    if (!localToVsCodeRequestIds.has(localRequestId)) return localRequestId;
  }
  return undefined;
}

function injectUsageChunk(requestId: string, usage: ContextWindowUsage): void {
  if (!proxyTarget || !originalHandleProgressChunk) {
    diag(`injectUsageChunk: SKIP (no proxyTarget) requestId=${requestId} prompt=${usage.promptTokens} completion=${usage.completionTokens}`);
    return;
  }
  diag(`injectUsageChunk: INJECT requestId=${requestId} prompt=${usage.promptTokens} completion=${usage.completionTokens} outputBuffer=${usage.outputBuffer ?? 0}`);
  void originalHandleProgressChunk
    .call(proxyTarget, requestId, [createUsageChunk(usage)])
    .catch((e) => diag(`injectUsageChunk: ERROR ${e}`));
}

function bindLocalRequestToVsCodeRequest(localRequestId: string, requestId: string): void {
  discardQueuedProgressBinding(localRequestId);

  const previousRequestId = localToVsCodeRequestIds.get(localRequestId);
  if (previousRequestId && previousRequestId !== requestId) {
    vsCodeToLocalRequestIds.delete(previousRequestId);
    pendingUsage.delete(previousRequestId);
  }

  const previousLocalRequestId = vsCodeToLocalRequestIds.get(requestId);
  if (previousLocalRequestId && previousLocalRequestId !== localRequestId) {
    localToVsCodeRequestIds.delete(previousLocalRequestId);
    pendingUsageByLocalRequestId.delete(previousLocalRequestId);
    outputBuffersByLocalRequestId.delete(previousLocalRequestId);
  }

  localToVsCodeRequestIds.set(localRequestId, requestId);
  vsCodeToLocalRequestIds.set(requestId, localRequestId);
  diag(`bindLocalRequest: local=${localRequestId} -> vscode=${requestId} pendingUsage=${pendingUsageByLocalRequestId.has(localRequestId)}`);

  // 绑定建立后立即注入待处理的 usage（如果有的话）
  const pendingLocalUsage = pendingUsageByLocalRequestId.get(localRequestId);
  if (pendingLocalUsage) {
    const usageWithOutputBuffer = withOutputBuffer(localRequestId, pendingLocalUsage);
    pendingUsage.set(requestId, usageWithOutputBuffer);
    pendingUsageByLocalRequestId.delete(localRequestId);
    injectUsageChunk(requestId, usageWithOutputBuffer);
  }
}

function cleanupVsCodeRequest(requestId: string): void {
  inFlightRequestIds.delete(requestId);
  pendingUsage.delete(requestId);

  const localRequestId = vsCodeToLocalRequestIds.get(requestId);
  if (!localRequestId) return;

  vsCodeToLocalRequestIds.delete(requestId);
  const mappedRequestId = localToVsCodeRequestIds.get(localRequestId);
  if (mappedRequestId === requestId) {
    localToVsCodeRequestIds.delete(localRequestId);
  }
  outputBuffersByLocalRequestId.delete(localRequestId);
}

// ── 代理捕获 ──

async function captureProxy(logDiagnostic?: (message: string) => void): Promise<CapturedProxy | null> {
  // 必须在补丁前捕获原始方法引用，避免无限递归
  const realOriginalMapSet = Map.prototype.set;
  const probeId = `_china_ai_probe_${String(Date.now())}`;
  const captureState: {
    found: boolean;
    proxyTarget: Record<string, unknown> | null;
    handleProgressChunk: HandleProgressChunkFn | null;
  } = { found: false, proxyTarget: null, handleProgressChunk: null };

  Map.prototype.set = function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
    if (!captureState.found && isRecord(value)) {
      const candidate = isRecord((value as Record<string, unknown>)._proxy)
        ? ((value as Record<string, unknown>)._proxy as Record<string, unknown>)
        : undefined;
      const hpc = candidate?.$handleProgressChunk;
      if (
        candidate &&
        typeof hpc === "function" &&
        ((value as Record<string, unknown>).id === probeId ||
          (value as Record<string, unknown>).label === probeId ||
          (value as Record<string, unknown>).name === probeId)
      ) {
        captureState.proxyTarget = candidate;
        captureState.handleProgressChunk = hpc as HandleProgressChunkFn;
        captureState.found = true;
      }
    }
    return realOriginalMapSet.call(this, key, value);
  } as typeof Map.prototype.set;

  let participant: vscode.Disposable | undefined;
  try {
    diag(`captureProxy: creating probe participant '${probeId}'...`);
    participant = vscode.chat.createChatParticipant(probeId, () => undefined);
    diag(`captureProxy: participant created, waiting ${CONTEXT_HOOK_PROBE_DELAY_MS}ms for Map.set...`);
    await new Promise((resolve) => setTimeout(resolve, CONTEXT_HOOK_PROBE_DELAY_MS));
  } catch (e) {
    diag(`captureProxy: createChatParticipant FAILED: ${e}`);
  } finally {
    participant?.dispose();
    Map.prototype.set = realOriginalMapSet;
  }

  diag(`captureProxy: result found=${captureState.found} proxyTarget=${!!captureState.proxyTarget} hpc=${typeof captureState.handleProgressChunk}`);

  if (!captureState.found || !captureState.proxyTarget || !captureState.handleProgressChunk) {
    diag("captureProxy: FAILED — Copilot Chat internals may have changed");
    return null;
  }

  return {
    proxyTarget: captureState.proxyTarget,
    originalHandleProgressChunk: captureState.handleProgressChunk,
  };
}

// ── 代理补丁 ──

function patchProxy(captured: CapturedProxy): void {
  if (hookInstalled) return;

  const target = captured.proxyTarget;
  const original = captured.originalHandleProgressChunk;
  const patched: HandleProgressChunkFn = function (requestId: string, chunks: unknown[]) {
    const storeId = requestContextStorage.getStore();
    diag(`patchedHPC: vscodeRequestId=${requestId} storeId=${storeId ?? "null"} chunks=${chunks.length}`);
    let localRequestId = storeId;
    if (!localRequestId && !vsCodeToLocalRequestIds.has(requestId)) {
      localRequestId = takeQueuedProgressBinding();
      diag(`patchedHPC: takeQueued -> ${localRequestId ?? "null"}`);
    }
    if (localRequestId) {
      bindLocalRequestToVsCodeRequest(localRequestId, requestId);
    }

    const stored = pendingUsage.get(requestId);
    if (stored) {
      diag(`patchedHPC: found pending usage for ${requestId}, patching chunk`);
      for (const raw of chunks) {
        const chunk = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown> | undefined;
        if (chunk?.kind === "usage") {
          chunk.promptTokens = stored.promptTokens;
          chunk.completionTokens = stored.completionTokens;
          if (stored.outputBuffer !== undefined) {
            chunk.outputBuffer = stored.outputBuffer;
          }
        }
      }
    }

    if (inFlightRequestIds.has(requestId)) {
      cleanupVsCodeRequest(requestId);
    }

    return original.call(target, requestId, chunks);
  };

  proxyTarget = target;
  originalHandleProgressChunk = original;
  patchedHandleProgressChunk = patched;
  (target as { $handleProgressChunk?: HandleProgressChunkFn }).$handleProgressChunk = patched;
  hookInstalled = true;
}

function unpatchProxy(): void {
  if (
    proxyTarget &&
    originalHandleProgressChunk &&
    patchedHandleProgressChunk &&
    (proxyTarget as { $handleProgressChunk?: HandleProgressChunkFn }).$handleProgressChunk === patchedHandleProgressChunk
  ) {
    (proxyTarget as { $handleProgressChunk?: HandleProgressChunkFn }).$handleProgressChunk = originalHandleProgressChunk;
  }
  patchedHandleProgressChunk = null;
  originalHandleProgressChunk = null;
  proxyTarget = null;
  hookInstalled = false;
}

// ── 请求追踪 ──

function installRequestTracking(): void {
  if (requestTrackingInstalled) return;

  // 必须在补丁前捕获原始方法引用，否则 capturedOriginalAdd 调用 Set.prototype.add
  // 会指向补丁后的版本，导致无限递归（Maximum call stack size exceeded）
  const realOriginalAdd = Set.prototype.add;
  const realOriginalDelete = Set.prototype.delete;

  const nextPatchedAdd: SetAddFn = function <T>(this: Set<T>, value: T): Set<T> {
    if (isRecord(value) && typeof (value as Record<string, unknown>).requestId === "string" && "extRequest" in value) {
      inFlightRequestIds.set((value as Record<string, unknown>).requestId as string, true);
    }
    return realOriginalAdd.call(this, value) as Set<T>;
  } as SetAddFn;

  const nextPatchedDelete: SetDeleteFn = function <T>(this: Set<T>, value: T): boolean {
    if (isRecord(value) && typeof (value as Record<string, unknown>).requestId === "string" && "extRequest" in value) {
      cleanupVsCodeRequest((value as Record<string, unknown>).requestId as string);
    }
    return realOriginalDelete.call(this, value);
  } as SetDeleteFn;

  originalSetAdd = realOriginalAdd;
  originalSetDelete = realOriginalDelete;
  patchedSetAdd = nextPatchedAdd;
  patchedSetDelete = nextPatchedDelete;
  Set.prototype.add = nextPatchedAdd;
  Set.prototype.delete = nextPatchedDelete;
  requestTrackingInstalled = true;
}

function uninstallRequestTracking(): void {
  if (patchedSetAdd && originalSetAdd && Set.prototype.add === patchedSetAdd) {
    Set.prototype.add = originalSetAdd;
  }
  if (patchedSetDelete && originalSetDelete && Set.prototype.delete === patchedSetDelete) {
    Set.prototype.delete = originalSetDelete;
  }
  patchedSetAdd = null;
  patchedSetDelete = null;
  originalSetAdd = null;
  originalSetDelete = null;
  requestTrackingInstalled = false;
}

function normalizeUsage(usage: { promptTokens?: number; completionTokens?: number }): ContextWindowUsage | null {
  const promptTokens = usage.promptTokens ?? 0;
  const completionTokens = usage.completionTokens ?? 0;
  if (promptTokens === 0 && completionTokens === 0) return null;
  return { promptTokens, completionTokens };
}

function withOutputBuffer(localRequestId: string, usage: ContextWindowUsage): ContextWindowUsage {
  const outputBuffer = outputBuffersByLocalRequestId.get(localRequestId);
  return outputBuffer === undefined ? usage : { ...usage, outputBuffer };
}

// ── 公开 API ──

/**
 * 报告 usage 到 VS Code 原生 Context Window Widget
 * @returns true 如果成功注入，false 如果 hook 不可用
 */
export function reportUsageToContextWindow(
  localRequestId: string,
  usage: { promptTokens?: number; completionTokens?: number },
): boolean {
  const normalized = normalizeUsage(usage);
  if (!normalized) {
    diag(`reportUsageToContextWindow: SKIP (zero usage) local=${localRequestId}`);
    return false;
  }
  if (!proxyTarget || !originalHandleProgressChunk) {
    diag(`reportUsageToContextWindow: SKIP (hook not active) local=${localRequestId} prompt=${normalized.promptTokens} completion=${normalized.completionTokens}`);
    return false;
  }

  const usageWithOutputBuffer = withOutputBuffer(localRequestId, normalized);
  const requestId = localToVsCodeRequestIds.get(localRequestId);
  if (!requestId) {
    diag(`reportUsageToContextWindow: DEFER (no vscode binding) local=${localRequestId} prompt=${normalized.promptTokens} completion=${normalized.completionTokens}`);
    pendingUsageByLocalRequestId.set(localRequestId, usageWithOutputBuffer);
    return false;
  }

  diag(`reportUsageToContextWindow: INJECT local=${localRequestId} vscode=${requestId} prompt=${normalized.promptTokens} completion=${normalized.completionTokens}`);
  pendingUsage.set(requestId, usageWithOutputBuffer);
  injectUsageChunk(requestId, usageWithOutputBuffer);
  return true;
}

/**
 * 将 progress.report 包装为带请求 ID 追踪的版本
 */
export function reportProgressWithRequest(
  localRequestId: string,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  part: vscode.LanguageModelResponsePart,
): void {
  queueProgressBinding(localRequestId);
  withContextWindowRequest(localRequestId, () => {
    progress.report(part);
  });
  // progress.report 后可能触发 patchedHandleProgressChunk 完成绑定
  // 如果此时已有待注入的 usage，尝试注入
  const pendingLocalUsage = pendingUsageByLocalRequestId.get(localRequestId);
  if (pendingLocalUsage) {
    const requestId = localToVsCodeRequestIds.get(localRequestId);
    if (requestId) {
      const usageWithOutputBuffer = withOutputBuffer(localRequestId, pendingLocalUsage);
      pendingUsage.set(requestId, usageWithOutputBuffer);
      pendingUsageByLocalRequestId.delete(localRequestId);
      injectUsageChunk(requestId, usageWithOutputBuffer);
    }
  }
}

/**
 * 设置输出缓冲区大小
 */
export function setOutputBufferForRequest(localRequestId: string, outputBuffer: number): void {
  if (!Number.isFinite(outputBuffer) || outputBuffer <= 0) {
    outputBuffersByLocalRequestId.delete(localRequestId);
    return;
  }
  outputBuffersByLocalRequestId.set(localRequestId, Math.floor(outputBuffer));
}

/**
 * 清理请求状态
 */
export function clearContextWindowRequest(localRequestId: string): void {
  discardQueuedProgressBinding(localRequestId);
  pendingUsageByLocalRequestId.delete(localRequestId);
  outputBuffersByLocalRequestId.delete(localRequestId);
}

/**
 * 在请求上下文中执行函数（用于 AsyncLocalStorage 追踪）
 */
export function withContextWindowRequest<T>(localRequestId: string, fn: () => T): T {
  return requestContextStorage.run(localRequestId, fn);
}

/**
 * 生成一个本地请求 ID（用于关联 progress.report 和 usage 报告）
 */
export function generateLocalRequestId(): string {
  return `china_ai_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 初始化 context window hook
 * @returns true 如果成功安装
 */
export async function initializeContextWindowHook(logDiagnostic?: (message: string) => void): Promise<boolean> {
  if (hookInstalled) {
    logDiagnostic?.("contextWindowHook: already installed");
    return true;
  }

  const generation = ++initializationGeneration;
  installRequestTracking();

  // 给 captureProxy 加超时保护，防止 vscode.chat API 挂起
  const CAPTURE_TIMEOUT_MS = 3000;
  let captured: Awaited<ReturnType<typeof captureProxy>> = null;
  try {
    captured = await Promise.race([
      captureProxy(logDiagnostic),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), CAPTURE_TIMEOUT_MS)),
    ]);
  } catch (err) {
    logDiagnostic?.(`contextWindowHook: captureProxy threw — ${err instanceof Error ? err.message : String(err)}`);
    captured = null;
  }

  if (generation !== initializationGeneration) {
    logDiagnostic?.("contextWindowHook: initialization aborted (generation mismatch)");
    return false;
  }

  if (!captured) {
    uninstallRequestTracking();
    cleanup();
    return false;
  }

  patchProxy(captured);
  logDiagnostic?.("contextWindowHook: proxy captured and patched successfully");
  return true;
}

/**
 * 销毁 hook，恢复所有猴子补丁
 */
export function disposeContextWindowHook(): boolean {
  const hadState =
    hookInstalled ||
    requestTrackingInstalled ||
    inFlightRequestIds.size > 0 ||
    pendingUsage.size > 0;

  initializationGeneration += 1;
  unpatchProxy();
  uninstallRequestTracking();
  cleanup();

  return hadState;
}

function cleanup(): void {
  inFlightRequestIds.clear();
  pendingUsage.clear();
  pendingUsageByLocalRequestId.clear();
  outputBuffersByLocalRequestId.clear();
  localToVsCodeRequestIds.clear();
  vsCodeToLocalRequestIds.clear();
  queuedProgressLocalRequestIds.length = 0;
  queuedProgressLocalRequestIdsSet.clear();
}
