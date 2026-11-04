/**
 * P9-04：客户端图片端口的共用构件（R1 起执行链路由统一图片执行器承载）。
 *
 * 一次图片操作的分步职责：
 * 1. 文本模型按基础方法或本次实际加载的知识写出图像提示，
 *    客户端用 `finalizeDesignedPrompt`（同一套确定性规则）复核、合并保留约束/风格并核定尺寸，
 *    **才**发图片请求（见 `workbench-image-executor.ts` + `/api/ai/image`）；
 * 2. `POST /api/ai/image`（服务端显式协议）拿回图片字节，客户端**真实解码**校验尺寸/像素。
 *
 * 这里只保留提示定稿、base64 与提示解析的共用构件；提示设计请求与出站请求
 * 由统一执行器分步完成（快照先落库再出站），不再有第二套"设计+出站一体"路径。
 *
 * 边界：Skill 经受控读取及服务端摘要核对注入，不持有任何 key，
 * 不执行上游脚本，不请求任意 URL；校验失败、超时、取消都返回明确失败码。
 */
import {
  IMAGE_STYLE_LABELS,
  closestImageSize,
  requestsRecomposition,
  requestsCropping,
  type ImagePromptCheck,
  type ImagePromptDraft,
  type ImageStyle
} from "./creation-image-rules";

/** 送文本模型设计图像提示的输入：编辑带源图身份，生成带参考图张数。 */
export type DesignPromptInput =
  | {
      mode: "edit";
      instruction: string;
      photoId: string;
      sourceVersionId: string;
      /** 本次图片配置允许的 size（模型只能从这里选）。 */
      allowedSizes: readonly string[];
      promptOptions?: { size?: string; style?: ImageStyle; quality?: ImagePromptDraft["quality"] };
      signal?: AbortSignal;
    }
  | {
      mode: "generate";
      instruction: string;
      allowedSizes: readonly string[];
      /** 本次带了几张参考图（>0 时提示必须写成"参考/融合这几张图"，不能当成凭空生成）。 */
      sourceCount?: number;
      promptOptions?: { size?: string; style?: ImageStyle; quality?: ImagePromptDraft["quality"] };
      signal?: AbortSignal;
    };

