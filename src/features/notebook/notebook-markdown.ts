import type { NotebookPageBlock } from "./notebook-model";

export const NOTEBOOK_MARKDOWN_VERSION = 1;

/**
 * 页面块 <-> Markdown 适配层（阶段 B）。
 *
 * 设计约束：
 * - 图片始终以稳定 asset ID 作为 Markdown 链接目标（`![说明](md-...)`），
 *   绝不把 Data URL / Base64 写进正文。渲染时由调用方经媒体适配器解析。
 * - 阶段 A 的纯文本进入编辑器时必须保持**字面含义**：星号、井号、下划线等
 *   会被 Markdown 解释的字符先转义，再交给编辑器，避免“*重点*”变成斜体。
 * - 只能在显式保存路径上使用，禁止在读取时静默改写旧内容。
 */

/** 项目既有的稳定资产引用格式（与 1.x 游记一致）。 */
export const ASSET_REFERENCE_PREFIX = "journal-photo://";

const MEDIA_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/** 由 assetId 生成持久化用的资产引用。 */
export function createAssetReference(assetId: string): string {
  return `${ASSET_REFERENCE_PREFIX}${assetId}`;
}

/**
 * 解析资产引用。只有明确带前缀且 id 合法时才返回 id，
 * 其余（外部 http 链接、其它 scheme、数据 URL）一律返回 undefined，
 * 避免把普通链接误当成本地资产。
 */
export function parseAssetReference(source: string): string | undefined {
  if (!source.startsWith(ASSET_REFERENCE_PREFIX)) return undefined;
  const assetId = source.slice(ASSET_REFERENCE_PREFIX.length);
  return MEDIA_ID_PATTERN.test(assetId) ? assetId : undefined;
}

/** 是否为可识别的图片引用（资产引用或外部链接）。 */
export function isDisplayableImageSource(source: string): boolean {
  return Boolean(parseAssetReference(source)) || /^https?:\/\//i.test(source);
}

/**
 * Markdown 中有特殊含义、需要转义以保证字面显示的字符。
 * 不含 `-`、`.`、`(` 等：它们只在特定上下文中特殊，普遍转义只会让正文变脏。
 */
const ESCAPABLE = /[\\`*_{}[\]#+!>|~]/g;

export function escapeMarkdownText(text: string): string {
  return text.replace(ESCAPABLE, (character) => `\\${character}`);
}

export function unescapeMarkdownText(text: string): string {
  return text.replace(/\\([\\`*_{}[\]#+!>|~])/g, "$1");
}

/**
 * 是否可作为媒体引用接受：新格式为 `journal-photo://<id>`；
 * 裸 assetId 为阶段 A 旧页面遗留格式，继续兼容，避免出现两套互不兼容的引用。
 */
function toMediaId(source: string): string | undefined {
  const referenced = parseAssetReference(source);
  if (referenced) return referenced;
  return MEDIA_ID_PATTERN.test(source) && !source.includes("/") ? source : undefined;
}

function escapeImageAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function readImageAttribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag);
  return (match?.[1] ?? match?.[2])?.replace(/&quot;/g, '"').replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function readImageDimension(tag: string, name: "width" | "height"): number | undefined {
  const raw = readImageAttribute(tag, name);
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 && value <= 10000 ? value : undefined;
}

/** 块 -> Markdown：文字转义，图片用 asset ID。 */
export function blocksToMarkdown(blocks: NotebookPageBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      const escaped = escapeMarkdownText(block.text.trim());
      if (escaped) parts.push(escaped);
      continue;
    }
    if (block.type === "unsupported-image") {
      // 原样写回，保证外部链接等不被破坏。
      parts.push(block.markdown);
      continue;
    }
    const caption = block.caption ? escapeMarkdownText(block.caption) : "";
    if (block.width || block.height) {
      const dimensions = `${block.width ? ` width="${block.width}"` : ""}${block.height ? ` height="${block.height}"` : ""}`;
      parts.push(`<img src="${createAssetReference(block.mediaId)}" alt="${escapeImageAttribute(block.caption)}"${dimensions} />`);
    } else {
      parts.push(`![${caption}](${createAssetReference(block.mediaId)})`);
    }
  }
  return parts.join("\n\n");
}

/** 预览、删除和块解析共用图片顺序；每次匹配独立，不共享正则游标。 */
function markdownImages(markdown: string) {
  return markdown.matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)|<img\b[^>]*\/?>/gi);
}

