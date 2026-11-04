/**
 * 024 Phase 0 / P0-02：Notebook 正式查询层（纯函数）。
 *
 * 设计边界：
 * - 与 React、IndexedDB、Repository 完全解耦：输入输出都是普通领域对象，
 *   未来 AI Foundation 的读上下文与 SearchProvider 直接复用，不做第二套实现；
 * - 只读，不修改传入对象；
 * - 搜索面向**完整 text block**（历史实现在组件内只搜前 500 字，属已修技术债）；
 * - 本文件不包含 AI Proposal / AI Context 结构，只留接口边界说明（见文件尾注释）。
 */
import type { NotebookPage } from "./notebook-model";

/** 一篇的全部 text block 正文（按块顺序，块间换行）。 */
export function getPageText(page: NotebookPage): string {
  return page.blocks
    .filter(
      (block): block is Extract<NotebookPage["blocks"][number], { type: "text" }> =>
        block.type === "text"
    )
    .map((block) => block.text)
    .join("\n");
}

/**
 * 列表摘要：只用文字块，不碰媒体；空白折叠为单空格，超长截断。
 * 与既有组件内实现行为一致（默认 48 字符）。
 */
export function getPageSummary(page: NotebookPage, limit = 48): string {
  const single = getPageText(page).replace(/\s+/g, " ").trim();
  if (!single) return "（还没有正文）";
  return single.length > limit ? `${single.slice(0, limit)}…` : single;
}

/**
 * 跨篇标题 + 全文搜索（大小写不敏感；query 为空返回原数组）。
 * 完整 text block 匹配——不再截断 500 字符。
 */
export function searchPages(pages: NotebookPage[], query: string): NotebookPage[] {
  const keyword = query.trim().toLowerCase();
  if (!keyword) return pages;
  return pages.filter(
    (page) =>
      page.title.toLowerCase().includes(keyword) ||
      getPageText(page).toLowerCase().includes(keyword)
  );
}

/**
 * —— 后续接口边界说明（Phase 0 不实现）——
 * AI Foundation 阶段预计在本层之上增加（顺序即依赖方向）：
 * 1. AI Context 读取：组合 getPageText/getPageSummary + 时间/地区/来源元数据，
 *    为模型组装只读上下文；只依赖本文件的纯函数与 ArchiveCore 对象。
 * 2. Proposal 结构：AI 建议必须是可序列化的普通对象（如 { pageId, baseline,
 *    proposalMarkdown/BlockOps }），经 Preview/User Accept 后走
 *    useNotebookArchive.updatePage（携带基线）——不新增写路径。
 * 本文件届时只做扩展，不改变只读纯函数边界。
 */
