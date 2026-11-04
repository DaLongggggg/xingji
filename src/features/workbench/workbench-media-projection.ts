import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { NATIVE_SEARCH_RESULT, type NativeSearchResult } from "@/features/ai/native-search-contract";
import type { WorkbenchMessage } from "./workbench-types";
import type { MarkdownDisplays } from "./workbench-markdown-documents";

export type WorkbenchSearchImage = NonNullable<NativeSearchResult["images"]>[number];
/** AST source offsets identify the one occurrence assigned to this Markdown block. */
export type MarkdownImageDelivery = ReadonlyMap<number, WorkbenchSearchImage>;
type AnswerBlock = { id: string; text: string };
type SearchMediaProjection = {
  images: WorkbenchSearchImage[];
  markdown: Map<string, MarkdownImageDelivery>;
  remainingImages: WorkbenchSearchImage[];
};
// Store updates replace tools/messages. Weak keys release these render projections with their owners.
const noImages: WorkbenchSearchImage[] = [];
const imagesByTools = new WeakMap<NonNullable<WorkbenchMessage["tools"]>, WorkbenchSearchImage[]>();
const projectionByMessage = new WeakMap<WorkbenchMessage, {
  tools: WorkbenchMessage["tools"]; blocks: AnswerBlock[]; documents?: MarkdownDisplays; projection: SearchMediaProjection;
}>();

type MarkdownNode = {
  type: string;
  url?: string;
  identifier?: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number } };
};

export function searchImageIdentity(image: WorkbenchSearchImage): string {
  return JSON.stringify([image.url, image.sourceUrl]);
}

export function uniqueSearchImages(images: readonly WorkbenchSearchImage[]): WorkbenchSearchImage[] {
  const unique = new Map<string, WorkbenchSearchImage>();
  for (const image of images) {
    const key = searchImageIdentity(image);
    if (!unique.has(key)) unique.set(key, image);
  }
  return [...unique.values()];
}

/** A message owns its actual successful results; another reply never grants image permission. */
export function messageSearchImages(message?: WorkbenchMessage): WorkbenchSearchImage[] {
  const tools = message?.tools;
  if (!tools) return noImages;
  const cached = imagesByTools.get(tools);
  if (cached) return cached;
  const images: WorkbenchSearchImage[] = [];
  for (const tool of tools) {
    if (tool.name !== "web_search" || tool.ok !== true || tool.cancelled) continue;
    const parsed = NATIVE_SEARCH_RESULT.safeParse(tool.search);
    if (parsed.success && parsed.data.sources.length) images.push(...parsed.data.images ?? []);
  }
  const unique = uniqueSearchImages(images);
  imagesByTools.set(tools, unique);
  return unique;
}

function normalizedUrl(value: string): string {
  try { return new URL(value).href; } catch { return value; }
}

export function findSearchImage(images: readonly WorkbenchSearchImage[], url: string): WorkbenchSearchImage | undefined {
  const normalized = normalizedUrl(url);
  return images.find(image => normalizedUrl(image.url) === normalized)
    ?? images.find(image => !!image.thumbnailUrl && normalizedUrl(image.thumbnailUrl) === normalized);
}

function imageReferences(text: string): { offset: number; url: string }[] {
  // Inline, full/collapsed/shortcut reference images all start with literal ![ in CommonMark.
  // This is only a conservative absence check; escapes, code and actual ownership still use the AST.
  if (!text.includes("![")) return [];
  const references: { offset: number; url: string }[] = [];
  const identifier = (value: string) => value.trim().replace(/[\t\r\n ]+/g, " ").toUpperCase();
  const collect = () => (tree: MarkdownNode) => {
    const definitions = new Map<string, string>();
    const visit = (node: MarkdownNode, callback: (node: MarkdownNode) => void) => {
      callback(node);
      for (const child of node.children ?? []) visit(child, callback);
    };
    visit(tree, node => {
      if (node.type === "definition" && node.identifier && node.url && !definitions.has(identifier(node.identifier)))
        definitions.set(identifier(node.identifier), node.url);
    });
    visit(tree, node => {
      const url = node.type === "image" ? node.url
        : node.type === "imageReference" && node.identifier ? definitions.get(identifier(node.identifier)) : undefined;
      const offset = node.position?.start.offset;
      if (url && offset !== undefined) references.push({ offset, url });
    });
  };
  // The existing public synchronous Markdown entry runs remark only to read its AST.
  // Its returned React tree is never mounted: this projection cannot load an image or execute HTML.
  Markdown({ children: text, remarkPlugins: [remarkGfm, collect], skipHtml: true });
  return references;
}

/** Pure delivery ownership, recomputed from saved facts and final-answer blocks in timeline order. */
export function projectMessageSearchMedia(
  message: WorkbenchMessage | undefined, answerBlocks: readonly AnswerBlock[], documents?: MarkdownDisplays
): SearchMediaProjection {
  const cached = message && projectionByMessage.get(message);
  if (cached && cached.tools === message?.tools && cached.documents === documents && cached.blocks.length === answerBlocks.length &&
    cached.blocks.every((block, index) => block.id === answerBlocks[index].id && block.text === answerBlocks[index].text))
    return cached.projection;
  const images = messageSearchImages(message);
  const owned = new Set<string>();
  const markdown = new Map<string, MarkdownImageDelivery>();
  for (const block of answerBlocks) {
    const delivery = new Map<number, WorkbenchSearchImage>();
    const displayed = documents?.get(block.id);
    const references = !images.length ? [] : documents
      ? displayed?.document && block.text.startsWith(displayed.document.text) ? displayed.document.references : []
      : imageReferences(block.text);
    for (const reference of references) {
      const image = findSearchImage(images, reference.url);
      if (!image) continue;
      const key = searchImageIdentity(image);
      if (owned.has(key)) continue;
      owned.add(key);
      delivery.set(reference.offset, image);
    }
    markdown.set(block.id, delivery);
  }
  const projection = { images, markdown, remainingImages: images.filter(image => !owned.has(searchImageIdentity(image))) };
  if (message) projectionByMessage.set(message, {
    tools: message.tools, blocks: answerBlocks.map(({ id, text }) => ({ id, text })), documents, projection
  });
  return projection;
}
