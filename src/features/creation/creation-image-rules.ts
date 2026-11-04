/**
 * 图片提示的纯规则层：通用应用预算、画质与草稿校验。
 * 原资源标识/版本仅供 vendored 完整性校验和历史读取。
 *
 * 边界：
 * - 本文件**不得** import `node:fs` / `node:path`：客户端 UI 需要读取固定标识与
 *   `IMAGE_PROMPT_LIMITS` 并本地预检，这些常量与纯函数必须能安全打进浏览器 bundle；
 * - 读盘（读取 vendored 资源、逐文件核对 sha256、按小节提取）在
 *   `creation-image-skill.ts`，**仅服务端**；
 * - 自检**只拒绝、不清洗**：任何不合规草稿都返回稳定失败码，不做「改一改再接受」，
 *   也不顺手 trim/补默认值后返回。
 */

import { IMAGE_LIMITS } from "./creation-image-limits";

/** 上游 Skill 的固定标识与固定 commit（与 PROVENANCE.md 一一对应）。 */
export const IMAGE_SKILL_ID = "huashu-gpt-image";
export const IMAGE_SKILL_VERSION = "f5d53e2b4ac636de56beab5adb624c4cc01bdb8a";
export const IMAGE_SKILL_ADAPTER_VERSION = 1;

/** 画布约束及本应用的 prompt 容量上限。 */
export const IMAGE_PROMPT_LIMITS = {
  maxPromptChars: IMAGE_LIMITS.maxPromptChars,
  maxEdgePx: IMAGE_LIMITS.maxEdgePx,
  maxPixels: IMAGE_LIMITS.maxPixels
} as const;

export const IMAGE_QUALITIES = ["low", "medium", "high"] as const;

/** Seedream 5.0 Pro 官方 2K 档；亦落在 Lite/4.5 的像素范围内。 */
export const SEEDREAM_2K_SIZES = [
  "2048x2048", "2368x1776", "1776x2368", "2816x1584",
  "1584x2816", "2496x1664", "1664x2496", "3136x1344"
] as const;

export type ImageOutputFormat = "png" | "jpeg";

/** 只识别官方模型名；自定义 Endpoint ID 不推定支持未声明的参数。 */
export function isSeedreamModel(model: string): boolean {
  return /^doubao-seedream-/.test(model);
}

export function supportsInteractiveImageEdit(model: string): boolean {
  return /^doubao-seedream-5(?:-|\.)0-pro(?:-|$)/.test(model);
}

export function imageOutputFormats(model: string): readonly ImageOutputFormat[] {
  if (/^doubao-seedream-5(?:-|\.)0-(?:pro|lite)(?:-|$)/.test(model) ||
      /^doubao-seedream-5-0-\d{6}$/.test(model) || /^gpt-image-/.test(model)) return ["png", "jpeg"];
  return [];
}

/** 原图像素坐标，拒绝缺失、格式错误、零面积和越界；设计轮必须保留理解轮的坐标。 */
export function validImageEditBounds(
  instruction: string,
  source: { width: number; height: number },
  expectedInstruction?: string
): boolean {
  const boxes = (text: string) => [...text.matchAll(/<bbox>(\d+) (\d+) (\d+) (\d+)<\/bbox>/g)];
  const matches = boxes(instruction);
  if (!Number.isInteger(source.width) || !Number.isInteger(source.height) || !matches.length ||
      matches.length !== (instruction.match(/<\/?bbox\b/gi)?.length ?? 0) / 2) return false;
  if (!matches.every((match, index) => {
    const [left, top, right, bottom] = match.slice(1).map(Number);
    const description = instruction.slice(match.index! + match[0].length, matches[index + 1]?.index ?? instruction.length).trim();
    return description.length > 0 && left! >= 0 && top! >= 0 && left! < right! && top! < bottom! &&
      right! <= source.width && bottom! <= source.height;
  })) return false;
  return expectedInstruction === undefined ||
    JSON.stringify(matches.map(match => match.slice(1))) === JSON.stringify(boxes(expectedInstruction).map(match => match.slice(1)));
}

/** 图片提示设计的供应商结构化输出约束；执行端仍按当前配置复核尺寸。 */
export const DESIGN_IMAGE_RESULT_SCHEMA = {
  name: "creation_design_image",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["prompt", "negative", "size", "quality", "selfCheck"],
    properties: {
      prompt: { type: "string", maxLength: IMAGE_PROMPT_LIMITS.maxPromptChars },
      negative: { type: "string" },
      size: { type: "string" },
      quality: { type: "string", enum: [...IMAGE_QUALITIES] },
      selfCheck: { type: "array", minItems: 5, maxItems: 5, items: { type: "string" } }
    }
  }
} as const;

