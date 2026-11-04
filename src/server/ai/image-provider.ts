/**
 * P9-04：受控图片 Provider（OpenAI images 协议，generate / edit）。
 *
 * 边界：
 * - 协议**显式声明**：generations-image 的参考图放在 JSON image 字段；edits-multipart
 *   带输入图（包括 generate 参考图）走 images/edits，纯文生图走 images/generations。
 *   路径从配置推导并与 baseUrl 去重版本段，不假设 chat/completions 能出图；
 * - `Authorization: Bearer <apiKey>` 只出现在服务端出站请求头里；
 * - 校验全部前置于出站请求：不合法请求不会产生任何上游流量（零请求拒绝）；
 * - 响应正文按**字节**限额读取；解码后的图片仍要过魔数/尺寸校验，绝不以“看起来成功”收场；
 * - 错误 detail 一律脱敏（去掉 sk- 形态与 Bearer），不把 apiKey 写进返回值或日志。
 */
import type { ResolvedImageConfig } from "./image-config";
import { load as readExif } from "exifreader";

/*
 * 上限**只有一份**定义：`src/features/creation/creation-image-limits.ts`，
 * 客户端（发送前预算/返回图校验）与服务端（协议硬限制）共用，避免两处漂移。
 * 这里重新导出，保持既有导入路径与测试不变。
 */
import { IMAGE_LIMITS, IMAGE_SIZES } from "../../features/creation/creation-image-limits";
import { imageOutputFormats, isSeedreamModel, supportsInteractiveImageEdit, validImageEditBounds,
  type ImageOutputFormat } from "../../features/creation/creation-image-rules";

export { IMAGE_LIMITS, IMAGE_SIZES };


export type ImageQuality = "low" | "medium" | "high";
export type ImageMode = "generate" | "edit";
export type SupportedImageMime = "image/png" | "image/jpeg" | "image/webp";

export type ImageProviderRequest = {
  mode: ImageMode;
  prompt: string;
  size: string;
  quality: ImageQuality;
  outputFormat?: ImageOutputFormat;
  /**
   * 输入图（协议各不相同，见 `buildGenerateBody` / `buildEditForm`）：
   * edit 恰好一张；generate 0..N 张（N>1 = 用多张图生成一张新图）。
   */
  sources?: { bytes: Uint8Array; mime: string }[];
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type ImageProviderSuccess = {
  ok: true;
  bytes: Uint8Array;
  mime: SupportedImageMime;
  model: string;
  configId: string;
};

/**
 * 失败阶段（R1 终态归类依据，不改协议实现）：
 * - `prepare`：出站前校验拒绝——确定未发出；
 * - `upstream`：上游已接收并返回错误响应——请求已执行，确定失败；
 * - `response`：上游已响应但内容无效——请求已执行，确定失败；
 * - `network` / `timeout` / `cancelled`：连接失败、超时或取消——**远端结果未知**，
 *   不能凭泛化错误推定未执行（任务书 §4.2）。
 */
export type ImageProviderFailurePhase = "prepare" | "upstream" | "response" | "network" | "timeout" | "cancelled";

export type ImageProviderFailure = { ok: false; code: string; detail: string; status: number; phase: ImageProviderFailurePhase };

export type ImageProviderResult = ImageProviderSuccess | ImageProviderFailure;

export type ImageHeader = { mime: SupportedImageMime; width: number; height: number };

/** 脱敏：去掉 sk- 形态密钥、Bearer 形式与 apiKey 原文，并截断长度。 */
export function redactImageDetail(value: string, apiKey?: string): string {
  let text = value;
  if (apiKey && apiKey.length > 0) text = text.split(apiKey).join("[REDACTED]");
  text = text.replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [REDACTED]");
  text = text.replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]");
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

function failure(code: string, status: number, detail: string, apiKey?: string,
  phase: ImageProviderFailurePhase = "prepare"): ImageProviderFailure {
  return { ok: false, code, status, detail: redactImageDetail(detail, apiKey), phase };
}

function uint8(view: Uint8Array): Uint8Array {
  /*
   * Buffer 是 Uint8Array 的子类，但底层 ArrayBuffer 可能是共享池，
   * 因此比较与 FormData/Blob 组装前先复制成独占视图。
   */
  return new Uint8Array(view);
}

/** PNG：签名固定，IHDR 位于偏移 16，宽高为大端 uint32。 */
function readPngHeader(bytes: Uint8Array): ImageHeader | null {
  const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];
  if (bytes.length < 24) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return null;
  }
  // 偏移 12..16 必须是 IHDR，否则不是可解析的 PNG。
  if (
    bytes[12] !== 0x49 ||
    bytes[13] !== 0x48 ||
    bytes[14] !== 0x44 ||
    bytes[15] !== 0x52
  ) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  if (width === 0 || height === 0) return null;
  return { mime: "image/png", width, height };
}

