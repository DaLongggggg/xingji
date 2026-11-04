import { readSettingsDocument, resolveSettingsPaths } from "./model-settings-store";
/**
 * P9-04：服务端受控图片配置。
 *
 * 边界（与 `model-config.ts` 同一取舍）：
 * - apiKey 只从服务端环境变量读取，不进入客户端列表、响应、日志；
 * - 客户端只提交配置 ID，**不能**提交 baseUrl（否则就是开放图片代理）；
 * - 默认未启用：`XINGJI_AI_IMAGE_ENABLED` 必须显式为 "1"，且 AI 网关本身可用；
 * - 图片能力与文本模型能力互不派生：配置了文本模型不代表图片可用。
 */
import { createHash } from "node:crypto";
import { isBetaScopeActive, scopedEnvForModelConfig } from "./user-scope.ts";
import { isAiExecutionEnabled, readAiPermissions } from "./model-config";
import { IMAGE_LIMITS, IMAGE_SIZES } from "../../features/creation/creation-image-limits";
import { imageRuntimeConfigs } from "./model-settings-manager";

/** 图片能力总开关（默认关闭，必须显式设为 "1"）。 */
export const IMAGE_ENABLED_ENV = "XINGJI_AI_IMAGE_ENABLED";
/** 图片端点声明：JSON 数组，见 `loadImageConfigs`。 */
export const IMAGE_CONFIGS_ENV = "XINGJI_AI_IMAGE_CONFIGS";

/** 本期只支持 OpenAI 风格的 images 协议；其它种类在 resolve 时明确拒绝。 */
export type ImageApiKind = "openai-images";

export type ImageCapabilities = { generate: boolean; edit: boolean };

/** 可下发给浏览器/调用方的部分（绝不含 apiKey、apiKeyEnv 或带凭据的 baseUrl）。 */
export type PublicImageConfig = {
  id: string;
  label: string;
  model: string;
  apiKind: ImageApiKind;
  local: boolean;
  capabilities: ImageCapabilities;
  /** 见 `ImageConfigRecord.imageUrlHosts`（不参与公开列表：那会泄露下载拓扑）。 */
  imageUrlHosts?: string[];
  /**
   * 该配置**实际允许**的 size 列表（未声明时即内置三个），随公开列表下发。
   * 客户端要用它约束文本模型只产出本配置能执行的尺寸：否则模型默认给 1024x1024，
   * 而声明 ≥1920×1920 的配置（如 Ark Seedream）会在路由处被拒绝。
   */
  imageSizes: string[];
  /**
   * 该配置一次能接受几张**输入图**（参考图/图生图/多图融合共用）：未声明即 1。
   * 客户端用它约束"能选几张参考图"，服务端在路由处再校验一次。
   */
  maxSourceImages: number;
  editMode?: "edits-multipart" | "generations-image";
  imagesPath?: string;
  watermark?: boolean;
  /**
   * 非凭据配置指纹（`imageConfigDigest`）：随公开列表下发，客户端把它固定进任务计划；
   * 出站时服务端按已解析配置重新计算并比较，配置变化拒绝执行。
   */
  configDigest: string;
};

export type ResolvedImageConfig = PublicImageConfig & {
  baseUrl: string;
  apiKey: string;
  apiKeyEnv: string;
  omitResponseFormat?: boolean;
};

export type ImageConfigStore = {
  /** 是否声明了至少一条图片配置。 */
  enabled(): boolean;
  /** 可公开的配置列表（不含密钥/环境变量名）。 */
  listPublic(): PublicImageConfig[];
  /** 按 ID 解析出完整配置；未知 ID、缺密钥、非法端点都明确失败。 */
  resolve(id: string): ResolvedImageConfig;
};

export type EnvSource = Record<string, string | undefined>;

