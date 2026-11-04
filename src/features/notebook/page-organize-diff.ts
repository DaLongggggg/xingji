/**
 * 正文前后预览的**纯数据投影**（不碰 DOM、不引入 diff 依赖）。
 *
 * 只比较已有 text block 的文本；图片块、unsupported-image 与块顺序不在变更范围。
 * 标题与 summary 即使模型返回也不进入预览：此投影不改标题、不持久化摘要。
 */
import type { OrganizePagePayload } from "@/features/ai/ai-proposal";

/** 展示用换行归一：CRLF → LF，并去掉首尾空白；只用于“是否有差异”的判断。 */
function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

export type OrganizeTextBlockView = {
  blockId: string;
  before: string;
  after: string;
  changed: boolean;
};

export type OrganizeTextView = {
  blocks: OrganizeTextBlockView[];
  /** 顺序与块身份与原文一致（本阶段结构不变）。 */
  orderedBlockIds: string[];
  changedCount: number;
  unchanged: boolean;
  /** 载荷里找不到对应原块的 blockId：仅用于诊断显示，正常路径不会出现。 */
  unknownBlockIds: string[];
};

export function buildOrganizeTextView(
  originalBlocks: readonly { id: string; type: string; text?: string }[],
  textBlocks: readonly { blockId: string; content: string }[]
): OrganizeTextView {
  const byId = new Map(textBlocks.map((block) => [block.blockId, block.content] as const));
  const views: OrganizeTextBlockView[] = [];
  const unknownBlockIds: string[] = [];
  const seen = new Set<string>();

  for (const block of originalBlocks) {
    if (block.type !== "text") continue;
    seen.add(block.id);
    const before = block.text ?? "";
    const after = byId.has(block.id) ? (byId.get(block.id) as string) : before;
    const changed = normalize(before) !== normalize(after);
    views.push({ blockId: block.id, before, after, changed });
  }
  for (const block of textBlocks) {
    if (!seen.has(block.blockId)) unknownBlockIds.push(block.blockId);
  }

  const changedCount = views.filter((view) => view.changed).length;
  return {
    blocks: views,
    orderedBlockIds: originalBlocks.map((block) => block.id),
    changedCount,
    unchanged: changedCount === 0,
    unknownBlockIds
  };
}

/** 从冻结载荷取正文文本（投影后的载荷不再带 title/summary）。 */
export function payloadTextBlocks(
  payload: OrganizePagePayload
): { blockId: string; content: string }[] {
  return payload.textBlocks.map((block) => ({ ...block }));
}
