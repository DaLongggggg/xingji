import type { Province } from "@/server/shared/types";

/**
 * 从省级数组中等概率选取一项。
 *
 * randomValue 必须位于 [0, 1)，作为参数传入以便使用固定序列测试公平映射。
 */
export function pickProvince(provinces: Province[], randomValue = Math.random()): Province {
  if (provinces.length === 0) {
    throw new Error("PROVINCE_LIST_EMPTY");
  }
  if (randomValue < 0 || randomValue >= 1) {
    throw new Error("RANDOM_VALUE_OUT_OF_RANGE");
  }
  return provinces[Math.floor(randomValue * provinces.length)];
}
