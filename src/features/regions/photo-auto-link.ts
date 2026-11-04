/**
 * 照片位置自动关联授权（M1.5 收尾）：默认关闭的明确授权 + 单一规则
 * `photo-gps-auto` 的适用判定。
 *
 * 边界（方案 §10bis + 夜间任务书）：
 * - 授权是**用户在产品中的显式开关**（localStorage，局部偏好授权范围），
 *   默认关闭；关闭即完全无自动追加；
 * - 规则只在触发范围内追加：EXIF 基准受支持（declared/presumed WGS-84）、
 *   **精确命中**（basis=inside，近似命中不自动）、目标地区不在当前关联/草稿
 *   （不覆盖手动选择）；追加目标是**地区草稿**，保存仍走既有「保存地区」；
 * - 无 GPS / 失败 / 近似 / 不支持基准 / 未授权 → 不自动、不阻塞，结果说明
 *   由调用方展示；来源记录 kind="rule"，不冒充逐图人工确认；
 * - 工程风险（文档跟踪）：边界基准为谱系推定（未权威核对），近界照片可能错配，
 *   可通过来源记录撤销。
 */

const STORAGE_KEY = "xingji-photo-auto-link-v1";

export type PhotoAutoLinkPreferences = {
  /** 自动关联总开关（用户显式授权）。 */
  enabled: boolean;
  /** 用户阅读并认可范围说明的时间（授权动作时间，null=从未开启过）。 */
  acceptedAt: string | null;
};

export const PHOTO_AUTO_LINK_DEFAULTS: PhotoAutoLinkPreferences = {
  enabled: false,
  acceptedAt: null
};

/** 授权范围说明（开关处展示；变更措辞时同步更新 e2e 断言）。 */
export const PHOTO_AUTO_LINK_SCOPE_NOTE =
  "开启后，精确命中的地区会自动加入本篇草稿，点击「保存地区」生效。可在关联来源中撤销。";

export function readPhotoAutoLinkPreferences(): PhotoAutoLinkPreferences {
  if (typeof window === "undefined") return { ...PHOTO_AUTO_LINK_DEFAULTS };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...PHOTO_AUTO_LINK_DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<PhotoAutoLinkPreferences>;
    return {
      enabled: parsed.enabled === true,
      acceptedAt: typeof parsed.acceptedAt === "string" ? parsed.acceptedAt : null
    };
  } catch {
    return { ...PHOTO_AUTO_LINK_DEFAULTS };
  }
}

export function writePhotoAutoLinkPreferences(next: PhotoAutoLinkPreferences): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 存不了就只影响本次会话（与地图显示偏好同一策略）。
  }
}

export type AutoLinkCandidate = {
  /** canonical 应用 RegionId。 */
  regionId: string;
  /** 命中方式：只有 inside 参与自动规则。 */
  basis: "inside" | "near";
};

/**
 * 规则适用判定（纯函数）：返回允许自动加入草稿的候选。
 * 输入的 `currentRegionIds` 会被 canonical 化后比较（双 ID 归一）。
 */
export function selectAutoLinkRegions(
  candidates: AutoLinkCandidate[],
  currentRegionIds: string[],
  preferences: PhotoAutoLinkPreferences
): string[] {
  if (!preferences.enabled) return [];
  const current = new Set(currentRegionIds.map((id) => id)); // 调用方已归一
  const out: string[] = [];
  for (const candidate of candidates) {
    if (candidate.basis !== "inside") continue;
    if (current.has(candidate.regionId)) continue;
    if (out.includes(candidate.regionId)) continue;
    out.push(candidate.regionId);
  }
  return out;
}
