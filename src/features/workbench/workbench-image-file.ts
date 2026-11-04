import { detectGlobalBridge, digestBytes } from "@/features/mobile/native-host";
import { apiFetch } from "@/lib/api-client";
import { isSearchImageUrl } from "@/features/ai/native-search-contract";
import { IMAGE_LIMITS } from "@/features/creation/creation-image-limits";
import { blobToBase64 } from "@/features/creation/creation-image-port";
import { assertCreationImage, createBrowserImagePort, type ImageDecodePort } from "@/features/creation/creation-media";
import type { MessageAttachment } from "./workbench-types";

export type WorkbenchImageFile = { attachment: MessageAttachment; blob: Blob };
export type WorkbenchImageFileSource = { id: string; name: string; url: string; blob?: Blob; sourceUrl?: string; fileRef?: import("./workbench-types").NativeMediaFileRef };
type ReadOptions = { signal?: AbortSignal; fetchImpl?: typeof fetch; decode?: ImageDecodePort["decode"] };
const TYPES = ["image/png", "image/jpeg", "image/webp"];

function fileName(name: string, type: string): string {
  const stem = name.replace(/[\x00-\x1f\x7f/\\<>:"|?*]/g, "_").trim().replace(/\.(?:png|jpe?g|webp)$/i, "").slice(0, 160) || "图片";
  return `${stem}.${type === "image/jpeg" ? "jpg" : type === "image/webp" ? "webp" : "png"}`;
}
function checkBlob(blob: Blob) {
  if (!blob.size || blob.size > IMAGE_LIMITS.sourceBytes) throw new Error("单张原图必须介于 1 字节和 20MiB 之间。");
  if (!TYPES.includes(blob.type)) throw new Error("原图格式不支持，请使用 PNG、JPEG 或 WebP。");
}
async function responseBlob(response: Response, signal?: AbortSignal): Promise<Blob> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(response.status === 413 ? "单张原图不能超过 20MiB。" : response.status === 504 ? "图片文件读取超时，请稍后重试。"
      : response.status === 499 ? "图片文件读取已取消。" : "无法读取完整图片文件，请检查来源或稍后重试。");
  }
  const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
  if (!TYPES.includes(type)) { await response.body?.cancel(); throw new Error("来源没有返回 PNG、JPEG 或 WebP 原图。"); }
  if (Number(response.headers.get("content-length")) > IMAGE_LIMITS.sourceBytes) {
    await response.body?.cancel(); throw new Error("单张原图不能超过 20MiB。");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("图片文件为空。");
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > IMAGE_LIMITS.sourceBytes) { await reader.cancel(); throw new Error("单张原图不能超过 20MiB。"); }
      chunks.push(new Uint8Array(value));
    }
    return new Blob(chunks, { type });
  } finally { signal?.removeEventListener("abort", abort); reader.releaseLock(); }
}

/** Parent verifies current message ownership before/after this read. Never accepts a thumbnail fallback. */
export async function readWorkbenchImageFile(image: WorkbenchImageFileSource, options: ReadOptions = {}): Promise<WorkbenchImageFile> {
  options.signal?.throwIfAborted();
  const remote = /^https:\/\//i.test(image.url);
  if (remote ? !isSearchImageUrl(image.url) || !image.sourceUrl || !isSearchImageUrl(image.sourceUrl)
    : !/^(?:blob:|data:image\/(?:png|jpeg|webp);base64,)/i.test(image.url))
    throw new Error("图片来源无效，请重新打开当前消息中的原图。");
  let blob = image.blob;
  if (!blob) {
    const fetchFile = options.fetchImpl ?? (remote ? apiFetch : fetch);
    const response = await fetchFile(remote ? "/api/ai/search-image-file" : image.url, remote ? {
      method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", redirect: "error",
      cache: "no-store", signal: options.signal, body: JSON.stringify({ url: image.url, sourceUrl: image.sourceUrl })
    } : { credentials: "omit", signal: options.signal });
    blob = await responseBlob(response, options.signal);
  }
  checkBlob(blob);
  const decoded = await (options.decode ?? createBrowserImagePort().decode)(blob);
  options.signal?.throwIfAborted();
  assertCreationImage(blob, decoded, { count: 0, bytes: 0 });
  let id = image.id;
  if (remote) {
    const bridge = detectGlobalBridge();
    const version = await digestBytes(new Uint8Array(await blob.arrayBuffer()), bridge);
    const identity = await digestBytes(new TextEncoder().encode(JSON.stringify([image.url, image.sourceUrl, version])), bridge);
    id = `remote-${identity}`;
  }
  options.signal?.throwIfAborted();
  // P1-7：原生原件（fileRef）保留引用本身——不转 dataURL（native store 拒绝 dataUrl 且
  // 原件身份/摘要不变）；远端/桌面路径维持原行为。
  if (image.fileRef) {
    return { blob, attachment: { id, name: fileName(image.name, blob.type), fileRef: image.fileRef } };
  }
  const base64 = await blobToBase64(blob);
  options.signal?.throwIfAborted();
  return { blob, attachment: { id, name: fileName(image.name, blob.type), dataUrl: `data:${blob.type};base64,${base64}` } };
}

/** Downloads exactly the acquired bytes, with the actual MIME extension. */
export function downloadWorkbenchImageFile(file: WorkbenchImageFile): void {
  const url = URL.createObjectURL(file.blob);
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = fileName(file.attachment.name, file.blob.type);
  // Keep the synthetic click inside the active modal, so outside-dismiss cannot cancel the download.
  const focusedDialog = document.activeElement?.closest("dialog[open]");
  const dialogs = document.querySelectorAll("dialog[open]");
  (focusedDialog ?? dialogs.item(dialogs.length - 1) ?? document.body).append(anchor);
  try { anchor.click(); }
  finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
