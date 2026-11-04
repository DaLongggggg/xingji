import { IMAGE_LIMITS } from "@/features/creation/creation-image-limits";
import { LOCAL_IMAGE_EDIT, type LocalImageEdit } from "./workbench-image-edit-contract";
export type ImageTransformResult = { blob: Blob; width: number; height: number; sourceWidth: number; sourceHeight: number };

/** Decode the frozen original once; only the final result is encoded. The source Blob stays untouched. */
export async function transformImage(source: Blob, operation: LocalImageEdit, model?: ArrayBuffer): Promise<ImageTransformResult> {
  const edit = LOCAL_IMAGE_EDIT.parse(operation);
  if (!source.size || source.size > IMAGE_LIMITS.sourceBytes) throw new Error("原图文件超出20MiB限制。");
  const bitmap = await createImageBitmap(source, { imageOrientation: "from-image" });
  try {
    const { width, height } = bitmap;
    if (width > IMAGE_LIMITS.maxEdgePx || height > IMAGE_LIMITS.maxEdgePx || width * height > IMAGE_LIMITS.maxPixels) throw new Error("原图尺寸超出处理范围。");
    if ("bounds" in edit && (edit.bounds.right > width || edit.bounds.bottom > height)) throw new Error("选区已超出当前原图，请重新选择。");
    const bounds = edit.kind === "crop" ? edit.bounds : { left: 0, top: 0, right: width, bottom: height };
    const out = edit.kind === "resize" ? edit : edit.kind === "rotate" && edit.quarterTurns % 2 ? { width: height, height: width }
      : { width: bounds.right - bounds.left, height: bounds.bottom - bounds.top };
    const canvas = new OffscreenCanvas(out.width, out.height), ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("当前设备无法打开图像画布。");
    if (edit.kind === "rotate") { ctx.translate(out.width / 2, out.height / 2); ctx.rotate(edit.quarterTurns * Math.PI / 2); ctx.drawImage(bitmap, -width / 2, -height / 2); }
    else ctx.drawImage(bitmap, bounds.left, bounds.top, bounds.right - bounds.left, bounds.bottom - bounds.top, 0, 0, out.width, out.height);
    if (edit.kind === "annotate") {
      const b = edit.bounds, stroke = Math.max(2, Math.round(Math.min(width, height) / 180));
      ctx.strokeStyle = edit.color; ctx.fillStyle = edit.color; ctx.lineWidth = stroke; ctx.lineJoin = "round";
      if (edit.mark === "rectangle") ctx.strokeRect(b.left + stroke / 2, b.top + stroke / 2, b.right - b.left - stroke, b.bottom - b.top - stroke);
      else if (edit.mark === "text") { ctx.font = `${edit.fontSize}px sans-serif`; ctx.textBaseline = "top"; ctx.fillText(edit.text!, b.left, b.top, b.right - b.left); }
      else {
        const leftward = edit.arrowDirection === "up-left" || edit.arrowDirection === "down-left";
        const upward = edit.arrowDirection === "up-left" || edit.arrowDirection === "up-right";
        const from = { x: leftward ? b.right : b.left, y: upward ? b.bottom : b.top };
        const to = { x: leftward ? b.left : b.right, y: upward ? b.top : b.bottom };
        const angle = Math.atan2(to.y - from.y, to.x - from.x), head = Math.max(stroke * 5, 12);
        ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y);
        ctx.moveTo(to.x - head * Math.cos(angle - Math.PI / 6), to.y - head * Math.sin(angle - Math.PI / 6)); ctx.lineTo(to.x, to.y);
        ctx.lineTo(to.x - head * Math.cos(angle + Math.PI / 6), to.y - head * Math.sin(angle + Math.PI / 6)); ctx.stroke();
      }
    }
    if (edit.kind === "remove-background") {
      const { backgroundMask } = await import("./workbench-image-background");
      if (!model) throw new Error("抠图模型尚未通过校验，未处理原图。");
      const mask = await backgroundMask(bitmap, model);
      // destination-in multiplies the original alpha; it never flattens existing transparency.
      ctx.globalCompositeOperation = "destination-in"; ctx.drawImage(mask, 0, 0, out.width, out.height);
      const alpha = ctx.getImageData(0, 0, out.width, out.height).data;
      let transparent = false, foreground = false;
      for (let index = 3; index < alpha.length; index += 4) { transparent ||= alpha[index] < 240; foreground ||= alpha[index] > 16; }
      if (!transparent || !foreground) throw new Error("未能分离可用主体，请尝试主体更清晰的图片。");
    }
    const blob = await canvas.convertToBlob({ type: "image/png" });
    if (!blob.size || blob.size > IMAGE_LIMITS.responseBytes) throw new Error("编辑结果超过20MiB，未保存；请先缩小尺寸。");
    return { blob, width: out.width, height: out.height, sourceWidth: width, sourceHeight: height };
  } finally { bitmap.close(); }
}
