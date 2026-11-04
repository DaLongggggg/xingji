/**
 * 上下文整理（增量任务书 §6）：纯函数、可测、预算显式。
 *
 * 规则：
 * - **最近若干条逐字保留**，更早的对话压成一份可读摘要（每轮一行、过长截断并标注省略量）；
 * - **工具调用与结果是一个整体**：不拆开、不产生悬空配对；未完成的一对保留并标注「未完成」；
 * - 单条工具输出超限即截断并写明省略了多少字符；
 * - 预算用「字符 / 4」估算（与参考实现同法），超预算时**先丢摘要**，逐字保留段仍然完整；
 * - **当前请求快照、来源与修改目标不在本函数里**——它们由调用方直接附加，永远不参与压缩。
 */
export type ContextTurn = {
  role: "user" | "assistant";
  /** 消息 ID：较早轮次被摘录后，模型仍可按 ID 用 session 检索/读取回原文（C4）。 */
  id?: string;
  text: string;
  /** 这一轮发言携带的图片候选 ID：压缩后仍保留，模型才能把建议与具体原图对上。 */
  imageSourceIds?: string[];
  imageAdvice?: import("./workbench-types").ImageAdvice;
};
export type ContextToolResult = { id: string; name: string; ok: boolean; content: string; finished?: boolean };

export type CompactedContext = {
  /** 逐字保留的最近对话。 */
  turns: ContextTurn[];
  /** 更早对话的**摘录**（逐轮截取前缀，不是模型生成的摘要；可能因预算被丢弃）。 */
  digest: string;
  /** 工具结果：配对保留、超限截断。 */
  tools: ContextToolResult[];
  tokens: number;
  notices: string[];
  digestDropped: boolean;
  /** 仍然超预算：调用方必须拒绝或缩小输入，不能假装预算内。 */
  overBudget: boolean;
};

export const CONTEXT_DEFAULTS = { keepRecent: 12, budgetTokens: 4_000, perToolChars: 800, digestLineChars: 120 };

/** 估算 token：JSON 长度 / 4（与参考实现一致，用作预算而非计费）。 */
export function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value ?? "").length / 4);
}

function clip(text: string, limit: number): { text: string; omitted: number } {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return { text: clean, omitted: 0 };
  return { text: clean.slice(0, limit), omitted: clean.length - limit };
}

export function compactContext(input: {
  history: ContextTurn[];
  tools?: ContextToolResult[];
  keepRecent?: number;
  budgetTokens?: number;
  perToolChars?: number;
}): CompactedContext {
  const keepRecent = input.keepRecent ?? CONTEXT_DEFAULTS.keepRecent;
  const budgetTokens = input.budgetTokens ?? CONTEXT_DEFAULTS.budgetTokens;
  const perToolChars = input.perToolChars ?? CONTEXT_DEFAULTS.perToolChars;
  const notices: string[] = [];

  const history = input.history ?? [];
  const recentStart = Math.max(0, history.length - keepRecent);
  const turns = history.slice(recentStart);
  const older = history.slice(0, recentStart);

  // 更早的对话压成摘要：每轮一行，过长截断；携带的图片候选 ID 仍然保留。
  let omittedChars = 0;
  const digestLines = older.map((turn, index) => {
    const clipped = clip(turn.text, CONTEXT_DEFAULTS.digestLineChars);
    omittedChars += clipped.omitted;
    const images = turn.imageSourceIds?.length ? `（图：${turn.imageSourceIds.join("、")}）` : "";
    // 摘录行保留消息 ID：正文被截断的轮次仍可按 ID 回读原文（C4）。
    const id = turn.id ? `#${turn.id}` : "";
    return `${index + 1}. ${turn.role === "user" ? "用户" : "助手"}${id}：${clipped.text}${clipped.omitted ? "…" : ""}${images}`;
  });
  let digest = digestLines.length ? `（较早的 ${older.length} 轮对话已摘录，逐轮截取前缀）\n${digestLines.join("\n")}` : "";
  if (older.length > 0) {
    notices.push(`较早的 ${older.length} 轮对话已摘录${omittedChars ? `（另有 ${omittedChars} 字符被省略）` : ""}。`);
  }

  // 工具结果：截断 + 配对标注（不拆对）。
  const tools = (input.tools ?? []).map((tool) => {
    const clipped = clip(tool.content, perToolChars);
    if (clipped.omitted > 0) {
      notices.push(`工具 ${tool.name} 的输出已省略 ${clipped.omitted} 字符。`);
    }
    return { ...tool, content: clipped.text ? `${clipped.text}${clipped.omitted ? `\n…（已省略 ${clipped.omitted} 字符）` : ""}` : "" };
  });
  if (tools.some((tool) => tool.finished === false)) {
    notices.push("有尚未完成的工具调用，已原样保留配对。");
  }

  const measure = () => estimateTokens({ turns, digest, tools });
  let tokens = measure();
  let digestDropped = false;
  if (tokens > budgetTokens && digest) {
    digest = `（较早的 ${older.length} 轮对话摘录因预算被省略）`;
    digestDropped = true;
    notices.push("上下文接近预算，较早对话摘录已省略；最近对话与工具配对保持完整。");
    tokens = measure();
  }
  /*
   * 仍然超预算：只截断工具输出、且**每轮严格减半**（有界，不会停在“仍然大于阈值”上），
   * 最多 8 轮；绝不动最近对话与工具配对。仍超预算时如实上报 overBudget 由调用方决定拒绝。
   */
  let rounds = 0;
  while (tokens > budgetTokens && tools.some((tool) => tool.content.length > 40) && rounds < 8) {
    rounds += 1;
    for (const tool of tools) {
      if (tool.content.length > 40) {
        const keep = Math.max(20, Math.floor(tool.content.length / 4));
        tool.content = `${tool.content.slice(0, keep)}\n…（已按预算省略 ${tool.content.length - keep} 字符）`;
      }
    }
    notices.push("工具输出已按上下文预算进一步截断。");
    tokens = measure();
  }
  const overBudget = tokens > budgetTokens;
  if (overBudget) {
    notices.push("上下文仍超过预算：调用方应缩小输入或拒绝本次请求。");
  }

  return { turns, digest, tools, tokens, notices, digestDropped, overBudget };
}