/** 当前提示设计结构约束：知识资源不改变这四个执行字段。 */
export const BASE_DESIGN_IMAGE_RESULT_SCHEMA = {
  name: "creation_design_image_base",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["prompt", "negative", "size", "quality"],
    properties: {
      prompt: { type: "string", maxLength: IMAGE_PROMPT_LIMITS.maxPromptChars },
      negative: { type: "string" },
      size: { type: "string" },
      quality: { type: "string", enum: [...IMAGE_QUALITIES] }
    }
  }
} as const;

/** 尺寸由当前服务配置决定；知识资源不能扩大或缩小能力白名单。 */
export function designImageResultSchema(sizes: readonly string[]) {
  return {
    ...BASE_DESIGN_IMAGE_RESULT_SCHEMA,
    schema: {
      ...BASE_DESIGN_IMAGE_RESULT_SCHEMA.schema,
      properties: {
        ...BASE_DESIGN_IMAGE_RESULT_SCHEMA.schema.properties,
        size: { type: "string", enum: [...sizes] }
      }
    }
  };
}

/**
 * R4：重构图覆盖的确定性判定（默认编辑偏好可被用户明确要求覆盖）。
 * instruction 命中任一明确重构/移动表述时，不再强加「保留构图/主体位置」。
 */
export const RECOMPOSITION_MARKERS = [
  "重构图", "重新构图", "重新安排构图", "安排构图", "改变构图", "换个构图", "换构图", "调整构图",
  "移动主体", "主体移动", "主体移", "挪动主体", "主体移到", "移到画面", "位置移到",
  "不保留构图", "不用保留构图", "不用保留原图构图", "不保留主体位置"
] as const;

export function requestsRecomposition(instruction: string): boolean {
  return RECOMPOSITION_MARKERS.some(marker => positiveInstruction(instruction, marker));
}

/** 精确的正向措辞；“不要裁剪/不改变构图”不能解除保留边界。 */
function positiveInstruction(instruction: string, marker: string): boolean {
  const text = instruction.toLowerCase();
  for (const match of text.matchAll(new RegExp(marker, "g"))) {
    const prefix = text.slice(Math.max(0, match.index! - 12), match.index).split(/[，。；、\n]/).at(-1)!;
    if (!/(不|别|勿|未|无须|无需|禁止|避免|保持|保留|防止|没有|without|no |not )/.test(prefix)) return true;
  }
  return false;
}

export function requestsCropping(instruction: string): boolean {
  return ["裁剪", "裁切", "裁掉", "剪裁", "crop"].some(marker => positiveInstruction(instruction, marker));
}

/** 自动编辑尺寸只在配置内选，按比例距离优先，等距选较大像素尺寸。 */
export function closestImageSize(sizes: readonly string[], source: { width: number; height: number }): string | undefined {
  if (!(source.width > 0 && source.height > 0)) return sizes[0];
  let bestDistance = Infinity;
  let bestPixels = 0;
  return sizes.reduce<string | undefined>((best, size) => {
    const [width, height] = size.split("x").map(Number);
    if (!(width! > 0 && height! > 0)) return best;
    const distance = Math.abs(Math.log((width! / height!) / (source.width / source.height)));
    const pixels = width! * height!;
    if (distance < bestDistance || (distance === bestDistance && pixels > bestPixels)) {
      bestDistance = distance;
      bestPixels = pixels;
      return size;
    }
    return best;
  }, undefined);
}

/**
 * 预设风格表：**id 稳定、中文标签唯一来源**。
 *
 * id 会随会话持久化（`imageOptions.style`），所以只增不改；中文标签同时用于
 * 界面显示与"视觉风格参考：X"这段出站提示（见 `creation-image-port.ts`），
 * 两处必须是同一句话，否则用户选的和模型看到的会不是一回事。
 */
