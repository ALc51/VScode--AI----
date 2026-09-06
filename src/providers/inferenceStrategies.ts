/** 各厂商的 modelId → 默认输入/输出 token 推断策略 */
export const defaultInferContextTokens = (modelId: string): number => {
  const normalized = modelId.toLowerCase();
  if (/kimi-k3/.test(normalized)) return 1_048_576;
  if (/kimi-k2\.([67])|mimo/.test(normalized)) return 262_144;
  return 128_000;
};

export const defaultInferOutputTokens = (modelId: string): number => {
  if (/kimi-k3/.test(modelId.toLowerCase())) return 131_072;
  return 16_384;
};

/** 能力回退正则——当上游未声明能力时使用 */
const IMAGE_INPUT_HINTS = /kimi-k3|kimi-k2\.6|kimi-k2\.7/;
const TOOL_CALLING_HINTS = /kimi-k3|kimi-k2\.6|kimi-k2\.7|glm|qwen|deepseek|mimo-v2\.5/;
const REASONING_HINTS = /reason|thinking|kimi-k3|kimi-k2\.6|kimi-k2\.7/;

export const defaultHasInferredImageInput = (modelId: string) =>
  IMAGE_INPUT_HINTS.test(modelId.toLowerCase());

export const defaultHasInferredToolCalling = (modelId: string) =>
  TOOL_CALLING_HINTS.test(modelId.toLowerCase());

export const defaultHasInferredReasoning = (modelId: string) =>
  REASONING_HINTS.test(modelId.toLowerCase());