/** JPEG：扫描 SOFn 段（SOF0/SOF1/SOF2）取得宽高。 */
function readJpegHeader(bytes: Uint8Array): ImageHeader | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    let marker = bytes[offset + 1];
    // 填充字节：允许连续的 0xff。
    while (marker === 0xff && offset + 2 < bytes.length) {
      offset += 1;
      marker = bytes[offset + 1];
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const size = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (size < 2) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (offset + 9 >= bytes.length) return null;
      const height = (bytes[offset + 5] << 8) | bytes[offset + 6];
      const width = (bytes[offset + 7] << 8) | bytes[offset + 8];
      if (width === 0 || height === 0) return null;
      return { mime: "image/jpeg", width, height };
    }
    // SOS 之后是熵编码数据，不会再出现 SOF。
    if (marker === 0xda) return null;
    offset += 2 + size;
  }
  return null;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let text = "";
  for (let i = start; i < end && i < bytes.length; i += 1) text += String.fromCharCode(bytes[i]);
  return text;
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

/** WebP：RIFF/WEBP 容器，分别处理 VP8X / VP8 / VP8L 三种变体。 */
function readWebpHeader(bytes: Uint8Array): ImageHeader | null {
  if (bytes.length < 30) return null;
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 12) !== "WEBP") return null;
  const chunk = ascii(bytes, 12, 16);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (chunk === "VP8X") {
    const width = readUint24LE(bytes, 24) + 1;
    const height = readUint24LE(bytes, 27) + 1;
    return width > 0 && height > 0 ? { mime: "image/webp", width, height } : null;
  }
  if (chunk === "VP8 ") {
    // 帧头：3 字节起始码 9d 01 2a，随后 14 位宽、14 位高（小端位域）。
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    const width = view.getUint16(26, true) & 0x3fff;
    const height = view.getUint16(28, true) & 0x3fff;
    return width > 0 && height > 0 ? { mime: "image/webp", width, height } : null;
  }
  if (chunk === "VP8L") {
    // 无损：0x2f 签名 + 14 位宽高（无符号，需 +1）。
    if (bytes[20] !== 0x2f) return null;
    const bits =
      bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return width > 0 && height > 0 ? { mime: "image/webp", width, height } : null;
  }
  return null;
}

/** 只认 PNG/JPEG/WebP 三种魔数；其它一律 null（不引入第三方解码器）。 */
export function readImageHeader(bytes: Uint8Array): ImageHeader | null {
  return readPngHeader(bytes) ?? readJpegHeader(bytes) ?? readWebpHeader(bytes);
}

function headerWithinLimits(header: ImageHeader): boolean {
  return (
    header.width <= IMAGE_LIMITS.maxEdgePx &&
    header.height <= IMAGE_LIMITS.maxEdgePx &&
    header.width * header.height <= IMAGE_LIMITS.maxPixels
  );
}