export const IMAGE_STYLE_LABELS = {
  none: "不指定",
  // 基础主流
  "portrait-photo": "人像摄影",
  photo: "写实",
  film: "胶片风",
  anime: "动漫",
  "anime-jp": "日漫",
  "anime-kr": "韩漫",
  "comic-us": "美漫",
  "chinese-traditional": "国风",
  "ink-wash": "水墨",
  "oil-painting": "油画",
  watercolor: "水彩",
  sketch: "素描",
  "render-3d": "3D 渲染",
  cyberpunk: "赛博朋克",
  pixel: "像素风",
  chibi: "卡通 Q 版",
  fairytale: "童话梦幻",
  "concept-art": "概念设计",
  "minimal-line": "极简线条",
  "commercial-photo": "商业摄影",
  // 图生图快捷（AI 写真模块）
  business: "商务风",
  "retro-hk": "复古港风",
  "monet-garden": "莫奈花园",
  "clay-doll": "粘土玩偶",
  "romantic-light": "浪漫光影",
  "cyber-mech": "赛博机械",
  "new-chinese": "新中式",
  /*
   * 已从选择器下线的旧 id：老会话里可能还存着，校验照旧接受，
   * 否则重试一轮旧对话会因为"风格无效"直接失败。
   */
  illustration: "插画",
  memphis: "孟菲斯"
} as const;

export type ImageStyle = keyof typeof IMAGE_STYLE_LABELS;

/** 选择器里的分组（不含"不指定"与已下线的旧 id）。 */
export const IMAGE_STYLE_GROUPS: { title: string; styles: readonly ImageStyle[] }[] = [
  {
    title: "基础风格",
    styles: [
      "portrait-photo", "photo", "film", "anime", "anime-jp", "anime-kr", "comic-us",
      "chinese-traditional", "ink-wash", "oil-painting", "watercolor", "sketch", "render-3d",
      "cyberpunk", "pixel", "chibi", "fairytale", "concept-art", "minimal-line", "commercial-photo"
    ]
  },
  {
    title: "图生图快捷",
    styles: ["business", "retro-hk", "monet-garden", "clay-doll", "romantic-light", "cyber-mech", "new-chinese"]
  }
];

/** 可选风格（含"不指定"）：界面顺序即这个顺序。 */
export const IMAGE_STYLE_OPTIONS: readonly ImageStyle[] = ["none", ...IMAGE_STYLE_GROUPS.flatMap(group => group.styles)];

/** 未知 id 一律拒绝；已下线的旧 id 仍算已知（老会话可重试）。 */
export function isImageStyle(value: unknown): value is ImageStyle {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(IMAGE_STYLE_LABELS, value);
}

/**
 * 比例瓦片：像参考形态那样让用户挑**比例**而不是读 "2304x1728"。
 *
 * 只从该配置**真实声明**的尺寸里派生理例（`imageSizes`），派生不出的比例不会出现——
 * 宁可少给一个选项，也不给出一个会在图片路由被拒的尺寸。
 * 顺序：先竖构图，再方形，最后横构图（与常见生图面板一致）。
 */
export const IMAGE_RATIO_ORDER = ["9:16", "2:3", "3:4", "1:1", "4:3", "3:2", "16:9", "21:9"] as const;

/** "2304x1728" → "4:3"；非法尺寸返回 null（不猜）。 */
export function sizeRatio(size: string): string | null {
  const match = /^(\d{2,5})x(\d{2,5})$/.exec(size.trim());
  if (!match) return null;
  let a = Number(match[1]);
  let b = Number(match[2]);
  if (a <= 0 || b <= 0) return null;
  const gcd = (x: number, y: number): number => (y === 0 ? x : gcd(y, x % y));
  const divisor = gcd(a, b);
  a /= divisor;
  b /= divisor;
  // 超宽档沿用官方 21:9 标签；其余比例化简。
  if (a === 7 && b === 3) return "21:9";
  // 长宽比化简后超过 40 的（例如 4096x100 → 1024:25）不当作常见比例展示。
  if (a > 40 || b > 40) return null;
  return `${a}:${b}`;
}

/** 一个比例对应一个**声明过的**尺寸：同一比例出现多次时取先声明的那个。 */
export function ratioTiles(sizes: readonly string[]): { ratio: string; size: string }[] {
  const byRatio = new Map<string, string>();
  for (const size of sizes) {
    const ratio = sizeRatio(size);
    if (!ratio || byRatio.has(ratio)) continue;
    byRatio.set(ratio, size.trim());
  }
  const ordered = IMAGE_RATIO_ORDER.flatMap(ratio => {
    const size = byRatio.get(ratio);
    return size ? [{ ratio, size }] : [];
  });
  // 声明里的其它比例（不在常见顺序里）照样列出来，排在后面，不丢选项。
  const rest = [...byRatio.entries()]
    .filter(([ratio]) => !(IMAGE_RATIO_ORDER as readonly string[]).includes(ratio))
    .map(([ratio, size]) => ({ ratio, size }));
  return [...ordered, ...rest];
}

