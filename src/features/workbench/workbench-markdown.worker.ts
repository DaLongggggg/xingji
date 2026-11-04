import { parseMarkdownDocument, type MarkdownDocument } from "./workbench-markdown-document";

export type MarkdownWorkerRequest = { id: number; text: string };
export type MarkdownWorkerReply = { id: number; document?: MarkdownDocument; error?: string };
const scope = self as unknown as {
  onmessage: (event: MessageEvent<MarkdownWorkerRequest>) => void;
  postMessage: (reply: MarkdownWorkerReply) => void;
};
scope.onmessage = ({ data }) => {
  try { scope.postMessage({ id: data.id, document: parseMarkdownDocument(data.text) }); }
  catch { scope.postMessage({ id: data.id, error: "文档排版失败。" }); }
};
