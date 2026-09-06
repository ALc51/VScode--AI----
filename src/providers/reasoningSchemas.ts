/**
 * 集中存放各厂商 reasoning configuration schema
 * - reasoning === false → 返回 undefined（schema 整体不出现）
 * - 模型不支持 reasoning 调整（kimi k2.7-code）→ 返回 undefined
 */

type SchemaBuilder = (modelId: string) => Record<string, unknown> | undefined;

export const qwenReasoningSchema: SchemaBuilder = () => ({
  properties: {
    reasoningEffort: {
      type: "string",
      title: "Thinking Effort",
      enum: ["off", "auto", "on"],
      enumItemLabels: ["Off", "Auto", "On"],
      enumDescriptions: ["Disable thinking", "Let Qwen decide", "Enable thinking"],
      default: "on",
      group: "navigation",
    },
  },
});

export const zhipuReasoningSchema: SchemaBuilder = (modelId: string) => {
  const normalizedId = modelId.toLowerCase();
  const alwaysThinking = /^glm-5[.-](?:[3-9]|\d{2,})/.test(normalizedId);
  return {
    properties: {
      reasoningEffort: {
        type: "string",
        title: "Thinking Effort",
        enum: alwaysThinking ? ["high", "max"] : ["off", "high", "max"],
        enumItemLabels: alwaysThinking ? ["High", "Max"] : ["Off", "High", "Max"],
        enumDescriptions: alwaysThinking
          ? ["Greater reasoning depth", "Maximum reasoning effort"]
          : ["Fastest responses", "Greater reasoning depth", "Maximum reasoning effort"],
        default: "max",
        group: "navigation",
      },
    },
  };
};

export const kimiReasoningSchema: SchemaBuilder = (modelId: string) => {
  if (/k2\.7-code/.test(modelId.toLowerCase())) {
    return undefined;
  }
  return {
    properties: {
      reasoningEffort: {
        type: "string",
        title: "Thinking Effort",
        enum: ["off", "on"],
        enumItemLabels: ["Off", "On"],
        enumDescriptions: ["Disable thinking", "Enable thinking"],
        default: "on",
        group: "navigation",
      },
    },
  };
};

export const deepseekReasoningSchema: SchemaBuilder = () => ({
  properties: {
    reasoningEffort: {
      type: "string",
      title: "Thinking Effort",
      enum: ["off", "low", "medium", "high", "max"],
      enumItemLabels: ["Off", "Low", "Medium", "High", "Max"],
      enumDescriptions: [
        "Fastest responses",
        "Minimal reasoning",
        "Balanced reasoning",
        "More reasoning",
        "Maximum reasoning effort",
      ],
      default: "max",
      group: "navigation",
    },
  },
});

export const xiaomiReasoningSchema: SchemaBuilder = () => ({
  properties: {
    reasoningEffort: {
      type: "string",
      title: "Thinking Effort",
      enum: ["low", "medium", "high"],
      enumItemLabels: ["Low", "Medium", "High"],
      enumDescriptions: [
        "Faster responses with less reasoning",
        "Balanced reasoning and speed",
        "Greater reasoning depth but slower",
      ],
      default: "high",
      group: "navigation",
    },
  },
});
