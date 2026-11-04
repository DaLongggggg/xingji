import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** The complete HAST produced by the existing parser, before its mutable safe-URL/HTML pass. */
export type MarkdownTree = {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: MarkdownTree[];
  position?: { start: { offset?: number }; end?: { offset?: number } };
};
export type PreparedMarkdownTable = {
  heads: MarkdownTree[];
  rows: { key: string; fingerprint: string; tree: MarkdownTree; rawStart: number }[];
  raw: string;
};
export type MarkdownDocument = {
  text: string;
  tree: MarkdownTree;
  references: { offset: number; url: string }[];
  blocks: { key: string; fingerprint: string; tree: MarkdownTree; end: number; table?: PreparedMarkdownTable }[];
};
export const MARKDOWN_WORKER_THRESHOLD = 4_000;

/** One whole-document parse preserves reference definitions, fences and incomplete GFM tables. */
export function parseMarkdownDocument(text: string): MarkdownDocument {
  let tree: MarkdownTree = { type: "root", children: [] };
  const references: MarkdownDocument["references"] = [];
  const capture = () => (root: MarkdownTree) => {
    // react-markdown's public entry subsequently mutates URLs/raw nodes. Keep the pristine tree.
    tree = structuredClone(root);
    const visit = (node: MarkdownTree) => {
      const offset = node.position?.start.offset;
      const url = node.properties?.src;
      if (node.tagName === "img" && typeof url === "string" && offset !== undefined)
        references.push({ offset, url });
      for (const child of node.children ?? []) visit(child);
    };
    visit(root);
  };
  // Use the installed public parser API in both the browser and Worker. No alternate HTML renderer.
  Markdown({ children: text, remarkPlugins: [remarkGfm], rehypePlugins: [capture], skipHtml: true });
  const prepareTable = (node: MarkdownTree): PreparedMarkdownTable | undefined => {
    if (node.tagName !== "table") return;
    const start = node.position?.start.offset, finish = node.position?.end?.offset;
    if (start === undefined || finish === undefined || references.some(reference => reference.offset >= start && reference.offset < finish)) return;
    const rows = (node.children ?? []).filter(child => child.tagName === "tbody")
      .flatMap(body => (body.children ?? []).filter(row => row.tagName === "tr"));
    if (rows.length <= 40 || rows.some(row => row.position?.start.offset === undefined || row.position?.end?.offset === undefined)) return;
    const first = rows[0].position!.start.offset!, last = rows.at(-1)!.position!.end!.offset!;
    return { heads: (node.children ?? []).filter(child => child.tagName === "thead"),
      rows: rows.map((row, index) => ({ key: `${row.position!.start.offset}:${index}`, fingerprint: JSON.stringify(row), tree: row,
        rawStart: row.position!.start.offset! - first })), raw: text.slice(first, last) };
  };
  let end = 0;
  // Root separators between block elements collapse in HTML; retain them in the pristine tree, not as parser jobs.
  const blocks = (tree.children ?? []).filter(node => node.type !== "text" || !!node.value?.trim()).map((node, index) => ({
    key: `${node.position?.start.offset ?? index}:${node.tagName ?? node.type}`,
    // Computed off-thread for long documents. Resolved reference URLs participate in equality.
    fingerprint: JSON.stringify(node), tree: node, table: prepareTable(node), end: (end = Math.max(end, node.position?.end?.offset ?? 0))
  }));
  return { text, tree, references, blocks };
}
