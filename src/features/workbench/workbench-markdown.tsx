"use client";

import { copyWorkbenchText } from "./workbench-clipboard";

import { Fragment, createContext, memo, useContext, useMemo, useState, useEffect, startTransition, type ReactNode } from "react";
import Markdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { isSearchSourceUrl } from "@/features/ai/native-search-contract";
import { WorkbenchSearchImages, type PreviewSearchImage, type WorkbenchSearchImage } from "./workbench-search-images";
import { findSearchImage, type MarkdownImageDelivery } from "./workbench-media-projection";
import { WorkbenchMarkdownTable } from "./workbench-markdown-table";
import type { MarkdownTree, MarkdownDocument, PreparedMarkdownTable } from "./workbench-markdown-document";
import type { MarkdownDisplay } from "./workbench-markdown-documents";

function safeLink(url: string) {
  const transformed = defaultUrlTransform(url);
  return isSearchSourceUrl(transformed) || /^#[\w-]+$/.test(transformed) ? transformed : "";
}

function CodeBlock({ code, children }: { code: string; children: ReactNode }) {
  const [notice, setNotice] = useState("");
  const copy = async () => {
    try { await copyWorkbenchText(code); setNotice("代码已复制。"); }
    catch { setNotice("复制失败，请选中代码手动复制。"); }
  };
  return <div className="wb-code-block">
    <div className="wb-code-toolbar"><span>代码</span><button type="button" onClick={() => void copy()}>复制代码</button></div>
    <pre>{children}</pre>
    {notice ? <span className="wb-code-notice" role="status">{notice}</span> : null}
  </div>;
}

const ImageContext = createContext<{ images: WorkbenchSearchImage[]; delivery?: MarkdownImageDelivery; onPreviewImage?: PreviewSearchImage }>({ images: [] });
type MarkdownNode = { type: string; tagName?: string; children?: MarkdownNode[] };
function containsImage(node: MarkdownNode): boolean {
  return node.type === "element" && node.tagName === "img" || !!node.children?.some(containsImage);
}

function MarkdownImage({ src, alt, node }: { src?: string | Blob; alt?: string; node?: { position?: { start: { offset?: number } } } }) {
  const { images, delivery, onPreviewImage } = useContext(ImageContext);
  const url = typeof src === "string" ? src : "";
  const image = findSearchImage(images, url);
  const offset = node?.position?.start.offset;
  const owned = offset === undefined ? undefined : delivery?.get(offset);
  if (image && owned && owned.url === image.url && owned.sourceUrl === image.sourceUrl && onPreviewImage)
    return <WorkbenchSearchImages images={[owned]} onPreview={onPreviewImage} inline />;
  // 最终交付已经为本消息分配图片位置；未分配的重复引用不再追加自动来源行。
  if (image && delivery && !owned) return null;
  if (image) return <a className="wb-image-reference" href={image.sourceUrl} target="_blank" rel="noopener noreferrer">图片来源：{alt || image.title || "查看图片"}</a>;
  return url && isSearchSourceUrl(url)
    ? <a className="wb-image-reference" href={url} target="_blank" rel="noopener noreferrer">图片链接：{alt || "查看图片"}（未自动预览）</a>
    : <span className="wb-image-reference">图片未显示{alt ? `：${alt}` : ""}</span>;
}

// 组件身份固定，流式追加文本不会反复重挂图片或清掉代码复制反馈。
const components: Components = {
    a({ href, children, node }) {
      // 图片自身已带真实来源入口，避免 Markdown 外层链接嵌套按钮/链接。
      if (node?.children.some(containsImage)) return <span>{children}</span>;
      return href ? <a href={href} target={href.startsWith("#") ? undefined : "_blank"} rel="noopener noreferrer">{children}</a> : <span>{children}</span>;
    },
    img: MarkdownImage,
    pre({ children, node }) {
      const code = node?.children.flatMap(child => child.type === "element" && child.tagName === "code"
        ? child.children.flatMap(part => part.type === "text" ? [part.value] : []) : []).join("") ?? "";
      return <CodeBlock code={code}>{children}</CodeBlock>;
    },
    table: WorkbenchMarkdownTable
};

/** Each AST-derived block keeps the library's existing URL/HTML safety pass and component identities. */
function safeTree(tree: MarkdownTree): ReactNode {
  return Markdown({ skipHtml: true, urlTransform: safeLink, components, rehypePlugins: [
    () => (root: object) => { Object.assign(root, { type: "root", children: [structuredClone(tree)] }); }
  ], children: "" });
}
const PreparedBlock = memo(function PreparedBlock({ tree, table }: { tree: MarkdownTree; table?: PreparedMarkdownTable }) {
  return table ? <PreparedTable tree={tree} table={table} /> : safeTree(tree);
});

