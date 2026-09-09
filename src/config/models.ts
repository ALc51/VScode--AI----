/** API 基础地址 */
export const API_BASE_URLS: Record<string, string> = {
  deepseek: "https://api.deepseek.com",
  qwen: "https://dashscope.aliyuncs.com/compatible-mode",
  zhipu: "https://open.bigmodel.cn/api/paas",
  kimi: "https://api.moonshot.cn",
  xiaomi: "https://api.xiaomimimo.com",
};

/** 各厂商已知聊天模型 ID（用量面板下拉筛选兜底：模型列表缓存未加载时使用） */
export const KNOWN_CHAT_MODELS: Record<string, string[]> = {
  deepseek: ["deepseek-chat", "deepseek-reasoner", "deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-flash-vision-exp"],
  qwen: ["qwen-plus", "qwen-flash", "qwen-long", "qwq-plus", "qwen3.7-plus", "qwen3.7-flash", "qwen3.8-max", "qwen3.8-flash"],
  zhipu: ["glm-4-plus", "glm-4-flash", "glm-4-long", "glm-4-air", "glm-z1-air", "glm-z1-airx"],
  kimi: ["kimi-k3", "kimi-k2.6", "kimi-k2.7-code", "kimi-k2.7-code-highspeed"],
  xiaomi: ["mimo-v2.5", "mimo-v2.5-pro"],
};
