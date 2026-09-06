export interface OfficialModelMetadata {
  contextTokens?: number;
  imageInput?: boolean;
  toolCalling?: boolean;
  reasoning?: boolean;
}

export function getOfficialModelMetadata(
  vendor: string,
  modelId: string
): OfficialModelMetadata | undefined {
  if (vendor === "xiaomi") {
    if (/^mimo-v2\.5(?:-pro)?$/.test(modelId)) {
      return { contextTokens: 1_048_576, imageInput: modelId === "mimo-v2.5", toolCalling: true, reasoning: true };
    }
    if (/^mimo-v2\.5-(?:asr|tts(?:-.+)?)$/.test(modelId)) {
      return { contextTokens: 8_192, imageInput: false, toolCalling: false, reasoning: false };
    }
  }

  if (vendor === "kimi") {
    if (modelId === "kimi-k3") {
      return { contextTokens: 1_048_576, imageInput: true, toolCalling: true, reasoning: true };
    }
    if (/^kimi-k2\.6$|^kimi-k2\.7-code(?:-highspeed)?$/.test(modelId)) {
      return { contextTokens: 262_144, imageInput: true, toolCalling: true, reasoning: true };
    }
  }

  if (vendor === "deepseek" && /^deepseek-v4-(?:flash|pro|flash-vision-exp)/.test(modelId)) {
    return {
      contextTokens: 1_048_576,
      imageInput: modelId.includes("vision"),
      toolCalling: true,
      reasoning: true,
    };
  }

  if (vendor === "qwen") {
    if (/^qwen-(?:plus|flash)(?:-|$)|^qwen3\.(?:7-plus|7-flash|8-(?:max|flash))/.test(modelId)) {
      return {
        contextTokens: 1_048_576,
        imageInput: /^qwen3\.(?:7-plus|8-max)/.test(modelId),
        toolCalling: true,
        reasoning: true,
      };
    }
    if (/^qwen-long/.test(modelId)) {
      return { contextTokens: 10_485_760, imageInput: false, toolCalling: false, reasoning: false };
    }
    if (/^qwen-max/.test(modelId)) {
      return { contextTokens: 32_768, imageInput: false, toolCalling: true, reasoning: true };
    }
  }

  if (vendor === "zhipu") {
    if (/^glm-5\.(?:2|3)$/.test(modelId) || modelId === "glm-5.3-flash") {
      return {
        contextTokens: 1_048_576,
        imageInput: modelId === "glm-5.3-flash",
        toolCalling: true,
        reasoning: true,
      };
    }
    if (/^glm-5(?:\.1|-turbo)?$|^glm-4\.7(?:-flashx)?$|^glm-4\.6$/.test(modelId)) {
      return { contextTokens: 204_800, imageInput: false, toolCalling: true, reasoning: true };
    }
    if (/^glm-4\.5(?:-airx?)?$|^glm-4\.5-air$/.test(modelId)) {
      return { contextTokens: 131_072, imageInput: false, toolCalling: true, reasoning: true };
    }
    if (modelId === "glm-4-long") {
      return { contextTokens: 1_048_576, imageInput: false, toolCalling: false, reasoning: false };
    }
    if (/^glm-5v-turbo$/.test(modelId)) {
      return { contextTokens: 204_800, imageInput: true, toolCalling: true, reasoning: true };
    }
    if (/^glm-4\.6v/.test(modelId)) {
      return { contextTokens: 131_072, imageInput: true, toolCalling: true, reasoning: true };
    }
  }

  return undefined;
}