export type ImagePromptDraft = {
  prompt: string;
  negative: string;
  size: string;
  quality: (typeof IMAGE_QUALITIES)[number];
  /** Skill 模式的五项自检；基础模式（Skill 关闭）没有这一条。 */
  selfCheck?: string[];
};

export type ImagePromptCheck =
  | { ok: true; draft: ImagePromptDraft }
  | { ok: false; code: string; detail: string };

/** 草稿字段必须**恰好**是这五个：多一个字段也拒绝，避免模型夹带未审校的载荷。 */
const DRAFT_KEYS = ["prompt", "negative", "size", "quality", "selfCheck"] as const;

/** 至少一个 CJK 汉字（含扩展 A 与兼容区）。 */
const CJK_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** 上游红线 1.1 禁止的伪结构化 section header（大小写不敏感）。 */
const PSEUDO_SECTION_MARKERS = ["subject:", "style:", "style anchor:", "constraints:"];

/**
 * 上游禁用的执行层痕迹：代码围栏、命令替换、解释器、上游脚本/CLI/本地桥/后处理工具名。
 * 本项目图片执行走自己的服务端协议，提示里出现这些名字一律拒绝。
 */
const SCRIPT_MARKERS = [
  "```",
  "$(",
  "python",
  "scripts/",
  "bash ",
  "gen_via_",
  "extract_grid",
  "chroma_key",
  "contact_sheet",
  "chatgpt-web-bridge",
  "codex",
  "--ref",
  "sips",
  "magick"
];

function reject(code: string, detail: string): ImagePromptCheck {
  return { ok: false, code, detail };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isQuality(value: unknown): value is ImagePromptDraft["quality"] {
  return typeof value === "string" && (IMAGE_QUALITIES as readonly string[]).includes(value);
}

/** 恰好 5 条非空自检项：上游红线 4 的 CHECKPOINT 是五项，缺项等于没跑。 */
function isSelfCheck(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length === 5 &&
    value.every((item) => typeof item === "string" && item.trim().length > 0)
  );
}

/** 通用应用预算；具体供应商支持哪些尺寸由其配置白名单核对。 */
function sizeViolation(size: string): string | null {
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (!match) return "size 必须是 `宽x高` 形式的整数，例如 1024x1024。";

  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
    return "宽高必须是正整数。";
  if (width > IMAGE_PROMPT_LIMITS.maxEdgePx || height > IMAGE_PROMPT_LIMITS.maxEdgePx)
    return `每条边都必须 ≤ ${IMAGE_PROMPT_LIMITS.maxEdgePx}。`;
  if (width * height > IMAGE_PROMPT_LIMITS.maxPixels)
    return `总像素不得超过 ${IMAGE_PROMPT_LIMITS.maxPixels}。`;
  return null;
}

/**
 * 确定性自检（纯函数，无 IO）：上游红线 1 / 1.2 / 2 / 4 的可执行子集 + 画布约束。
 *
 * 检查顺序固定（结构 → selfCheck → quality → size → prompt），同一份输入永远同一失败码；
 * 通过时**原样**返回输入，不补字段、不裁剪。
 */
export type ImagePromptCheckOptions = {
  /**
   * R4：`selfCheck` 五条是 huashu-gpt-image 方法的输出约定，不是基础制图的成功条件。
   * 基础模式（requireSelfCheck: false）只**校验** prompt/negative/size/quality；
   * 模型习惯性带出的 selfCheck 会被忽略（不因多余字段拒绝，白话：只看执行需要的）。
   * 缺省保持 Skill 模式：恰好五字段。
   */
  requireSelfCheck?: boolean;
};