/** 解析后的原始配置记录：`apiKind` 此时仍是原始值，合法性留到 resolve 时判定。 */
export type ImageConfigRecord = {
  /**
   * 用户在本机设置页填写的密钥（**只存在于服务端解密后的内存记录**；
   * 从不进入公开投影、响应、日志或令牌）。存在时优先于 `apiKeyEnv` 环境引用。
   */
  credential?: { id: string; value: string };
  id: string;
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  /** 未声明时为默认 `"openai-images"`；不认识的取值保留原样以便 resolve 报错。 */
  apiKind: unknown;
  local: boolean;
  capabilities: ImageCapabilities;
  /**
   * 显式声明的**额外**图片下载主机（如供应商把结果放在自有 OSS 上）。
   * 只接受精确主机名或 `*.suffix` 形式；缺省为空 = 只允许与 baseUrl 同源（fail-closed）。
   */
  imageUrlHosts: string[];
  /** 该配置允许的 size 白名单（如 Ark Seedream 要求 ≥1920×1920）；缺省用内置三个。 */
  imageSizes: string[];
  /** 一次能接受的输入图张数上限；缺省 1（只接受单张），显式声明才放开多图。 */
  maxSourceImages?: number;
  /**
   * 编辑的协议变体（**显式声明**，不猜）：
   * - `edits-multipart`（默认）：OpenAI 风格 `POST {base}/v1/images/edits` multipart；
   * - `generations-image`：部分供应商（如火山方舟 Seedream）在同一 `images/generations` 端点上
   *   用顶层 `image`（data URL）字段做图生图/编辑。
   */
  editMode: "edits-multipart" | "generations-image";
  /** 请求里的 images 路径（缺省 `/v1/images/generations`；含版本段的 baseUrl 可显式覆盖）。 */
  imagesPath: string;
  /** 需要显式关闭供应商水印时声明（如 Ark 的 `watermark:false`）；未声明则不带该字段。 */
  watermark?: boolean;
  /**
   * 声明**不下发** `response_format`：
   * OpenAI 的 gpt-image 系列不接受该参数（总是返回内联 base64），带了会 400。
   * 未声明 = 按 OpenAI 兼容惯例下发 `response_format:"b64_json"`（能内联就不走临时 URL）。
   */
  omitResponseFormat?: boolean;
};

export class ImageConfigError extends Error {
  constructor(
    readonly code:
      | "IMAGE_DISABLED"
      | "IMAGE_CONFIG_UNKNOWN"
      | "IMAGE_KEY_MISSING"
      | "IMAGE_ENDPOINT_INVALID"
      | "IMAGE_API_KIND_UNSUPPORTED",
    detail: string
  ) {
    super(`${code}:${detail}`);
    this.name = "ImageConfigError";
  }
}

/**
 * 非凭据配置指纹（C1.7）：由实际制图模型/协议/路径等**非凭据字段**构成，不含密钥。
 * 计划在首个外部执行前固定它；出站时服务端用已解析配置重新计算并比较——
 * 配置 ID 相同但实际模型/协议等变化时拒绝执行（`IMAGE_CONFIG_CHANGED`），不静默换配置重放。
 * 客户端只需要携带这个不透明字符串（随公开配置列表下发），不参与计算。
 */
export function imageConfigDigest(config: {
  id: string;
  model: string;
  apiKind: string;
  imageSizes: readonly string[];
  maxSourceImages: number;
  editMode: string;
  imagesPath: string;
  watermark?: boolean;
  omitResponseFormat?: boolean;
}): string {
  return createHash("sha256")
    .update(JSON.stringify({
      id: config.id,
      model: config.model,
      apiKind: config.apiKind,
      imageSizes: [...config.imageSizes],
      maxSourceImages: config.maxSourceImages,
      editMode: config.editMode,
      imagesPath: config.imagesPath,
      ...(config.watermark !== undefined ? { watermark: config.watermark } : {}),
      ...(config.omitResponseFormat !== undefined ? { omitResponseFormat: config.omitResponseFormat } : {})
    }))
    .digest("hex");
}

const DEFAULT_CAPABILITIES: ImageCapabilities = { generate: true, edit: true };
const DEFAULT_API_KIND: ImageApiKind = "openai-images";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** 解析端点 URL：只允许 http/https，且不能内联凭据。 */
function parseEndpoint(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ImageConfigError("IMAGE_ENDPOINT_INVALID", `无法解析 baseUrl：${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ImageConfigError("IMAGE_ENDPOINT_INVALID", `只允许 http/https，收到 ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new ImageConfigError("IMAGE_ENDPOINT_INVALID", "baseUrl 不能内联凭据。");
  }
  return url;
}

