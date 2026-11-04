/**
 * 地区记忆封面选择（记忆地图 M1）。
 *
 * 纯函数：从地区已排序的关联篇里挑一张**展示封面**。语义边界：
 * - 封面是「关联笔记封面」：图片没有逐图地区信息，不能声称照片就在该地区拍摄；
 * - 封面锚点只用于展示，不是拍摄坐标，也不写回任何用户数据；
 * - 没有可用图片时降级为文字卡（篇标题），不使用网络图占位。
 */

export type RegionCoverCandidate = {
  pageId: string;
  title: string;
  /** 该篇 photo 块引用的媒体 ID（按正文顺序）。 */
  photoMediaIds: string[];
};

export type RegionCover = {
  /** photo：找到可用图片；text：无图文字卡（仍指向一篇真实记录）。 */
  kind: "photo" | "text";
  /** 封面来源篇：文字卡用它打开原笔记。 */
  pageId: string;
  /** 篇标题（文字卡直接显示）。 */
  title: string;
  /** 本地 dataURL；文字卡为 null。空字符串视为媒体不可用。 */
  coverUrl: string | null;
};

/**
 * 封面选择顺序：按调用方给定的稳定篇序（聚合层已按 capturedAt 倒序），
 * 取第一篇里**第一个可读**的图片；全部不可读则退回第一篇做文字卡。
 * 篇序稳定 → 封面稳定，不随机换封面。
 */
export function selectRegionCover(
  candidates: RegionCoverCandidate[],
  mediaUrls: Record<string, string>
): RegionCover | null {
  const first = candidates[0];
  if (!first) return null;
  for (const candidate of candidates) {
    for (const mediaId of candidate.photoMediaIds) {
      const url = mediaUrls[mediaId];
      if (url) {
        return { kind: "photo", pageId: candidate.pageId, title: candidate.title, coverUrl: url };
      }
    }
  }
  return { kind: "text", pageId: first.pageId, title: first.title, coverUrl: null };
}