/** 已确认支持三种魔数，这里的兜底只是让类型收窄，正常不会走到。 */
function mimeFromSource(mime: string): SupportedImageMime | null {
  return mime === "image/png" || mime === "image/jpeg" || mime === "image/webp" ? mime : null;
}

/**
 * 用哪条传输：
 * - `generations-image`（方舟 Seedream、千问）：**永远**走 `imagesPath`，输入图放 JSON 的 `image` 字段
 *   （单张是字符串、多张是数组）——生成与图生图/多图融合是同一个端点。
 * - `edits-multipart`（OpenAI gpt-image）：**只要带输入图**就走由 `imagesPath` 推导的 edits multipart
 *   （多张用重复的 `image[]`；官方也是用这条接口从多张参考图生成一张新图）；
 *   不带输入图才是纯文生图 `imagesPath` 的 JSON。
 * 因此判据是"协议 + 有没有输入图"，不是产品层的 generate/edit。
 */
function usesMultipart(request: ImageProviderRequest, config: ResolvedImageConfig): boolean {
  return config.editMode !== "generations-image" && (request.sources?.length ?? 0) > 0;
}

/**
 * 编辑路径**从 `imagesPath` 推导**，不能另写一个绝对路径：`baseUrl` 里已经含版本段
 * （OpenAI 是 `https://api.openai.com/v1`），再拼一个 `/v1/images/edits` 会请求到
 * `…/v1/v1/images/edits`，必然 404。
 *
 * 规矩：与生成路径同级——`…/images/generations` → `…/images/edits`。
 * 推不出来（自定义路径没有 `/images/` 段）时返回 undefined，由调用方**明确失败**，不猜、不硬拼。
 */
export function editPathFor(imagesPath: string): string | undefined {
  return imagesPath.endsWith("/images/generations")
    ? `${imagesPath.slice(0, -"/images/generations".length)}/images/edits`
    : undefined;
}

/**
 * 拼接端点：`baseUrl` 与 `imagesPath` **都带版本段**时只保留一个（得到 `/v1/v1/images/…` 的经典错法）。
 * 预设把版本段放在 baseUrl 里、路径从 `/images/…` 起；老记录/自定义里可能两头都写。
 */
export function joinEndpoint(base: string, path: string): string {
  const version = /\/v\d+$/.exec(base)?.[0];
  return version && path.startsWith(`${version}/`) ? `${base}${path.slice(version.length)}` : `${base}${path}`;
}

function endpointPath(request: ImageProviderRequest, config: ResolvedImageConfig): string | undefined {
  // 旧配置可能只有主机名；保留 /v1 缺省，joinEndpoint 会去掉重复版本段。
  const imagesPath = config.imagesPath ?? "/v1/images/generations";
  return usesMultipart(request, config) ? editPathFor(imagesPath) : imagesPath;
}

function parseSize(size: string): { width: number; height: number } | null {
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (!match) return null;
  return { width: Number(match[1]), height: Number(match[2]) };
}

