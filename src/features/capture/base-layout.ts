import { createCaptureId, type CaptureMedia, type CaptureMessage } from "./capture-model";
import { blocksToMarkdown, markdownToBlocks } from "@/features/notebook/notebook-markdown";
import type { NotebookPageBlock } from "@/features/notebook/notebook-model";

export const BASE_LAYOUT_VERSION = 1;

/**
 * 基础排版：确定性本地模板，把选中的原始记录整理成一页图文草稿。
 * 不调用模型、不模拟生成过程、不声称 AI 生成。
 * 只读取原始记录，不修改它们；重复排版只会得到新草稿。
 */
export type BaseLayoutResult = {
  version: number;
  title: string;
  blocks: NotebookPageBlock[];
  /** 生成草稿的时间；用于说明这是本地排版结果。 */
  generatedAt: string;
  /** 参与排版的原始记录 ID，便于回溯来源。 */
  sourceMessageIds: string[];
  usedMediaIds: string[];
};

function firstLine(text: string, fallback: string): string {
  const line = text
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item.length > 0);
  if (!line) return fallback;
  return line.slice(0, 24);
}

export function buildBaseLayout(
  messages: CaptureMessage[],
  options: { title?: string; generatedAt?: string } = {}
): BaseLayoutResult {
  // 按时间正序排版，让笔记本读起来是时间线。
  const ordered = [...messages].sort((left, right) =>
    left.capturedAt.localeCompare(right.capturedAt)
  );
  const parts: string[] = [];
  const usedMediaIds: string[] = [];

  ordered.forEach((message, index) => {
    const text = message.text.trim();
    if (text) {
      // 每条记录作为一个段落，保留原始换行；不添加会改变字面含义的 Markdown 语法。
      parts.push(index === 0 ? text : `\n\n${text}`);
    }
    const mediaRefs = message.mediaIds.map((mediaId) => {
      usedMediaIds.push(mediaId);
      return `![记录图片](${mediaId})`;
    });
    if (mediaRefs.length > 0) {
      parts.push(`\n\n${mediaRefs.join("\n\n")}`);
    }
  });

  const markdown = parts.join("").trim();
  // 通过 Markdown 适配层转换成块：文字保持字面含义，图片仍是稳定 asset ID 引用。
  const blocks = markdownToBlocks(markdown);
  const title = options.title?.trim() || firstLine(ordered[0]?.text ?? "", "基础排版草稿");

  return {
    version: BASE_LAYOUT_VERSION,
    title,
    blocks,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    sourceMessageIds: ordered.map((message) => message.id),
    usedMediaIds
  };
}

/** 基础排版预览用的 Markdown 文本（预览与保存使用同一份内容）。 */
export function baseLayoutMarkdown(result: BaseLayoutResult): string {
  return blocksToMarkdown(result.blocks);
}

/** 生成一条排版草稿记录，便于与原始记录区分保存。 */
export function createLayoutDraftId(): string {
  return createCaptureId("draft");
}

export function mediaById(media: CaptureMedia[]): Map<string, CaptureMedia> {
  return new Map(media.map((item) => [item.id, item] as const));
}
