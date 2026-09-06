/**
 * 简易 Token 估算器
 * CJK 字符约 1.5 字/token，英文/其他约 4 字符/token
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
  let count = 0;
  for (const char of text) {
    count += isCjkChar(char.codePointAt(0) ?? 0) ? 0.7 : 0.25;
  }
  return Math.max(1, Math.ceil(count));
}