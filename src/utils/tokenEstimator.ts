/**
 * 简易 Token 估算器
 * CJK 字符约 1.5 字/token，英文/其他约 4 字符/token
 * 对齐 opencode: char/4 + 10% codeBuffer + CJK 补偿
 */
function isCjkChar(code: number): boolean {
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x20000 && code <= 0x2a6df) ||
    (code >= 0x2a700 && code <= 0x2ebef) ||
    (code >= 0x2ebf0 && code <= 0x2ee5d) ||
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0xac00 && code <= 0xd7af)
  );
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return 0;
  const cjk = normalized.match(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/gu)?.length ?? 0;
  const charEstimate = Math.ceil(normalized.length / 4);
  const codeBuffer = Math.ceil(charEstimate * 0.1);
  return Math.max(1, Math.ceil(charEstimate + codeBuffer + cjk));
}

// 对齐 opencode 的开销常量
export const MESSAGE_TOKEN_OVERHEAD = 4;
export const MESSAGE_NAME_TOKEN_OVERHEAD = 1;
export const TOOL_CALL_TOKEN_OVERHEAD = 10;
export const TOOL_RESULT_TOKEN_OVERHEAD = 6;
export const IMAGE_TOKEN_ESTIMATE = 1024;

export function estimateStructuredTokenCount(value: unknown): number {
  try { return estimateTokens(JSON.stringify(value)); } catch { return 0; }
}