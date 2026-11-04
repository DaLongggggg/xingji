import { IMAGE_LIMITS } from "@/features/creation/creation-image-limits";
import { readImageHeader } from "./image-provider";
import { PublicHttpsError, readPublicHttpsUrl, validatePublicHttpsUrl, type PublicHttpsDeps } from "./public-https";

export const SEARCH_IMAGE_FILE_TIMEOUT_MS = 10_000;
const DETAILS = {
  invalid: "图片来源无效，只支持公开 HTTPS 原图链接。",
  limit: "图片文件为空、超过 20MiB 或尺寸超出限制。",
  format: "来源没有返回完整的 PNG、JPEG 或 WebP 图片。",
  cancelled: "图片文件读取已取消。",
  timeout: "图片文件读取超时，请稍后重试。",
  unavailable: "无法读取图片文件，请检查来源限制或稍后重试。"
} as const;

export class SearchImageFileError extends Error {
  constructor(readonly code: keyof typeof DETAILS) { super(DETAILS[code]); this.name = "SearchImageFileError"; }
}

/** Explicit original-file read only. No page scraping, URL rewriting, credentials or partial previews. */
export async function readSearchImageFile(
  input: { url: string; sourceUrl: string }, callerSignal?: AbortSignal, deps: PublicHttpsDeps = {}
): Promise<{ bytes: Uint8Array; mime: "image/png" | "image/jpeg" | "image/webp" }> {
  if (callerSignal?.aborted) throw new SearchImageFileError("cancelled");
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  callerSignal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, SEARCH_IMAGE_FILE_TIMEOUT_MS);
  try {
    validatePublicHttpsUrl(input.sourceUrl);
    validatePublicHttpsUrl(input.url);
    const result = await readPublicHttpsUrl(input.url, {
      signal: controller.signal, maxBytes: IMAGE_LIMITS.sourceBytes, accept: "image/png, image/jpeg, image/webp"
    }, deps);
    if (callerSignal?.aborted) throw new SearchImageFileError("cancelled");
    if (timedOut) throw new SearchImageFileError("timeout");
    if (result.status !== 200) throw new SearchImageFileError("unavailable");
    if (result.truncated) throw new SearchImageFileError("format");
    if (!result.bytes.length || result.bytes.length > IMAGE_LIMITS.sourceBytes) throw new SearchImageFileError("limit");
    const header = readImageHeader(result.bytes);
    const declared = result.headers["content-type"]?.split(";")[0].trim().toLowerCase();
    if (!header || (declared && declared !== "application/octet-stream" && declared !== header.mime))
      throw new SearchImageFileError("format");
    if (header.width > IMAGE_LIMITS.maxEdgePx || header.height > IMAGE_LIMITS.maxEdgePx
      || header.width * header.height > IMAGE_LIMITS.maxPixels) throw new SearchImageFileError("limit");
    return { bytes: result.bytes, mime: header.mime };
  } catch (error) {
    if (callerSignal?.aborted) throw new SearchImageFileError("cancelled");
    if (timedOut) throw new SearchImageFileError("timeout");
    if (error instanceof SearchImageFileError) throw error;
    throw new SearchImageFileError(error instanceof PublicHttpsError && error.code === "invalid" ? "invalid"
      : error instanceof PublicHttpsError && error.code === "limit" ? "limit" : "unavailable");
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", abort);
  }
}