/**
 * 受控出站校验：与文本网关同规则。
 * - 声明为 local 的端点必须是回环地址（防止把内网/公网地址伪装成本地服务）；
 * - 非回环端点必须 https，除非显式 `allowInsecureRemote`。
 */
function assertControlledEndpoint(
  baseUrl: string,
  local: boolean,
  allowInsecureRemote: boolean
): URL {
  const url = parseEndpoint(baseUrl);
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (local && !loopback) {
    throw new ImageConfigError(
      "IMAGE_ENDPOINT_INVALID",
      `${url.hostname} 被声明为本地但不是回环地址。`
    );
  }
  if (!loopback && url.protocol !== "https:" && !allowInsecureRemote) {
    throw new ImageConfigError("IMAGE_ENDPOINT_INVALID", "远程端点必须使用 https。");
  }
  return url;
}

/** 能力字段按布尔解析，非布尔一律退回默认值。 */
/**
 * 下载主机 allowlist：只接受主机名或 `*.suffix`，拒绝其它形状（不做正则、不接受端口/路径）。
 * 目的是"受限下载来源"，不是"任意 URL 抓取"。
 */
function parseUrlHosts(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ImageConfigError("IMAGE_CONFIG_UNKNOWN", "imageUrlHosts 必须是数组。");
  const hosts: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const host = entry.trim().toLowerCase();
    if (host.length === 0) continue;
    const bare = host.startsWith("*.") ? host.slice(2) : host;
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(bare))
      throw new ImageConfigError("IMAGE_CONFIG_UNKNOWN", "imageUrlHosts 只接受主机名或 *.suffix。");
    hosts.push(host);
  }
  return hosts;
}

/** 尺寸白名单：只接受 `宽x高` 形式；缺省由 provider 用内置三个。 */
function parseImageSizes(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ImageConfigError("IMAGE_CONFIG_UNKNOWN", "imageSizes 必须是数组。");
  const sizes: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !/^\d{2,5}x\d{2,5}$/.test(entry.trim()))
      throw new ImageConfigError("IMAGE_CONFIG_UNKNOWN", "imageSizes 只接受 `宽x高`。");
    sizes.push(entry.trim());
  }
  return sizes;
}

/** 输入图张数上限：缺省 1；显式声明才放开多图，范围 1..16。 */
function parseMaxSourceImages(value: unknown): number {
  if (value === undefined) return 1;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 16)
    throw new ImageConfigError("IMAGE_CONFIG_UNKNOWN", "maxSourceImages 必须是 1..16 的整数。");
  return value;
}

function parseEditMode(value: unknown): "edits-multipart" | "generations-image" {
  if (value === undefined) return "edits-multipart";
  if (value !== "edits-multipart" && value !== "generations-image")
    throw new ImageConfigError("IMAGE_CONFIG_UNKNOWN", "editMode 只能是 edits-multipart / generations-image。");
  return value;
}

function parseImagesPath(value: unknown): string {
  // Legacy records may use a host-only baseUrl and omit imagesPath. Keep the
  // original /v1 default; joinEndpoint removes a duplicate /v1 when baseUrl
  // already contains it.
  if (value === undefined) return "/v1/images/generations";
  if (typeof value !== "string" || !value.startsWith("/"))
    throw new ImageConfigError("IMAGE_CONFIG_UNKNOWN", "imagesPath 必须以 / 开头。");
  return value;
}

function parseCapabilities(value: unknown): ImageCapabilities {
  if (!value || typeof value !== "object") return { ...DEFAULT_CAPABILITIES };
  const candidate = value as { generate?: unknown; edit?: unknown };
  return {
    generate: typeof candidate.generate === "boolean" ? candidate.generate : true,
    edit: typeof candidate.edit === "boolean" ? candidate.edit : true
  };
}

