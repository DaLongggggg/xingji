/** 兼容既有照片定位 API；格式与标签解析统一由 readPhotoInfo 负责。 */
import { readPhotoInfo, type PhotoGps } from "@/features/photos/photo-info";

export type PhotoGpsCoordinate = PhotoGps;

/** 归一化基准声明：大写并去掉空格/连字符（"WGS-84" / "WGS84" 等价）。 */
export function normalizeGpsDatum(datum: string | null): string | null {
  if (!datum) return null;
  const normalized = datum.toUpperCase().replace(/[\s-]+/g, "");
  return normalized || null;
}

/**
 * 是否为可匹配的基准：未声明（工程假定 WGS-84，非已核实）或 WGS-84 变体。
 * 其他声明（CIPA 允许的 TOKYO 等）返回 false——调用方跳过匹配并说明，
 * 不得按 WGS-84 转换（M1.5 复审 P2）。
 */
export function isSupportedGpsDatum(datum: string | null): boolean {
  const normalized = normalizeGpsDatum(datum);
  return normalized === null || normalized === "WGS84";
}

export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

/** 缺失/解析失败返回 null；读完整来源以覆盖 PNG/WebP/HEIC 的元数据位置。 */
export async function extractGpsCoordinates(input: Blob | Uint8Array | ArrayBuffer): Promise<PhotoGpsCoordinate | null> {
  return (await readPhotoInfo(input)).gps;
}
