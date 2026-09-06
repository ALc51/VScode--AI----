/** 把上游 modelId 渲染成中文展示名 */
const VENDOR_PREFIXES: Array<[RegExp, string]> = [
  [/^Deepseek(?=[-_\s]|\d|$)/, "DeepSeek"],
  [/^Qwen(?=[-_\s]|\d|$)/, "通义千问 Qwen"],
  [/^Glm(?=[-_\s]|\d|$)/, "智谱 GLM"],
  [/^Mimo(?=[-_\s]|\d|$)/, "MiMo"],
  [/^Kimi(?=[-_\s]|\d|$)/, "Kimi"],
];

export const defaultFormatModelDisplayName = (modelId: string, reportedName?: string): string => {
  const normalized = modelId.toLowerCase();
  if (reportedName && reportedName.toLowerCase() !== normalized) {
    return reportedName;
  }
  const formatted = modelId
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  return (
    VENDOR_PREFIXES.reduce(
      (acc, [pattern, replacement]) => acc.replace(pattern, replacement),
      formatted
    ) || modelId
  );
};
