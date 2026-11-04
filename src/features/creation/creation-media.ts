/**
 * 素材进口：真实解码校验 + 送视觉模型前的尺寸与元数据边界。
 *
 * 边界（必须有）：
 * - MIME 只是第一道门槛，**实际解码失败一律拒绝**（改名/伪装成图片的文件不算图片）；
 * - 类型、文件字节、解码后单边与总像素都设上限，避免超大解码内存；
 * - 不支持的格式明确报错，不静默丢失、不自动转换；
 * - 送视觉模型前必须缩小到明确上限并**重新编码为 JPEG**（重编码同时去掉 EXIF 等元数据）；
 * - 原图内容不覆盖：生成式修图通过图片端口产出新结果。
 *
 * 解码/重编码经端口注入：生产用浏览器原生 `createImageBitmap` + canvas，
 * 测试用替身验证边界规则（jsdom 没有 canvas）。
 */
import { IMAGE_LIMITS } from "./creation-image-limits";

const IMAGE_INPUT_LIMITS = {
  photoBytes: IMAGE_LIMITS.sourceBytes,
  totalBytes: IMAGE_LIMITS.sourceBytesTotal,
  photos: IMAGE_LIMITS.sourceImages,
  photoEdgePx: IMAGE_LIMITS.maxEdgePx,
  photoPixels: IMAGE_LIMITS.maxPixels
} as const;

export const SUPPORTED_CREATION_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export const CREATION_VISION_LIMITS = {
  images: 9,
  edgePx: 1_024,
  bytesPerImage: 512 * 1024,
  totalBytes: 4 * 1024 ** 2,
  type: "image/jpeg",
  quality: 0.85
} as const;

/** 修图/参考图预算按原文件字节计算；超限拒绝，不自动缩图或展平。 */
export const CREATION_SOURCE_LIMITS = {
  images: IMAGE_LIMITS.sourceImages,
  bytesPerImage: IMAGE_LIMITS.sourceBytes,
  totalBytes: IMAGE_LIMITS.sourceBytesTotal
} as const;

export type CreationMediaErrorCode =
  | "IMAGE_TYPE_UNSUPPORTED"
  | "IMAGE_TOO_LARGE"
  | "IMAGE_TOTAL_TOO_LARGE"
  | "IMAGE_TOO_MANY"
  | "IMAGE_DECODE_FAILED"
  | "IMAGE_DIMENSIONS_INVALID"
  | "IMAGE_VISION_BUDGET_EXCEEDED";

export class CreationMediaError extends Error {
  constructor(
    readonly code: CreationMediaErrorCode,
    detail: string
  ) {
    super(`${code}:${detail}`);
    this.name = "CreationMediaError";
  }
}

export type DecodedImageSize = { width: number; height: number };

export type ImageDecodePort = {
  /** 真实解码并返回像素尺寸；失败必须抛错（不能只信 MIME）。 */
  decode(blob: Blob): Promise<DecodedImageSize>;
  /** 等比缩到 `edgePx` 内并重编码（去元数据）；返回新字节。输出固定 JPEG。 */
  resizeToJpeg(blob: Blob, options: { edgePx: number; quality: number }): Promise<Blob>;
  /**
   * 修图源图重编码：保持给定类型（PNG/WebP 保留透明度），可选显式背景展平
   * （`background` 存在时先铺底再绘制，绝不允许透明静默变黑）。等比、只缩不放。
   */
  reencode(blob: Blob, options: { edgePx: number; type: string; quality: number; background?: string }): Promise<Blob>;
};

/** 生产实现：浏览器原生解码 + canvas 重编码（`OffscreenCanvas` 优先，回退 DOM canvas）。 */
export function createBrowserImagePort(): ImageDecodePort {
  return {
    async decode(blob) {
      const bitmap = await createBitmap(blob);
      try {
        return { width: bitmap.width, height: bitmap.height };
      } finally {
        bitmap.close?.();
      }
    },
    async resizeToJpeg(blob, options) {
      const bitmap = await createBitmap(blob);
      try {
        const scale = Math.min(1, options.edgePx / Math.max(bitmap.width, bitmap.height));
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));
        const out = await drawToBlob(bitmap, width, height, { type: CREATION_VISION_LIMITS.type, quality: options.quality });
        if (!out) throw new CreationMediaError("IMAGE_DECODE_FAILED", "重编码失败。");
        return out;
      } finally {
        bitmap.close?.();
      }
    },
    async reencode(blob, options) {
      const bitmap = await createBitmap(blob);
      try {
        const scale = Math.min(1, options.edgePx / Math.max(bitmap.width, bitmap.height));
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));
        const out = await drawToBlob(bitmap, width, height, options);
        if (!out) throw new CreationMediaError("IMAGE_DECODE_FAILED", "重编码失败。");
        return out;
      } finally {
        bitmap.close?.();
      }
    }
  };
}

