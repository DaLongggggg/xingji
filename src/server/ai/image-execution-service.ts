/**
 * T7/T8：图像执行共享服务——桌面图片路由与任务宿主共用的校验/执行边界。
 *
 * 职责（任务书 §9.2「共享 image-execution-service 的校验/Provider 规则」）：
 * - 按 configId 在给定作用域环境内受控解析图片配置（未知/缺密钥/非法端点明确失败）；
 * - 组装 Provider 请求并执行（协议/超时/响应校验在 createImageProvider 内）；
 * - 输入与输出字节都经 readImageHeader/IMAGE_LIMITS 校验，不新增压缩或降采样。
 * 调用方负责计费登记（beginProviderCall 先于本服务出站）与终态落库。
 */
import { createImageConfigStore, ImageConfigError, type ResolvedImageConfig } from "./image-config.ts";
import { createImageProvider, readImageHeader, type SupportedImageMime } from "./image-provider.ts";

const SUPPORTED_MIMES: readonly string[] = ["image/png", "image/jpeg", "image/webp"];
import { IMAGE_LIMITS } from "@/features/creation/creation-image-limits";

export type ImageStepRequest = {
  mode: "generate" | "edit";
  prompt: string;
  size: string;
  quality?: string;
  outputFormat?: string;
  sources?: { bytes: Uint8Array; mime: string }[];
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type ImageStepSuccess = { ok: true; bytes: Uint8Array; mime: SupportedImageMime; model: string; configId: string };
export type ImageStepFailure = { ok: false; code: string; detail: string; status: number; phase: string };
export type ImageStepResult = ImageStepSuccess | ImageStepFailure;

/** 输入源字节校验：真实图片头 + 尺寸/像素上限（不重编码）。 */
export function validateImageSource(bytes: Uint8Array, mime: string): { ok: true } | { ok: false; code: string; detail: string } {
  const header = readImageHeader(bytes);
  if (!header || header.mime !== mime) return { ok: false, code: "IMAGE_SOURCE_INVALID", detail: "图片来源字节与声明类型不符。" };
  if (header.width > IMAGE_LIMITS.maxEdgePx || header.height > IMAGE_LIMITS.maxEdgePx || header.width * header.height > IMAGE_LIMITS.maxPixels) {
    return { ok: false, code: "IMAGE_SOURCE_TOO_LARGE", detail: "图片来源尺寸超过上限。" };
  }
  if (bytes.byteLength > IMAGE_LIMITS.sourceBytes) return { ok: false, code: "IMAGE_SOURCE_TOO_LARGE", detail: "图片来源字节超过上限。" };
  return { ok: true };
}

/** 产物字节校验：可解码 + mime 匹配 + 上限（与输入同一规则）。 */
export function validateImageArtifact(bytes: Uint8Array, mime: string): { ok: true } | { ok: false; code: string; detail: string } {
  return validateImageSource(bytes, mime);
}

export function isSupportedImageMime(value: string): value is SupportedImageMime {
  return SUPPORTED_MIMES.includes(value);
}

/**
 * 受控执行一次图像请求。环境来自调用方作用域（桌面 currentScopeEnv / 宿主 runInBetaScope）；
 * fetchImpl 仅用于进程内受控替身，生产使用全局 fetch。
 */
export async function executeImageStep(
  scopeEnv: NodeJS.ProcessEnv,
  imageConfigId: string,
  request: ImageStepRequest,
  deps: { fetchImpl?: typeof fetch } = {}
): Promise<ImageStepResult> {
  let config: ResolvedImageConfig;
  try {
    const store = createImageConfigStore(scopeEnv);
    if (!store.enabled()) return { ok: false, code: "IMAGE_DISABLED", detail: "未声明任何图片配置。", status: 503, phase: "prepare" };
    config = store.resolve(imageConfigId);
  } catch (error) {
    if (error instanceof ImageConfigError) {
      return { ok: false, code: error.code, detail: "图片配置不可用。", status: 400, phase: "prepare" };
    }
    return { ok: false, code: "IMAGE_CONFIG_UNAVAILABLE", detail: "图片配置读取失败。", status: 503, phase: "prepare" };
  }
  const result = await createImageProvider(config, { fetchImpl: deps.fetchImpl }).run({
    mode: request.mode,
    prompt: request.prompt,
    size: request.size,
    quality: request.quality as never,
    outputFormat: request.outputFormat as never,
    ...(request.sources && request.sources.length ? { sources: request.sources } : {}),
    ...(request.signal ? { signal: request.signal } : {}),
    ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {})
  });
  if (!result.ok) {
    return { ok: false, code: result.code, detail: result.detail, status: result.status, phase: result.phase };
  }
  const checked = validateImageArtifact(result.bytes, result.mime);
  if (!checked.ok) return { ok: false, code: checked.code, detail: checked.detail, status: 502, phase: "response" };
  return { ok: true, bytes: result.bytes, mime: result.mime, model: result.model, configId: result.configId };
}