export function checkImagePromptDraft(value: unknown, options: ImagePromptCheckOptions = {}): ImagePromptCheck {
  const requireSelfCheck = options.requireSelfCheck !== false;
  if (!isPlainObject(value)) return reject("IMAGE_PROMPT_INVALID", "草稿必须是对象。");

  const keys = Object.keys(value);
  const coreKeys = DRAFT_KEYS.filter(key => key !== "selfCheck");
  if (requireSelfCheck) {
    if (keys.length !== DRAFT_KEYS.length || !DRAFT_KEYS.every((key) => Object.hasOwn(value, key))) {
      return reject(
        "IMAGE_PROMPT_INVALID",
        `草稿字段必须恰好是 ${DRAFT_KEYS.join(" / ")}，不接受额外或缺失字段。`
      );
    }
  } else {
    // 基础模式：四核心字段必须存在；selfCheck 若出现则忽略（不校验、不入草稿）。
    if (!coreKeys.every((key) => Object.hasOwn(value, key))) {
      return reject("IMAGE_PROMPT_INVALID", `草稿缺少基础字段：${coreKeys.filter(k => !keys.includes(k)).join(" / ")}。`);
    }
    if (keys.some(key => !DRAFT_KEYS.includes(key as typeof DRAFT_KEYS[number]))) {
      return reject("IMAGE_PROMPT_INVALID", "草稿包含未知字段，已拒绝。");
    }
  }

  const { prompt, negative, size, quality, selfCheck } = value as Record<string, unknown>;
  if (typeof prompt !== "string" || typeof negative !== "string" || typeof size !== "string") {
    return reject("IMAGE_PROMPT_INVALID", "prompt / negative / size 必须是字符串。");
  }
  if (requireSelfCheck && !isSelfCheck(selfCheck)) {
    return reject("IMAGE_PROMPT_SELFCHECK_MISSING", "selfCheck 必须是恰好 5 条非空字符串。");
  }
  if (!isQuality(quality)) {
    return reject("IMAGE_PROMPT_QUALITY_INVALID", `quality 必须是 ${IMAGE_QUALITIES.join(" / ")} 之一。`);
  }
  const violation = sizeViolation(size);
  if (violation) return reject("IMAGE_PROMPT_SIZE_INVALID", violation);

  const trimmedPrompt = prompt.trim();
  if (trimmedPrompt.length === 0) return reject("IMAGE_PROMPT_INVALID", "prompt 不能为空。");
  if (trimmedPrompt.length > IMAGE_PROMPT_LIMITS.maxPromptChars) {
    return reject(
      "IMAGE_PROMPT_TOO_LONG",
      `prompt 去空白后 ${trimmedPrompt.length} 字，超过 ${IMAGE_PROMPT_LIMITS.maxPromptChars} 字上限。`
    );
  }
  const lowered = trimmedPrompt.toLowerCase();
  if (lowered.includes("http://") || lowered.includes("https://")) {
    return reject("IMAGE_PROMPT_HAS_URL", "prompt 不得包含任何 URL。");
  }
  const pseudo = PSEUDO_SECTION_MARKERS.find((marker) => lowered.includes(marker));
  if (pseudo) {
    return reject("IMAGE_PROMPT_PSEUDO_SECTION", `prompt 不得包含伪 section header（命中 ${pseudo}）。`);
  }
  const script = SCRIPT_MARKERS.find((marker) => lowered.includes(marker));
  if (script) {
    return reject("IMAGE_PROMPT_HAS_SCRIPT", `prompt 不得包含代码围栏或脚本片段（命中 ${script}）。`);
  }
  if (!CJK_PATTERN.test(trimmedPrompt)) {
    return reject("IMAGE_PROMPT_NOT_CHINESE", "prompt 必须用中文写（至少一个汉字）。");
  }

  return { ok: true, draft: {
    prompt, negative, size, quality,
    ...(requireSelfCheck ? { selfCheck: selfCheck as string[] } : {})
  } };
}

/**
 * 选定图片参数后**实际发给对话模型的那句话**：
 * 「生成图片：<用户输入>，图片风格为<风格>，图片比例为<比例>」（比例为「自动」时不写）。
 *
 * 前端用它显示用户气泡（发出去什么就显示什么），适配层用它拼理解轮与设计轮的指令——
 * 必须是同一份实现，否则界面上显示的和真正发出去的会不一致。
 * 只用于"生成图片"；修图保留原图语义，不加这句。没选风格或没写内容时返回 undefined。
 */
export function composeImageInstruction(
  text: string,
  options?: { size?: string; style?: ImageStyle }
): string | undefined {
  const trimmed = text.trim();
  const style = options?.style;
  if (!trimmed || !style || style === "none") return undefined;
  const ratio = options?.size ? sizeRatio(options.size) : null;
  return `生成图片：${trimmed}，图片风格为${IMAGE_STYLE_LABELS[style]}${ratio ? `，图片比例为${ratio}` : ""}`;
}