/**
 * 绘制到画布并重编码：`background` 存在时先铺底（透明图合成显式背景，不变黑）。
 * `type`/`quality` 直接传给 canvas；PNG 忽略 quality。调用方已确保尺寸受上限约束。
 */
export async function drawToBlob(
  source: CanvasImageSource,
  width: number,
  height: number,
  options: { type: string; quality: number; background?: string }
): Promise<Blob | null> {
  const draw = (context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) => {
    if (options.background) {
      context.fillStyle = options.background;
      context.fillRect(0, 0, width, height);
    }
    context.drawImage(source, 0, 0, width, height);
  };
  if (typeof OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D | null;
    if (!context) return null;
    draw(context);
    return canvas.convertToBlob({ type: options.type, quality: options.quality });
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  draw(context);
  return new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, options.type, options.quality)
  );
}

/** 兼容旧调用：JPEG 重编码（看图预算路径）。 */
export async function drawToJpeg(
  source: CanvasImageSource,
  width: number,
  height: number,
  quality: number
): Promise<Blob | null> {
  return drawToBlob(source, width, height, { type: CREATION_VISION_LIMITS.type, quality });
}

async function createBitmap(blob: Blob): Promise<ImageBitmap> {
  if (typeof createImageBitmap !== "function") {
    throw new CreationMediaError("IMAGE_DECODE_FAILED", "当前环境不支持图片解码。");
  }
  try {
    return await createImageBitmap(blob);
  } catch {
    throw new CreationMediaError("IMAGE_DECODE_FAILED", "文件不是可解码的图片。");
  }
}

/** 类型 + 字节 + 解码后尺寸的统一校验（导入与上传共用一个入口）。 */
export function assertCreationImage(
  image: { type: string; size: number },
  decoded: DecodedImageSize,
  existing: { count: number; bytes: number }
): void {
  if (
    !SUPPORTED_CREATION_IMAGE_TYPES.includes(
      image.type as (typeof SUPPORTED_CREATION_IMAGE_TYPES)[number]
    )
  )
    throw new CreationMediaError(
      "IMAGE_TYPE_UNSUPPORTED",
      `暂不支持 ${image.type || "未知类型"}；请使用 JPEG、PNG 或 WebP。`
    );
  if (existing.count >= IMAGE_INPUT_LIMITS.photos)
    throw new CreationMediaError("IMAGE_TOO_MANY", `一次最多处理 ${IMAGE_INPUT_LIMITS.photos} 张图片。`);
  if (!image.size || image.size > IMAGE_INPUT_LIMITS.photoBytes)
    throw new CreationMediaError(
      "IMAGE_TOO_LARGE",
      `单张图片不能超过 ${Math.round(IMAGE_INPUT_LIMITS.photoBytes / 1024 ** 2)}MiB。`
    );
  if (existing.bytes + image.size > IMAGE_INPUT_LIMITS.totalBytes)
    throw new CreationMediaError(
      "IMAGE_TOTAL_TOO_LARGE",
      `图片累计不能超过 ${Math.round(IMAGE_INPUT_LIMITS.totalBytes / 1024 ** 2)}MiB。`
    );
  if (
    !Number.isSafeInteger(decoded.width) ||
    !Number.isSafeInteger(decoded.height) ||
    decoded.width <= 0 ||
    decoded.height <= 0 ||
    decoded.width > IMAGE_INPUT_LIMITS.photoEdgePx ||
    decoded.height > IMAGE_INPUT_LIMITS.photoEdgePx ||
    decoded.width * decoded.height > IMAGE_INPUT_LIMITS.photoPixels
  )
    throw new CreationMediaError(
      "IMAGE_DIMENSIONS_INVALID",
      `图片尺寸 ${decoded.width}×${decoded.height} 超出上限（单边 ≤ ${IMAGE_INPUT_LIMITS.photoEdgePx}px，总像素 ≤ ${IMAGE_INPUT_LIMITS.photoPixels}）。`
    );
}

export type VisionImage = { blob: Blob; width: number; height: number };

/**
 * 送视觉模型前的处理：解码 → 缩到 `edgePx` → 重编码 JPEG（去元数据）→ 字节预算复核。
 * 只处理**明确选中**的图片；返回的字节才是允许外发的图片数据。
 */