/** 只移除指定的一次图片引用，保留其余 Markdown 原文与格式。 */
export function removeMarkdownImage(markdown: string, position: number): string {
  if (!Number.isInteger(position) || position < 0) return markdown;
  let index = 0;
  for (const match of markdownImages(markdown)) {
    if (index++ !== position) continue;
    return markdown.slice(0, match.index) + markdown.slice(match.index + match[0].length);
  }
  return markdown;
}

/**
 * Markdown -> 块：按出现顺序提取图片与文字。
 * 文字保持字面含义（反转义）；图片只接受 asset ID，不解析 Base64/Data URL。
 */
export function markdownToBlocks(markdown: string): NotebookPageBlock[] {
  const blocks: NotebookPageBlock[] = [];
  let cursor = 0;
  let index = 0;

  const pushText = (raw: string) => {
    const text = unescapeMarkdownText(raw.trim());
    if (!text) return;
    index += 1;
    blocks.push({ id: `blk-md-text-${index}`, type: "text", text });
  };

  for (const match of markdownImages(markdown)) {
    pushText(markdown.slice(cursor, match.index));
    const isHtmlImage = match[0].startsWith("<");
    const caption = isHtmlImage
      ? readImageAttribute(match[0], "alt") ?? ""
      : unescapeMarkdownText(match[1] ?? "");
    const source = isHtmlImage ? readImageAttribute(match[0], "src") ?? "" : match[2] ?? "";
    const mediaId = toMediaId(source);
    if (mediaId) {
      const width = isHtmlImage ? readImageDimension(match[0], "width") : undefined;
      const height = isHtmlImage ? readImageDimension(match[0], "height") : undefined;
      index += 1;
      blocks.push({
        id: `blk-md-photo-${index}`,
        type: "photo",
        mediaId,
        caption: caption || "记录图片",
        ...(width ? { width } : {}),
        ...(height ? { height } : {})
      });
    } else {
      // 外部链接/Data URL：原样保留整段 Markdown，不转成媒体引用也不改写原文。
      index += 1;
      blocks.push({
        id: `blk-md-unsupported-${index}`,
        type: "unsupported-image",
        markdown: match[0]
      });
    }
    cursor = match.index + match[0].length;
  }
  pushText(markdown.slice(cursor));
  return blocks;
}

/**
 * 旧纯文本正文 -> 编辑器 Markdown。
 * 只做转义，不改写字面内容；读取路径不得调用（避免静默改写旧记录）。
 */
export function plainTextToMarkdown(text: string): string {
  return escapeMarkdownText(text);
}

/** 正文是否包含 Base64/Data URL（保存前自检，禁止写入正文）。 */
export function containsInlineBinary(markdown: string): boolean {
  return markdown.includes("data:") || /base64,/i.test(markdown);
}

/**
 * 021-B：把编辑器里的 Markdown 还原成块，并**尽量沿用原块 id**。
 *
 * 为什么要还原 id：连续编辑器里改一个字就整篇重排时，如果所有块都换新 id，
 * 就违背了“不因格式化重写全部块”的要求。这里按内容一一对应地复用原 id：
 * - 文字块：与原文按顺序逐字匹配则复用；
 * - 图片块：同一个媒体引用复用；
 * - 外部/不支持的图片：同一段 Markdown 复用。
 *
 * 这不是无损保证的全部：外部图片与历史缺图语义由 `checkMarkdownDraft` 负责，
 * 调用方在“正文与块都没变”时必须直接跳过重建（见 `handleSaveEdit`）。
 */
export function markdownToBlocksPreservingIds(
  markdown: string,
  original: NotebookPageBlock[]
): NotebookPageBlock[] {
  const parsed = markdownToBlocks(markdown);
  const textPool = new Map<string, string[]>();
  const photoPool = new Map<string, string[]>();
  const unsupportedPool = new Map<string, string[]>();
  for (const block of original) {
    if (block.type === "text") {
      const key = block.text.trim();
      textPool.set(key, [...(textPool.get(key) ?? []), block.id]);
      continue;
    }
    if (block.type === "photo") {
      photoPool.set(block.mediaId, [...(photoPool.get(block.mediaId) ?? []), block.id]);
      continue;
    }
    unsupportedPool.set(block.markdown, [...(unsupportedPool.get(block.markdown) ?? []), block.id]);
  }

  const take = (pool: Map<string, string[]>, key: string): string | undefined =>
    pool.get(key)?.shift();

  return parsed.map((block) => {
    if (block.type === "text") {
      const reused = take(textPool, block.text.trim());
      return reused ? { ...block, id: reused } : block;
    }
    if (block.type === "photo") {
      const reused = take(photoPool, block.mediaId);
      return reused ? { ...block, id: reused } : block;
    }
    const reused = take(unsupportedPool, block.markdown);
    return reused ? { ...block, id: reused } : block;
  });
}
