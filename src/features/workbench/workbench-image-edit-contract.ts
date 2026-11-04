import { z } from "zod";
import { IMAGE_LIMITS } from "@/features/creation/creation-image-limits";
const pixel = z.int().min(0).max(IMAGE_LIMITS.maxEdgePx);
export const IMAGE_BOUNDS = z.strictObject({ left: pixel, top: pixel, right: pixel, bottom: pixel })
  .refine(rect => rect.right > rect.left && rect.bottom > rect.top);
export type ImageBounds = z.infer<typeof IMAGE_BOUNDS>;
export const LOCAL_IMAGE_EDIT = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("crop"), bounds: IMAGE_BOUNDS }),
  z.strictObject({ kind: z.literal("rotate"), quarterTurns: z.union([z.literal(1), z.literal(2), z.literal(3)]) }),
  z.strictObject({ kind: z.literal("resize"), width: pixel.min(1), height: pixel.min(1) }).refine(size => size.width * size.height <= IMAGE_LIMITS.maxPixels),
  z.strictObject({ kind: z.literal("annotate"), mark: z.enum(["text", "arrow", "rectangle"]), bounds: IMAGE_BOUNDS,
    text: z.string().max(500).optional(), arrowDirection: z.enum(["down-right", "up-left", "down-left", "up-right"]).optional(), color: z.string().regex(/^#[0-9a-f]{6}$/i), fontSize: z.int().min(8).max(1024) })
    .refine(mark => (mark.mark !== "text" || !!mark.text?.trim()) && (mark.mark !== "arrow" || !!mark.arrowDirection)),
  z.strictObject({ kind: z.literal("remove-background") })
]);
export type LocalImageEdit = z.infer<typeof LOCAL_IMAGE_EDIT>;
export const LOCAL_EDIT_ORIGIN = z.strictObject({ sourceId: z.string().min(1).max(512), sourceDigest: z.string().regex(/^[a-f0-9]{64}$/), operation: LOCAL_IMAGE_EDIT });
export type LocalEditOrigin = z.infer<typeof LOCAL_EDIT_ORIGIN>;
export const IMAGE_EDIT_METADATA = z.strictObject({ sourceId: z.string().min(1).max(512), sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  operation: LOCAL_IMAGE_EDIT, width: pixel.min(1), height: pixel.min(1) });
export type ImageEditMetadata = z.infer<typeof IMAGE_EDIT_METADATA>;
export type ImageEditorDraft = { mode?: "crop" | "erase" | "annotate" | "resize"; bounds?: ImageBounds; sourceWidth?: number; sourceHeight?: number;
  resizeText?: string; arrowDirection?: "down-right" | "up-left" | "down-left" | "up-right"; mark?: "text" | "arrow" | "rectangle"; text?: string; color?: string; fontSize?: number };

/** CSS coordinates already contain zoom/pan/contain offsets; DPR cancels in this ratio. EXIF dimensions are display-oriented. */
export function imagePoint(client: { x: number; y: number }, rect: { left: number; top: number; width: number; height: number }, width: number, height: number) {
  if (!(rect.width > 0 && rect.height > 0 && width > 0 && height > 0)) throw new Error("图片尺寸尚未就绪。");
  return { x: Math.max(0, Math.min(width, Math.round((client.x - rect.left) / rect.width * width))),
    y: Math.max(0, Math.min(height, Math.round((client.y - rect.top) / rect.height * height))) };
}