export async function prepareVisionImage(blob: Blob, port: ImageDecodePort): Promise<VisionImage> {
  const decoded = await port.decode(blob);
  assertCreationImage(blob, decoded, { count: 0, bytes: 0 });
  const resized = await port.resizeToJpeg(blob, {
    edgePx: CREATION_VISION_LIMITS.edgePx,
    quality: CREATION_VISION_LIMITS.quality
  });
  if (resized.size > CREATION_VISION_LIMITS.bytesPerImage)
    throw new CreationMediaError(
      "IMAGE_VISION_BUDGET_EXCEEDED",
      `单张送模型图片超过 ${Math.round(CREATION_VISION_LIMITS.bytesPerImage / 1024)}KiB 预算。`
    );
  const finalSize = await port.decode(resized);
  return { blob: resized, width: finalSize.width, height: finalSize.height };
}

/** 一组图片的视觉外发准备：数量与累计字节上限在**这里**统一判定。 */
export async function prepareVisionImages(
  photos: readonly { id: string; blob: Blob }[],
  port: ImageDecodePort
): Promise<{ id: string; image: VisionImage }[]> {
  if (photos.length > CREATION_VISION_LIMITS.images)
    throw new CreationMediaError(
      "IMAGE_TOO_MANY",
      `一次最多处理 ${CREATION_VISION_LIMITS.images} 张图片。`
    );
  const prepared: { id: string; image: VisionImage }[] = [];
  let bytes = 0;
  for (const photo of photos) {
    const image = await prepareVisionImage(photo.blob, port);
    bytes += image.blob.size;
    if (bytes > CREATION_VISION_LIMITS.totalBytes)
      throw new CreationMediaError(
        "IMAGE_VISION_BUDGET_EXCEEDED",
        `送模型图片累计超过 ${Math.round(CREATION_VISION_LIMITS.totalBytes / 1024 ** 2)}MiB 预算。`
      );
    prepared.push({ id: photo.id, image });
  }
  return prepared;
}

/** 修图/参考图出站的转换记录：null = 原字节直传（EXIF 方向、透明度、ICC 全保留）。 */
export type SourceImageTransform = {
  reason: "byte-budget" | "alpha-flatten";
  mime: string;
  width: number;
  height: number;
  /** alpha-flatten 的展平背景（显式声明，透明不静默变黑）。 */
  background?: "#FFFFFF";
} | null;

export type SourceImage = { blob: Blob; width: number; height: number; transform: SourceImageTransform };

/**
 * 所选版本的完整字节送修图/参考图模型。只解码校验，不重编码；超限明确拒绝。
 * 快照摘要由调用方对这里返回的同一份 blob 计算。
 *
 * 元数据策略：AI 看图的 JPEG 副本剥离元数据；修图直传保留来源中的 EXIF/GPS/ICC，
 * 它们会一起发给图片供应商。原件与已保存结果都不覆盖。
 * SourceImageTransform 类型保留，供旧快照回读；新请求不再产生降档记录。
 */
export async function prepareSourceImages(
  photos: readonly { id: string; blob: Blob }[],
  port: ImageDecodePort
): Promise<{ id: string; image: SourceImage }[]> {
  if (photos.length > CREATION_SOURCE_LIMITS.images)
    throw new CreationMediaError("IMAGE_TOO_MANY", `一次最多处理 ${CREATION_SOURCE_LIMITS.images} 张图片。`);
  let bytes = 0;
  const prepared: { id: string; image: SourceImage }[] = [];
  for (const photo of photos) {
    // 在解码前拦字节预算，避免大文件无谓占用解码内存。
    if (!photo.blob.size || photo.blob.size > CREATION_SOURCE_LIMITS.bytesPerImage)
      throw new CreationMediaError("IMAGE_TOO_LARGE", "单张原图不能超过 20MiB；不会自动缩小，请另选图片。");
    bytes += photo.blob.size;
    if (bytes > CREATION_SOURCE_LIMITS.totalBytes)
      throw new CreationMediaError("IMAGE_TOTAL_TOO_LARGE", `一次请求的原图合计不能超过 ${Math.round(CREATION_SOURCE_LIMITS.totalBytes / 1024 ** 2)}MiB；请减少张数，不会自动缩小。`);
    const decoded = await port.decode(photo.blob);
    assertCreationImage(photo.blob, decoded, { count: 0, bytes: 0 });
    prepared.push({ id: photo.id, image: { blob: photo.blob, ...decoded, transform: null } });
  }
  return prepared;
}
