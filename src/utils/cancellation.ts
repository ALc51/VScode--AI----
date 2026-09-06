import type { CancellationToken } from "vscode";

/**
 * 把 VS Code 的 CancellationToken 桥接到 fetch 的 AbortSignal。
 * 当 token 被取消或 timeout 到期时，生成的 signal 都会 abort。
 */
export function createAbortSignal(token: CancellationToken, timeoutMs: number): AbortSignal {
  const controller = new AbortController();
  let timedOut = false;

  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("TimeoutError"));
  }, timeoutMs);

  const disposable = token.onCancellationRequested(() => {
    controller.abort(new Error("Cancelled"));
  });

  controller.signal.addEventListener("abort", () => {
    clearTimeout(timeoutId);
    disposable.dispose();
  });

  void timedOut;
  return controller.signal;
}

/**
 * sleep 一段 ms，但会被 cancellation token 提前打断。
 */
export async function cancellableSleep(token: CancellationToken, ms: number): Promise<void> {
  if (token.isCancellationRequested) {
    throw new Error("Cancelled");
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const disposable = token.onCancellationRequested(() => {
      clearTimeout(timer);
      disposable.dispose();
      reject(new Error("Cancelled"));
    });
  });
}