/**
 * 环境变量声明受控图片配置：`XINGJI_AI_IMAGE_CONFIGS` 为 JSON 数组。
 * 缺失或空数组 → 无配置（store 关闭）；JSON 非法或缺必填字段 → IMAGE_CONFIG_UNKNOWN。
 * 错误信息不回显原始配置值（可能含端点或环境变量名）。
 */
export function loadImageConfigs(env: EnvSource): ImageConfigRecord[] {
  // T2a：beta 用户没有旧环境声明层——文档是唯一权威，env 声明零继承。
  if (isBetaScopeActive()) return [];
  const raw = env[IMAGE_CONFIGS_ENV];
  if (!raw || raw.trim().length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ImageConfigError("IMAGE_CONFIG_UNKNOWN", `${IMAGE_CONFIGS_ENV} 不是有效 JSON。`);
  }
  if (!Array.isArray(parsed)) {
    throw new ImageConfigError("IMAGE_CONFIG_UNKNOWN", `${IMAGE_CONFIGS_ENV} 必须是数组。`);
  }
  return parsed.map((item, index) => {
    const candidate = item as Partial<ImageConfigRecord> | null;
    if (
      !candidate ||
      typeof candidate.id !== "string" ||
      candidate.id.length === 0 ||
      typeof candidate.baseUrl !== "string" ||
      typeof candidate.model !== "string" ||
      typeof candidate.apiKeyEnv !== "string" ||
      candidate.apiKeyEnv.length === 0
    ) {
      throw new ImageConfigError(
        "IMAGE_CONFIG_UNKNOWN",
        `${IMAGE_CONFIGS_ENV} 第 ${index} 条配置缺少 id/baseUrl/model/apiKeyEnv。`
      );
    }
    return {
      id: candidate.id,
      baseUrl: candidate.baseUrl,
      model: candidate.model,
      apiKeyEnv: candidate.apiKeyEnv,
      apiKind: candidate.apiKind ?? DEFAULT_API_KIND,
      local: candidate.local === true,
      capabilities: parseCapabilities(candidate.capabilities),
      imageUrlHosts: parseUrlHosts(candidate.imageUrlHosts),
      imageSizes: parseImageSizes(candidate.imageSizes),
      maxSourceImages: parseMaxSourceImages(candidate.maxSourceImages),
      editMode: parseEditMode(candidate.editMode),
      imagesPath: parseImagesPath(candidate.imagesPath),
      ...(candidate.watermark !== undefined ? { watermark: candidate.watermark === true } : {}),
      ...(candidate.omitResponseFormat !== undefined
        ? { omitResponseFormat: candidate.omitResponseFormat === true }
        : {})
    };
  });
}

/**
 * 图片路由是否启用（默认关闭）。
 *
 * 必须在 AI 网关本身可用之上**再**要求 `XINGJI_AI_IMAGE_ENABLED=1`：
 * 文本配置可用不等于允许图片出站，也不等于允许编辑本地图片。
 */
/**
 * 读取当前生效的图片配置：本机加密文档存在时它是完整权威，否则沿用旧的环境声明。
 * 与文本侧同一条规则，保证两个页面配置同一份真相。
 */
export function loadManagedImageConfigs(env: EnvSource): ImageConfigRecord[] {
  const document = readSettingsDocument(resolveSettingsPaths(env));
  if (document) return imageRuntimeConfigs(document) as ImageConfigRecord[];
  return isBetaScopeActive() ? [] : loadImageConfigs(env);
}

export function isImageRouteEnabled(env: NodeJS.ProcessEnv = scopedEnvForModelConfig() as NodeJS.ProcessEnv): boolean {
  if (!isAiExecutionEnabled(env) || env[IMAGE_ENABLED_ENV] === "0") return false;
  try { return readAiPermissions(env).images; } catch { return false; }
}