/** Keep one real table; prepare only a bounded number of safe rows per commit, with full TSV always available. */
function PreparedTable({ tree, table }: { tree: MarkdownTree; table: PreparedMarkdownTable }) {
  const [ready, setReady] = useState<{ key: string; fingerprint: string; node: ReactNode }[]>([]);
  const stable = ready.findIndex((row, index) => row.key !== table.rows[index]?.key || row.fingerprint !== table.rows[index]?.fingerprint);
  const retained = ready.slice(0, stable < 0 ? Math.min(ready.length, table.rows.length) : stable);
  const initial = retained.length ? retained : table.rows.slice(0, 8).map(row => ({ key: row.key, fingerprint: row.fingerprint, node: safeTree(row.tree) }));
  if (initial.length !== ready.length || initial.some((row, index) => row !== ready[index])) setReady(initial);
  const heads = useMemo(() => table.heads.map(safeTree), [table.heads]);
  useEffect(() => {
    if (initial.length >= table.rows.length) return;
    const frame = requestAnimationFrame(() => {
      const next = table.rows.slice(initial.length, initial.length + 8)
        .map(row => ({ key: row.key, fingerprint: row.fingerprint, node: safeTree(row.tree) }));
      startTransition(() => setReady([...initial, ...next]));
    });
    return () => cancelAnimationFrame(frame);
  }, [initial, table]);
  const pending = initial.length < table.rows.length ? <>
    <PendingText text={table.raw} start={table.rows[initial.length].rawStart} />
    <span className="wb-markdown-preparing" role="status">正在排版表格…</span>
  </> : undefined;
  return <WorkbenchMarkdownTable node={tree} pending={pending}>
    {heads.map((head, index) => <Fragment key={index}>{head}</Fragment>)}
    <tbody>{initial.map(row => <Fragment key={row.key}>{row.node}</Fragment>)}</tbody>
  </WorkbenchMarkdownTable>;
}

/** Stable raw-text chunks avoid repeatedly laying out one 100k text node while rich blocks arrive. */
const PendingChunk = memo(function PendingChunk({ text }: { text: string }) {
  return <div className="wb-markdown-raw-chunk">{text}</div>;
});
function PendingText({ text, start = 0 }: { text: string; start?: number }) {
  const chunks = useMemo(() => {
    const nodes: ReactNode[] = [];
    for (let offset = 0; offset < text.length; offset += 4096)
      nodes.push(<PendingChunk key={offset} text={text.slice(offset, offset + 4096)} />);
    return nodes;
  }, [text]);
  const first = Math.floor(start / 4096), offset = first * 4096;
  return <div className="wb-markdown-pending-text">
    {start > offset ? <PendingChunk key={offset} text={text.slice(start, offset + 4096)} /> : chunks[first]}
    {chunks.slice(first + 1)}
  </div>;
}

function PreparedDocument({ document, count = document.blocks.length }: { document: MarkdownDocument; count?: number }) {
  const [rendered, setRendered] = useState<{ block: MarkdownDocument["blocks"][number]; node: ReactNode }[]>([]);
  const visible = document.blocks.slice(0, count);
  // A memoized child still costs JSX creation for every old block. Retain those element objects too.
  const nodes = visible.map((block, index) => rendered[index]?.block === block ? rendered[index]
    : { block, node: <PreparedBlock key={block.key} tree={block.tree} table={block.table} /> });
  if (nodes.length !== rendered.length || nodes.some((entry, index) => entry !== rendered[index])) setRendered(nodes);
  const end = visible.at(-1)?.end ?? 0;
  return <>{nodes.map(entry => entry.node)}
    {count < document.blocks.length ? <><PendingText text={document.text} start={end} /><span className="wb-markdown-preparing" role="status">正在排版…</span></> : null}
  </>;
}

/** 只读呈现原文本；不执行 HTML、脚本或模型随意写出的图片地址。 */
type MarkdownProps = {
  text: string; images?: WorkbenchSearchImage[]; imageDelivery?: MarkdownImageDelivery; onPreviewImage?: PreviewSearchImage;
  display?: MarkdownDisplay;
};
const emptyImages: WorkbenchSearchImage[] = [];
export const WorkbenchMarkdown = memo(function WorkbenchMarkdown({ text, images = emptyImages, imageDelivery, onPreviewImage, display }: MarkdownProps) {
  const document = display?.document;
  const prepared = display !== undefined;
  const content = useMemo(() => document
    ? <PreparedDocument document={document} count={display?.blockLimit} />
    : prepared ? <PendingText text={text} />
      : <Markdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={safeLink} components={components}>{text}</Markdown>,
  [text, document, prepared, display?.blockLimit]);
  return <ImageContext value={{ images, delivery: imageDelivery, onPreviewImage }}><div className="wb-markdown">
    {content}
    {display?.tail ? <PendingText text={display.tail} /> : null}
    {display?.pending ? <span className="wb-markdown-preparing" role="status">正在排版…</span>
      : display?.degraded ? <span className="wb-markdown-preparing" role="status">排版暂不可用，已保留完整原文。</span> : null}
  </div></ImageContext>;
}, (before, after) => {
  const a = before.display, b = after.display;
  const sameDelivery = before.imageDelivery === after.imageDelivery ||
    (before.imageDelivery?.size ?? 0) === (after.imageDelivery?.size ?? 0) &&
      [...before.imageDelivery ?? []].every(([offset, image]) => after.imageDelivery?.get(offset) === image);
  const sameDocument = a?.document === b?.document || !!a?.document && !!b?.document &&
    a.document.text === b.document.text && a.document.blocks === b.document.blocks &&
    a.document.references.length === b.document.references.length &&
    a.document.references.every((reference, index) => reference === b.document!.references[index]);
  return before.text === after.text && before.images === after.images && before.onPreviewImage === after.onPreviewImage &&
    sameDelivery && sameDocument && !!a === !!b && a?.blockLimit === b?.blockLimit &&
    a?.tail === b?.tail && a?.pending === b?.pending && a?.degraded === b?.degraded;
});