function buildGenerateBody(request: ImageProviderRequest, config: ResolvedImageConfig): string {
  /*
   * 按已知模型的官方参数组包；其他兼容端点保留原契约：
   * - 请求内联 base64（`response_format`），能内联就不走临时 URL；不支持该字段的供应商会忽略它；
   * - `image` 字段用于 `generations-image` 变体的图生图/编辑；
   * - `watermark` 只在配置声明时下发（供应商默认给结果盖"AI生成"水印，需显式关闭）。
   */
  const sources = request.sources ?? [];
  /*
   * `image` 字段：单张时是字符串（供应商已跑通的形态），多张时是**数组**——
   * 方舟 Seedream 4.0-5.0 的多图融合就是同一个字段收数组（模型据此把几张图合成一张新图）。
   */
  const imageField = sources.length === 0 ? {}
    : sources.length === 1
      ? { image: `data:${sources[0]!.mime};base64,${bytesToBase64(sources[0]!.bytes)}` }
      : { image: sources.map((source) => `data:${source.mime};base64,${bytesToBase64(source.bytes)}`) };
  return JSON.stringify({
    model: config.model,
    prompt: request.prompt,
    size: request.size,
    // quality/n 是 OpenAI 参数，方舟未定义；标准优化是 Seedream 的正式参数。
    ...(isSeedreamModel(config.model)
      ? { optimize_prompt_options: { mode: "standard" } }
      : { quality: request.quality, n: 1 }),
    ...(request.outputFormat !== undefined ? { output_format: request.outputFormat } : {}),
    // `omitResponseFormat` 是**声明**：gpt-image 系列不接受该参数，且本来就返回内联 base64。
    ...(config.omitResponseFormat === true ? {} : { response_format: "b64_json" }),
    ...(config.watermark !== undefined ? { watermark: config.watermark } : {}),
    ...imageField
  });
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function buildEditForm(request: ImageProviderRequest, config: ResolvedImageConfig): FormData {
  const sources = request.sources as { bytes: Uint8Array; mime: string }[];
  const form = new FormData();
  form.set("model", config.model);
  form.set("prompt", request.prompt);
  form.set("size", request.size);
  form.set("quality", request.quality);
  form.set("n", "1");
  if (request.outputFormat !== undefined) form.set("output_format", request.outputFormat);
  /*
   * 手工组装 multipart：Node 24+ 自带 FormData/Blob，不引入表单库。
   * 单张用 `image`（已跑通的形态）；多张按 OpenAI 的多输入图字段 `image[]` 逐张附上。
   */
  sources.forEach((source, index) => {
    const mime = mimeFromSource(source.mime) ?? "image/png";
    const extension = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png";
    form.append(
      sources.length === 1 ? "image" : "image[]",
      // `Uint8Array<ArrayBufferLike>` 与 BlobPart 的 lib 类型不完全兼容：字节本身合法，做一次收窄。
      new Blob([uint8(source.bytes) as unknown as BlobPart], { type: mime }),
      `source-${index + 1}.${extension}`
    );
  });
  return form;
}

export function createImageProvider(
  config: ResolvedImageConfig,
  deps: { fetchImpl?: typeof fetch } = {}
): { run(request: ImageProviderRequest): Promise<ImageProviderResult> } {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const base = config.baseUrl.replace(/\/+$/, "");

  /**
   * 带字节上限的流式读取：超限立即停止消费上游。
   * `limit` 必须按**载荷形态**给：内联 base64 JSON 用 `responseBodyBytes`（含 4/3 膨胀），
   * 直接下载的图片字节用 `responseBytes`（解码后就是原始字节）。
   */
  async function readCapped(response: Response, limit: number): Promise<Uint8Array | null> {
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > limit) return null;
    if (!response.body) {
      const text = await response.text();
      const encoded = new TextEncoder().encode(text);
      return encoded.byteLength > limit ? null : encoded;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > limit) {
          await reader.cancel().catch(() => undefined);
          return null;
        }
        chunks.push(uint8(value));
      }
    } finally {
      reader.releaseLock?.();
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return merged;
  }

  /** 解码后的图片统一校验：字节上限 + 魔数 + 尺寸上限。 */
  function validateImageBytes(bytes: Uint8Array): ImageHeader | null {
    if (bytes.byteLength === 0 || bytes.byteLength > IMAGE_LIMITS.responseBytes) return null;
    const header = readImageHeader(bytes);
    if (!header || !headerWithinLimits(header)) return null;
    return header;
  }

  return {
    async run(request: ImageProviderRequest): Promise<ImageProviderResult> {
      // ---- 1. 前置校验：不合法请求零出站 ----
      const prompt = request.prompt;
      if (typeof prompt !== "string" || prompt.trim().length === 0) {
        return failure("IMAGE_REQUEST_INVALID", 400, "prompt 不能为空。");
      }
      if (prompt.length > IMAGE_LIMITS.maxPromptChars) {
        return failure(
          "IMAGE_REQUEST_INVALID",
          400,
          `prompt 超过 ${IMAGE_LIMITS.maxPromptChars} 字符。`
        );
      }
      const allowedSizes = config.imageSizes && config.imageSizes.length > 0 ? config.imageSizes : IMAGE_SIZES;
      if (!(allowedSizes as readonly string[]).includes(request.size)) {
        return failure("IMAGE_REQUEST_INVALID", 400, `不支持的 size：${request.size}`);
      }
      if (request.quality !== "low" && request.quality !== "medium" && request.quality !== "high") {
        return failure("IMAGE_REQUEST_INVALID", 400, `不支持的 quality：${String(request.quality)}`);
      }
      if (request.outputFormat !== undefined && !imageOutputFormats(config.model).includes(request.outputFormat)) {
        return failure("IMAGE_REQUEST_INVALID", 400, "该模型不支持所选 output_format。");
      }
      /*
       * 输入图：edit 恰好一张；generate 0..N 张（N>1 = 让模型用这几张图生成一张新图）。
       * 每一张都按同一套字节/格式/尺寸边界校验——多图不是"只查第一张"。
       */
      const sources = request.sources ?? [];
      if (request.mode === "edit" && sources.length !== 1) {
        return failure("IMAGE_REQUEST_INVALID", 400, "edit 模式必须恰好携带一张输入图。");
      }
      const totalSourceBytes = sources.reduce((sum, source) => sum + source.bytes.byteLength, 0);
      if (totalSourceBytes > IMAGE_LIMITS.sourceBytesTotal) {
        return failure("IMAGE_SOURCE_INVALID", 400,
          `输入图合计超过 ${Math.round(IMAGE_LIMITS.sourceBytesTotal / 1024 ** 2)} MiB，请减少数量或压缩后再试。`);
      }
      const maxSources = Math.min(config.maxSourceImages, IMAGE_LIMITS.sourceImages);
      if (sources.length > maxSources) {
        return failure("IMAGE_REQUEST_INVALID", 400,
          `该配置最多接受 ${maxSources} 张输入图（本次 ${sources.length} 张）。`);
      }
      for (const source of sources) {
        if (source.bytes.byteLength === 0 || source.bytes.byteLength > IMAGE_LIMITS.sourceBytes) {
          return failure("IMAGE_SOURCE_INVALID", 400, "源图片字节数超出允许范围。");
        }
        const header = readImageHeader(source.bytes);
        if (!header) {
          return failure("IMAGE_SOURCE_INVALID", 400, "源图片不是受支持的 PNG/JPEG/WebP。");
        }
        if (!headerWithinLimits(header)) {
          return failure("IMAGE_SOURCE_INVALID", 400, "源图片尺寸超出上限。");
        }
        if (request.mode === "edit" && supportsInteractiveImageEdit(config.model) && /<\/?bbox\b/i.test(request.prompt)) {
          // 浏览器看图按 EXIF 方向解码；服务端用相同显示坐标系校验，原字节仍直传。
          let orientation: number | undefined;
          try {
            orientation = readExif(uint8(source.bytes).buffer as ArrayBuffer,
              { includeTags: { exif: ["Orientation"] } }).Orientation?.value;
          } catch {
            return failure("IMAGE_SOURCE_INVALID", 400, "无法确认原图显示方向；本次未调用制图服务。");
          }
          const dimensions = orientation !== undefined && orientation >= 5 && orientation <= 8
            ? { width: header.height, height: header.width } : header;
          if (!validImageEditBounds(request.prompt, dimensions))
            return failure("IMAGE_REQUEST_INVALID", 400, "交互编辑坐标格式无效或超出原图像素范围。");
        }
      }

      // 预先取消的请求不发送。
      const callerSignal = request.signal;
      if (callerSignal?.aborted) {
        return failure("IMAGE_CANCELLED", 499, "请求在发送前已被取消。");
      }
      // 尺寸格式虽未直接参与出站字段校验，但必须能解析，避免向上游发无效 size。
      if (!parseSize(request.size)) {
        return failure("IMAGE_REQUEST_INVALID", 400, `size 格式无效：${request.size}`);
      }

      // ---- 2. 出站请求（超时/取消覆盖整个响应生命周期） ----
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      callerSignal?.addEventListener("abort", onAbort, { once: true });
      let timedOut = false;
      const timeoutMs = request.timeoutMs ?? IMAGE_LIMITS.timeoutMs;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      const abortResult = (): ImageProviderFailure =>
        callerSignal?.aborted
          ? failure("IMAGE_CANCELLED", 499, "请求已取消。", undefined, "cancelled")
          : timedOut
            ? failure("IMAGE_TIMEOUT", 504, `请求超过 ${timeoutMs}ms。`, undefined, "timeout")
            : failure("IMAGE_UPSTREAM_ERROR", 502, "上游请求失败。", config.apiKey, "network");

      try {
        const multipart = usesMultipart(request, config);
        const path = endpointPath(request, config);
        if (path === undefined) {
          // 不猜路径：宁可明确报错，也不把请求打到 `/v1/v1/…` 这种必然 404 的地址上。
          return failure("IMAGE_ENDPOINT_INVALID", 400,
            "该配置的编辑接口路径无法从 imagesPath 推导（应为 …/images/generations）；请在高级设置里改成标准路径。");
        }
        const url = joinEndpoint(base, path);
        const init: RequestInit =
          !multipart
            ? {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  authorization: `Bearer ${config.apiKey}`
                },
                body: buildGenerateBody(request, config),
                redirect: "manual",
                signal: controller.signal
              }
            : {
                method: "POST",
                // multipart 的 boundary 由 FormData 自动生成，不能手写 content-type。
                headers: { authorization: `Bearer ${config.apiKey}` },
                body: buildEditForm(request, config),
                redirect: "manual",
                signal: controller.signal
              };

        let response: Response;
        try {
          response = await fetchImpl(url, init);
        } catch (error) {
          if (controller.signal.aborted) return abortResult();
          return failure(
            "IMAGE_UPSTREAM_ERROR",
            502,
            error instanceof Error ? error.message : String(error),
            config.apiKey,
            "network"
          );
        }

        // 内联 base64 JSON：上限要含 4/3 膨胀，否则声明的图片上限永远达不到。
        const raw = await readCapped(response, IMAGE_LIMITS.responseBodyBytes);
        if (raw === null) {
          return failure(
            "IMAGE_RESPONSE_TOO_LARGE",
            502,
            `响应超过 ${IMAGE_LIMITS.responseBytes} 字节。`,
            undefined,
            "response"
          );
        }
        if (!response.ok) {
          const text = new TextDecoder().decode(raw).slice(0, 400);
          return failure(
            "IMAGE_UPSTREAM_ERROR",
            502,
            text || `上游返回 ${response.status}。`,
            config.apiKey,
            "upstream"
          );
        }

        let payload: unknown;
        try {
          payload = JSON.parse(new TextDecoder().decode(raw));
        } catch {
          // 不做正则抢救：正文不是 JSON 就明确失败。
          return failure("IMAGE_RESPONSE_INVALID", 502, "上游响应不是有效 JSON。", undefined, "response");
        }
        const first = (payload as { data?: unknown } | null)?.data;
        const entry = Array.isArray(first) ? (first[0] as Record<string, unknown> | undefined) : undefined;
        if (!entry || typeof entry !== "object") {
          return failure("IMAGE_RESPONSE_INVALID", 502, "上游响应缺少 data[0]。", undefined, "response");
        }

        // ---- 3. b64_json 优先：直接解码后校验 ----
        if (typeof entry.b64_json === "string" && entry.b64_json.length > 0) {
          const bytes = uint8(Buffer.from(entry.b64_json, "base64"));
          const header = validateImageBytes(bytes);
          if (!header) {
            return failure("IMAGE_RESPONSE_INVALID", 502, "解码后的图片未通过校验。", undefined, "response");
          }
          return { ok: true, bytes, mime: header.mime, model: config.model, configId: config.id };
        }

        if (typeof entry.url === "string" && entry.url.length > 0) {
          // ---- 4. url：只允许同源，防止被上游当作 SSRF 跳板 ----
          let imageUrl: URL;
          let baseUrl: URL;
          try {
            imageUrl = new URL(entry.url);
            baseUrl = new URL(config.baseUrl);
          } catch {
            return failure("IMAGE_RESPONSE_INVALID", 502, "上游返回的 url 无法解析。", undefined, "response");
          }
          /*
           * 下载来源白名单：默认只允许与 baseUrl 同源；
           * 供应商把结果放在自有 OSS 上时必须**显式声明**主机（精确或 `*.suffix`），
           * https、禁重定向、限字节——这是"受限下载来源"，不是任意 URL 抓取。
           */
          const declaredHosts = config.imageUrlHosts ?? [];
          const sameOrigin = imageUrl.origin === baseUrl.origin;
          const hostAllowed =
            sameOrigin ||
            (imageUrl.protocol === "https:" &&
              declaredHosts.some((pattern) =>
                pattern.startsWith("*.")
                  ? imageUrl.hostname.toLowerCase().endsWith(pattern.slice(1))
                  : imageUrl.hostname.toLowerCase() === pattern
              ));
          if (!hostAllowed) {
            return failure("IMAGE_URL_NOT_ALLOWED", 502, "上游返回的图片地址不在受控源内。", undefined, "response");
          }
          /*
           * 凭据隔离（Astra R2）：供应商密钥只发给**声明它的那个源**。
           * 白名单只代表"允许从这里下载图片"，不代表那个主机有权收到我们的供应商凭据——
           * 尤其是通配后缀（CDN/OSS）绝不能作为凭据转发对象。异源一律匿名下载。
           */
          let fetched: Response;
          try {
            fetched = await fetchImpl(imageUrl.toString(), {
              method: "GET",
              redirect: "error",
              // 同源才带 Authorization；异源不带任何凭据、cookie 或额外头。
              headers: sameOrigin ? { authorization: `Bearer ${config.apiKey}` } : {},
              signal: controller.signal
            });
          } catch (error) {
            if (controller.signal.aborted) return abortResult();
            return failure(
              "IMAGE_UPSTREAM_ERROR",
              502,
              error instanceof Error ? error.message : String(error),
              config.apiKey,
              "network"
            );
          }
          if (!fetched.ok) {
            return failure("IMAGE_UPSTREAM_ERROR", 502, `图片地址返回 ${fetched.status}。`, undefined, "upstream");
          }
          const bytes = await readCapped(fetched, IMAGE_LIMITS.responseBytes);
          if (bytes === null) {
            return failure(
              "IMAGE_RESPONSE_TOO_LARGE",
              502,
              `图片超过 ${IMAGE_LIMITS.responseBytes} 字节。`,
              undefined,
              "response"
            );
          }
          const header = validateImageBytes(bytes);
          if (!header) {
            return failure("IMAGE_RESPONSE_INVALID", 502, "下载的图片未通过校验。", undefined, "response");
          }
          return { ok: true, bytes, mime: header.mime, model: config.model, configId: config.id };
        }

        return failure("IMAGE_RESPONSE_INVALID", 502, "上游响应既无 b64_json 也无 url。", undefined, "response");
      } finally {
        clearTimeout(timer);
        callerSignal?.removeEventListener("abort", onAbort);
      }
    }
  };
}