/** 保留格式失败的归属；不能把无效 JSON 变成 null 后误报为对象自检失败。 */
export function parseImagePromptContent(content: string): { ok: true; value: Record<string, unknown> } | { ok: false; detail: string } {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return { ok: false, detail: "提示设计模型没有返回有效 JSON；本张尚未调用制图服务。" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { ok: false, detail: `提示设计模型返回了${value === null ? "空值" : Array.isArray(value) ? "数组" : typeof value === "string" ? "字符串" : "非对象值"}，需要提示词对象；本张尚未调用制图服务。` };
  return { ok: true, value: value as Record<string, unknown> };
}

/**
 * 设计结果定稿（共用链路，R1 前是 `runImagePort` 的第一步）：
 * 解析 → 同一套自检复核 → 合入保留约束（edit）→ 合入风格提示 → 合入 negative → 核定尺寸。
 * 返回的 `draft` 即出站用的最终提示/尺寸/质量——执行器把它固化为 `promptSnapshot`。
 */
export function finalizeDesignedPrompt(input: {
  /** 设计模型的原始 JSON 正文。 */
  content: string;
  mode: "edit" | "generate";
  interactiveEdit?: boolean;
  allowedSizes: readonly string[];
  promptOptions?: { size?: string; style?: ImageStyle; quality?: ImagePromptDraft["quality"] };
  checkPrompt: (value: unknown, options?: { requireSelfCheck?: boolean }) => ImagePromptCheck;
  /** R4：Skill 关闭时走基础校验（无 selfCheck 五条要求）。 */
  requireSelfCheck?: boolean;
  /** R4：用户的原始指令文本（重构图覆盖判定用；缺省用草稿 prompt）。 */
  instructionOverride?: string;
  /** 来自原始用户要求，不能由设计模型/Skill 的措辞扩大授权。 */
  allowRecomposition?: boolean;
  allowCropping?: boolean;
}): { ok: true; draft: ImagePromptDraft } | { ok: false; code: string; detail: string } {
  const { mode, allowedSizes, promptOptions, checkPrompt } = input;
  const checkOptions = { requireSelfCheck: input.requireSelfCheck !== false };
  const parsed = parseImagePromptContent(input.content);
  if (!parsed.ok) return { ok: false, code: "IMAGE_PROMPT_INVALID", detail: parsed.detail };
  // 已知参数由应用提供：显式选择优先；未固定时接受配置内的设计尺寸，非法草稿尺寸回退配置默认。
  const proposedSize = typeof parsed.value.size === "string" && allowedSizes.includes(parsed.value.size) ? parsed.value.size : undefined;
  let size = promptOptions?.size ?? proposedSize ?? allowedSizes[0];
  if (mode === "edit" && size && !promptOptions?.size) {
    const [width, height] = size.split("x").map(Number);
    size = closestImageSize(allowedSizes, { width: width!, height: height! }) ?? size;
  }
  if (!size || !allowedSizes.includes(size))
    return { ok: false, code: "IMAGE_PROMPT_SIZE_NOT_ALLOWED", detail: "所选尺寸不在本次制图配置的可用列表中；本张尚未调用制图服务。" };
  const checked = checkPrompt({ ...parsed.value, size,
    ...(promptOptions?.quality ? { quality: promptOptions.quality } : {}) }, checkOptions);
  if (!checked.ok)
    return {
      ok: false,
      code: checked.code,
      detail: `图像提示未通过自检：${checked.detail}；本张尚未调用制图服务。`
    };
  /*
   * 保留原图构图/主体位置是**默认编辑偏好**，可被用户明确的重构图/移动主体要求覆盖（R4 验收）。
   * 覆盖判定是代码确定性规则（RECOMPOSITION_MARKERS），不是语义模型判断。
   */
  // 覆盖判定以**用户原始指令**（本项要求）优先；缺省回退草稿 prompt。
  const userInstruction = typeof input.instructionOverride === "string" && input.instructionOverride.trim()
    ? input.instructionOverride
    : (typeof (parsed.value as { prompt?: unknown }).prompt === "string" ? String((parsed.value as { prompt?: unknown }).prompt) : "");
  const preservationApplies = mode === "edit" && !(input.allowRecomposition ?? requestsRecomposition(userInstruction));
  const allowCropping = input.allowCropping ?? requestsCropping(userInstruction);
  if (mode === "edit" && !allowCropping && requestsCropping(checked.draft.prompt))
    return { ok: false, code: "IMAGE_PROMPT_CROP_NOT_AUTHORIZED", detail: "提示设计加入了用户未授权的裁剪；本张尚未调用制图服务，请重试提示设计。" };
  const preservation = "保留原图构图、地标、主体位置不变";
  const withPreservation = preservationApplies && !checked.draft.prompt.includes(preservation)
    ? checkPrompt({ ...checked.draft, prompt: `${checked.draft.prompt.trim()}；${preservation}。` }, checkOptions)
    : checked;
  if (!withPreservation.ok) return { ok: false, code: withPreservation.code, detail: `原图保留约束未通过自检：${withPreservation.detail}` };
  const fullFrame = mode === "edit" && !allowCropping
    ? checkPrompt({ ...withPreservation.draft, prompt: `${withPreservation.draft.prompt.trim()}；完整保留原照片四边及全部画面内容，禁止裁剪、截边、拉伸；输出比例不同时扩展画布容纳完整原图，不以裁剪填满画布。` }, checkOptions)
    : withPreservation;
  if (!fullFrame.ok) return { ok: false, code: fullFrame.code, detail: fullFrame.detail };
  const bounded = input.interactiveEdit
    ? checkPrompt({ ...fullFrame.draft, prompt: `${fullFrame.draft.prompt.trim()}；仅修改上述 bbox 框内区域；框外严格保留原图所有像素、纹理、色彩和细节，不重绘、美化或添加滤镜。` }, checkOptions)
    : fullFrame;
  if (!bounded.ok) return { ok: false, code: bounded.code, detail: bounded.detail };
  const style = promptOptions?.style;
  // 中文标签与界面用的是同一份：用户选的和模型看到的必然一致。
  const hint = style && style !== "none" ? IMAGE_STYLE_LABELS[style] : undefined;
  const withStyle = hint && !bounded.draft.prompt.includes(hint)
    ? checkPrompt({ ...bounded.draft,
      prompt: `${bounded.draft.prompt.trim()}；${input.interactiveEdit ? "仅框内" : ""}视觉风格参考：${hint}；若与用户明确要求、禁止事项或原图保留边界冲突，以这些要求为准。` }, checkOptions)
    : bounded;
  if (!withStyle.ok) return { ok: false, code: withStyle.code, detail: `风格约束未通过自检：${withStyle.detail}` };
  const merged = mergeNegativeIntoPrompt(withStyle.draft, checkPrompt, checkOptions);
  if (!merged.ok) return { ok: false, code: merged.code, detail: merged.detail };
  const draft = merged.draft;
  return { ok: true, draft };
}


/**
 * 把经校验的 `negative` 合入最终提示，并**用同一套自检规则**复核合并结果。
 *
 * 为什么合并而不是丢弃：`negative` 是"不要出现什么"的保留约束，图片模型只能从提示里读到它；
 * 为什么复核：合并会加长提示，可能超过应用字数上限或引入 URL/伪 section，必须与原文同一把尺子。
 * 空约束原样返回（不凭空加"避免："）。
 */
export function mergeNegativeIntoPrompt(
  draft: ImagePromptDraft,
  checkPrompt: (value: unknown, options?: { requireSelfCheck?: boolean }) => ImagePromptCheck,
  options: { requireSelfCheck?: boolean } = {}
): { ok: true; draft: ImagePromptDraft } | { ok: false; code: string; detail: string } {
  const negative = draft.negative.trim();
  if (negative.length === 0) return { ok: true, draft };
  const merged: ImagePromptDraft = { ...draft, prompt: `${draft.prompt.trim()}；避免：${negative}` };
  const rechecked = checkPrompt(merged, options);
  if (!rechecked.ok)
    return {
      ok: false,
      code: rechecked.code,
      detail: `合入保留约束后未通过自检：${rechecked.detail}`
    };
  return { ok: true, draft: rechecked.draft };
}

/** 浏览器侧 base64 → Blob（分块，避免超长字符串一次性展开）。 */
export function base64ToBlob(base64: string, mime: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mime });
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 8192)
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(binary);
}
