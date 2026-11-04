import {
  containsInlineBinary,
  markdownToBlocks,
  markdownToBlocksPreservingIds
} from "./notebook-markdown";
import type { NotebookMedia, NotebookPageBlock } from "./notebook-model";

/**
 * Markdown 编辑草稿的持久化校验（纯函数，便于测试）。
 *
 * 规则（Astra 边界）：
 * - 正文禁止包含 Base64/Data URL 或临时 blob 地址：这些不能作为持久化资产标识。
 * - **新增**的无效资产引用必须拒绝保存（可能是错字或被破坏的引用）。
 * - 页面原有、本编辑器无法解析的引用（旧页面缺失媒体）保留引用并给出警告，
 *   允许保存无关的文字修改，不静默删图。
 * - 外部图片链接不下载、不转成本地媒体，原样保留并提示。
 */
export type MarkdownDraftCheck =
  | {
      ok: true;
      blocks: NotebookPageBlock[];
      /** 本地无法解析但予以保留的引用。 */
      missingMediaIds: string[];
      /** 原样保留的外部/不支持图片源数量。 */
      unsupportedCount: number;
      warnings: string[];
    }
  | { ok: false; error: string };

export function checkMarkdownDraft(
  markdown: string,
  knownMediaIds: Iterable<string>,
  options: {
    preexistingMissingIds?: Iterable<string>;
    /** 021-B：原块列表；给了就尽量沿用原块 id，避免整篇重排换身份。 */
    originalBlocks?: NotebookPageBlock[];
  } = {}
): MarkdownDraftCheck {
  if (containsInlineBinary(markdown) || markdown.includes("blob:")) {
    return {
      ok: false,
      error: "正文包含 Base64 或临时地址，未保存；请用编辑器插图按钮重新插入。"
    };
  }

  const known = new Set(knownMediaIds);
  const preexisting = new Set(options.preexistingMissingIds ?? []);
  const blocks = options.originalBlocks
    ? markdownToBlocksPreservingIds(markdown, options.originalBlocks)
    : markdownToBlocks(markdown);
  const photoBlocks = blocks.filter(
    (block): block is Extract<NotebookPageBlock, { type: "photo" }> => block.type === "photo"
  );
  const missingMediaIds = photoBlocks
    .map((block) => block.mediaId)
    .filter((mediaId) => !known.has(mediaId));
  // 只有“新出现”的无效引用才拒绝保存。
  const introduced = missingMediaIds.filter((mediaId) => !preexisting.has(mediaId));
  if (introduced.length > 0) {
    return {
      ok: false,
      error: `有 ${introduced.length} 张图片引用无法解析，未保存；请重新插入后再保存。`
    };
  }

  const unsupportedCount = blocks.filter((block) => block.type === "unsupported-image").length;
  const warnings: string[] = [];
  if (missingMediaIds.length > 0) {
    warnings.push(
      `本页有 ${missingMediaIds.length} 张图片引用在原存储中缺失；已保留引用未删除，图片仍无法显示。`
    );
  }
  if (unsupportedCount > 0) {
    warnings.push(`本页有 ${unsupportedCount} 处外部或不支持的图片源；按决策不下载，已原样保留。`);
  }

  return { ok: true, blocks, missingMediaIds, unsupportedCount, warnings };
}

/** 已知媒体 = 已保存媒体 + 本次待写入图片。 */
export function collectKnownMediaIds(stored: readonly (Omit<NotebookMedia, "blob"> & { blob?: Blob })[], pending: readonly { id: string }[]): string[] {
  return [...stored.map((item) => item.id), ...pending.map((item) => item.id)];
}

/**
 * 页面原有引用中无法解析的资产 id。
 * 只统计已知的旧版图片字段（asset 引用与阶段 A 裸 assetId），
 * 不碰外部链接与普通文本。
 */
export function collectPreexistingMissingIds(
  markdown: string,
  knownMediaIds: Iterable<string>
): string[] {
  const known = new Set(knownMediaIds);
  return markdownToBlocks(markdown)
    .filter(
      (block): block is Extract<NotebookPageBlock, { type: "photo" }> => block.type === "photo"
    )
    .map((block) => block.mediaId)
    .filter((mediaId) => !known.has(mediaId));
}
