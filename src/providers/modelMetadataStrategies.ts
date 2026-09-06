import { getOfficialModelMetadata as lookupOfficial } from "../config/modelMetadata";
import type { OfficialModelMetadata } from "../config/modelMetadata";

/** 通用兜底：按当前 vendor 调用集中元数据表 */
export const defaultGetModelMetadata = (vendor: string) =>
  (modelId: string): OfficialModelMetadata | undefined => lookupOfficial(vendor, modelId);

/** 默认的 vendor 上下文上限策略（与重构前等价） */
export const defaultGetVendorContextLimit = (modelId: string): number | undefined => {
  const normalizedId = modelId.toLowerCase();
  if (/mimo-v2\.5/.test(normalizedId)) return 262_144;
  if (/kimi-k3/.test(normalizedId)) return 1_048_576;
  if (/kimi-k2/.test(normalizedId)) return 262_144;
  return undefined;
};