export function createImageConfigStore(
  env: EnvSource,
  options: { allowInsecureRemote?: boolean } = {}
): ImageConfigStore {
  const records = loadManagedImageConfigs(env);

  return {
    enabled() {
      return records.length > 0;
    },
    listPublic() {
      // 只回传稳定标识与能力：不含 baseUrl、apiKeyEnv，避免泄露内网拓扑或密钥位置。
      // `imageSizes` 是尺寸白名单（不是拓扑/凭据），且客户端必须知道它才能产出可执行尺寸。
      return records.map((record) => ({
        id: record.id,
        label: record.model || record.id,
        model: record.model,
        apiKind: DEFAULT_API_KIND,
        local: record.local,
        capabilities: { ...record.capabilities },
        imageSizes: record.imageSizes.length > 0 ? [...record.imageSizes] : [...IMAGE_SIZES],
        // 客户端要据此约束"能选几张参考图"：给**实际可用**的上限（应用级 9 封顶），缺省 1。
        maxSourceImages: Math.min(record.maxSourceImages ?? 1, IMAGE_LIMITS.sourceImages),
        configDigest: imageConfigDigest({
          id: record.id,
          model: record.model,
          apiKind: DEFAULT_API_KIND,
          imageSizes: record.imageSizes.length > 0 ? record.imageSizes : [...IMAGE_SIZES],
          maxSourceImages: Math.min(record.maxSourceImages ?? 1, IMAGE_LIMITS.sourceImages),
          editMode: record.editMode,
          imagesPath: record.imagesPath,
          ...(record.watermark !== undefined ? { watermark: record.watermark } : {}),
          ...(record.omitResponseFormat !== undefined ? { omitResponseFormat: record.omitResponseFormat } : {})
        })
      }));
    },
    resolve(id) {
      const record = records.find((item) => item.id === id);
      if (!record) {
        throw new ImageConfigError("IMAGE_CONFIG_UNKNOWN", `未知的图片配置 ID：${id}`);
      }
      if (record.apiKind !== DEFAULT_API_KIND) {
        throw new ImageConfigError(
          "IMAGE_API_KIND_UNSUPPORTED",
          `配置 ${record.id} 声明了不支持的 apiKind。`
        );
      }
      assertControlledEndpoint(
        record.baseUrl,
        record.local,
        options.allowInsecureRemote === true
      );
      const managed = record.credential?.value;
      // T2a：beta 下零继承——env[apiKeyEnv] 回退仅用于非 beta（桌面单用户）路径。
      const apiKey = managed && managed.length > 0
        ? managed
        : (isBetaScopeActive() ? undefined : env[record.apiKeyEnv]);
      if (!apiKey || apiKey.length === 0) {
        // 缺密钥时明确不可用，绝不伪造调用成功。
        throw new ImageConfigError(
          "IMAGE_KEY_MISSING",
          `配置 ${id} 的凭据环境变量未设置。`
        );
      }
      return {
        id: record.id,
        label: record.model || record.id,
        model: record.model,
        apiKind: DEFAULT_API_KIND,
        local: record.local,
        capabilities: { ...record.capabilities },
        imageUrlHosts: [...record.imageUrlHosts],
        imageSizes: [...record.imageSizes],
        // 运行时也用同一档：声明超过应用级上限时按应用级来（provider 里还会再 min 一次）。
        maxSourceImages: Math.min(record.maxSourceImages ?? 1, IMAGE_LIMITS.sourceImages),
        editMode: record.editMode,
        imagesPath: record.imagesPath,
        ...(record.watermark !== undefined ? { watermark: record.watermark } : {}),
        ...(record.omitResponseFormat !== undefined
          ? { omitResponseFormat: record.omitResponseFormat }
          : {}),
        configDigest: imageConfigDigest({
          id: record.id,
          model: record.model,
          apiKind: DEFAULT_API_KIND,
          imageSizes: record.imageSizes.length > 0 ? record.imageSizes : [...IMAGE_SIZES],
          maxSourceImages: Math.min(record.maxSourceImages ?? 1, IMAGE_LIMITS.sourceImages),
          editMode: record.editMode,
          imagesPath: record.imagesPath,
          ...(record.watermark !== undefined ? { watermark: record.watermark } : {}),
          ...(record.omitResponseFormat !== undefined
            ? { omitResponseFormat: record.omitResponseFormat }
            : {})
        }),
        baseUrl: record.baseUrl,
        apiKey,
        apiKeyEnv: record.apiKeyEnv
      };
    }
  };
}
