/**
 * P9-04：图片执行能力的**共享上限**（客户端与服务端都读这一份，避免两处漂移）。
 *
 * 这里只有常量：客户端用它做发送前的源图字节/尺寸预算与返回图校验，
 * 服务端 `src/server/ai/image-provider.ts` 复用同一份做协议级硬限制。
 * 不含任何 IO，客户端 bundle 可安全导入。
 */
/**
 * base64 文本**实际解码后的字节数**（含 `=` 填充修正）。
 * 预算按解码后的文件字节计算，不能直接把 base64 字符数当作文件大小。
 */
export function decodedBase64Bytes(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

const SOURCE_BATCH_BYTES = 200 * 1024 ** 2;

export const IMAGE_LIMITS = {
  /** 服务端接受的源图字节上限（发送前也要在客户端拦一次）。 */
  sourceBytes: 20 * 1024 ** 2,
  /** 服务端接受的单张返回图字节上限。 */
  responseBytes: 20 * 1024 ** 2,
  /** 单次请求最多几张输入图（多图生成一张新图时按这个上限拦）。 */
  sourceImages: 9,
  /**
   * 单次模型请求所有输入图的合计文件字节。应用上限，与供应商能力分开：
   * 合计预算 200MiB；当前单图 20MiB、最多 9 张，因此实际最多 180MiB。
   * 逐张编辑是多次独立请求，不合并成一批。
   * 超限明确拒绝，修图输入不重编码。供应商仍可有更严格的格式/尺寸/张数限制。
   */
  sourceBytesTotal: SOURCE_BATCH_BYTES,
  /** 完整 JSON 请求体预算：每张分别 base64 编码的填充 + 1MiB 包装余量。 */
  requestBodyBytes: Math.ceil(SOURCE_BATCH_BYTES * 4 / 3) + 9 * 4 + 1024 ** 2,
  /**
   * 内联 base64 响应的**原始字节**上限：
   * `responseBytes` 是解码后的图片字节，base64 会膨胀 4/3，再留 1 MiB 给 JSON 包装与其它字段。
   */
  responseBodyBytes: Math.ceil((20 * 1024 ** 2) * 4 / 3) + 1024 ** 2,
  /**
   * 单次图片请求超时（毫秒）。
   * 千问AI平台官方建议"图像生成耗时较长，客户端超时从 600 秒起配置"，
   * 千问/方舟/OpenAI 的慢档模型都可能超过两分钟，因此按官方建议取值。
   * 注意：工作台 Agent 另有单轮墙钟上限（60 秒，有界步数），
   * 慢模型的生图请直接用创作页，别指望塞进 Agent 的一轮里。
   */
  timeoutMs: 600_000,
  /** 应用级上限；Skill 按信息密度判断，不规定统一硬字数。 */
  maxPromptChars: 10_000,
  /** 返回图单边与总像素上限（客户端真实解码后再判一次）。 */
  maxEdgePx: 12_000,
  maxPixels: 40_000_000
} as const;

/**
 * 项目输出尺寸档位（协议白名单）。注意与供应商原生能力的区别：
 * - gpt-image-2 原生支持 16 働数任意分辨率（比例 1:3..3:1，上限 3840×2160，>2560×1440 为实验档）；
 * - 方舟 Seedream 按预设像素档位（见 model-presets 各配置声明的 imageSizes）。
 * 本清单是**项目自己的**三档边界，只用于缺省与校验，不代表供应商上限。
 */
export const IMAGE_SIZES = ["1024x1024", "1024x1536", "1536x1024"] as const;
export type ImageSize = (typeof IMAGE_SIZES)[number];

/**
 * `POST /api/ai/image` 请求体的**唯一字段清单**：服务端按它拒绝未知字段，客户端按它组包。
 * 两边共用这一份，避免"客户端发 `source`、路由只认 `sourceImage`"这类改名漂移
 * （曾经真实发生过：UI 修图路径因此 400，而 mock 掉的 e2e 看不见）。
 * R1：`identity` 是新工作台执行的必带身份信封（没有可绕过尝试记录的匿名执行分支）。
 *
 * 注意：这里**有意不含** `input_fidelity`——OpenAI 官方契约（2026-10 核对）：
 * gpt-image-2 必须省略该参数（原生始终高保真读入）；gpt-image-1 / 1.5 支持 low/high、
 * 默认 low，显式 high 会显著增加输入 token 成本。当前对所有 gpt-image 型号都不下发；
 * 若未来为 1/1.5 启用 high，须作为配置声明并随图片许可文案向用户明示。
 */
export const IMAGE_REQUEST_FIELDS = [
  "configId",
  "mode",
  "prompt",
  "size",
  "quality",
  "outputFormat",
  // 输入图是**数组**：编辑恰好一张，生成 0..N 张（N>1 = 用多张图生成一张新图）。
  "sourceImages",
  "identity"
] as const;

export const IMAGE_QUALITIES = ["low", "medium", "high"] as const;
export type ImageQuality = (typeof IMAGE_QUALITIES)[number];
