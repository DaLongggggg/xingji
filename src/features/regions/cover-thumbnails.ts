/**
 * 地图封面缩略图（按需生成，可丢弃展示副本）。
 *
 * - 原始照片字节不动（原图下载继续用原件）；
 * - 缩略图只是降采样的展示副本，可随时重建，不作为第二事实来源；
 * - 只为**各地区实际封面候选**按选择顺序逐个生成（成功即止），
 *   不解码筛选范围内的全部照片；
 * - 缓存最多 100 项：命中本轮在用的封面时「摸新」并钉住；满且全被
 *   钉住时新图直接展示、不留缓存，缓存淘汰不代表照片不可读；
 * - 透明像素保留 alpha（PNG 编码），不透明照片仍用 JPEG 控制体积。
 */

const THUMBNAIL_MAX_DIM = 200;
const THUMBNAIL_CACHE_LIMIT = 100;

export type CoverThumbnailCache = Map<string, string>;

/** 一个地区（分组）的封面候选链，顺序与 selectRegionCover 的选择顺序一致。 */
export type CoverThumbnailNeed = {
  key: string;
  candidateIds: string[];
};

type ThumbnailGenerator = (blob: Blob) => Promise<string | null>;

/** 生成单张缩略图 dataURL（异步）。失败返回 null（降级为文字卡）。 */
export async function generateCoverThumbnail(blob: Blob): Promise<string | null> {
  try {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    /** 部分 Android WebView 的 createImageBitmap(Blob) 解不出图（同样的字节
     * <img> 能解码）：退回 <img> 等价管线。资源建立、回退解码与绘制统一纳入
     * 同一清理范围：无论哪一步失败，每个实际创建的 objectURL 恰好释放一次、
     * 成功创建的 bitmap 恰好关闭一次；两者都失败仍按单张坏图降级。 */
    let source: ImageBitmap | HTMLImageElement | null = null;
    let objectUrl: string | null = null;
    try {
      try {
        source = await createImageBitmap(blob);
      } catch {
        objectUrl = URL.createObjectURL(blob);
        const image = new Image();
        image.src = objectUrl;
        await image.decode();
        source = image;
      }
      const scale = Math.min(1, THUMBNAIL_MAX_DIM / Math.max(source.width, source.height));
      canvas.width = Math.max(1, Math.round(source.width * scale));
      canvas.height = Math.max(1, Math.round(source.height * scale));
      ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    } finally {
      if (source && typeof (source as ImageBitmap).close === "function") (source as ImageBitmap).close();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
    // JPEG 没有透明通道：有透明像素时改用 PNG，避免透明角落变黑底。
    return hasTransparentPixels(ctx, canvas.width, canvas.height)
      ? canvas.toDataURL("image/png")
      : canvas.toDataURL("image/jpeg", 0.82);
  } catch {
    return null;
  }
}

function hasTransparentPixels(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number
): boolean {
  try {
    const data = ctx.getImageData(0, 0, width, height).data;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 255) return true;
    }
  } catch {
    // 画布被跨域内容污染等读像素失败：按不透明处理（退回 JPEG）。
  }
  return false;
}

/**
 * 有界缓存：超限时淘汰最早的**未钉住**条目（pinned = 本轮在用的封面）。
 * 全部条目都被钉住时不再写缓存：调用方仍展示本次生成的图，避免把
 * 「不留缓存」误当成「照片不可读」，同时保持缓存上限。
 */
export function putThumbnail(
  cache: CoverThumbnailCache,
  mediaId: string,
  dataUrl: string | null,
  pinned?: ReadonlySet<string>
): void {
  if (dataUrl === null) return;
  cache.delete(mediaId);
  if (cache.size >= THUMBNAIL_CACHE_LIMIT) {
    for (const key of cache.keys()) {
      if (!pinned?.has(key)) {
        cache.delete(key);
        break;
      }
    }
    if (cache.size >= THUMBNAIL_CACHE_LIMIT) return;
  }
  cache.set(mediaId, dataUrl);
}

/** 展示 URL 只保留当前各地区选择的首张可用封面，不累积历史照片。 */
export function selectNeededThumbnailUrls(
  needs: CoverThumbnailNeed[],
  urls: Record<string, string>
): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const need of needs) {
    const id = need.candidateIds.find((candidate) => Boolean(urls[candidate]));
    if (id) selected[id] = urls[id];
  }
  return selected;
}

/**
 * 按各地区的候选顺序逐个尝试封面缩略图：命中缓存或生成成功即止
 * （与 selectRegionCover 的「第一个可读」语义一致）。命中的条目摸新到
 * 最新位置并钉住；缓存命中与生成成功都立即上报（不等整批）。
 * 过期任务在解码前后停止，不向共享缓存或展示提交结果。
 */
export async function ensureCoverThumbnails(
  needs: CoverThumbnailNeed[],
  blobById: Map<string, Blob>,
  cache: CoverThumbnailCache,
  options?: {
    /** 测试注入替身；缺省用真实解码。 */
    generate?: ThumbnailGenerator;
    isCancelled?: () => boolean;
    onThumbnail?: (mediaId: string, dataUrl: string) => void;
  }
): Promise<void> {
  const generate = options?.generate ?? generateCoverThumbnail;
  const pinned = new Set<string>();
  for (const need of needs) {
    for (const mediaId of need.candidateIds) {
      if (options?.isCancelled?.()) return;
      const cached = cache.get(mediaId);
      if (cached !== undefined) {
        // 摸新：在用的封面移到最新位置，不会被后续插入淘汰。
        cache.delete(mediaId);
        cache.set(mediaId, cached);
        pinned.add(mediaId);
        options?.onThumbnail?.(mediaId, cached);
        break;
      }
      const blob = blobById.get(mediaId);
      if (!blob) continue; // 媒体缺失：尝试下一个候选。
      const dataUrl = await generate(blob);
      if (options?.isCancelled?.()) return;
      if (dataUrl === null) continue; // 不可读：退到下一个候选。
      putThumbnail(cache, mediaId, dataUrl, pinned);
      pinned.add(mediaId);
      options?.onThumbnail?.(mediaId, dataUrl);
      break;
    }
  }
}
