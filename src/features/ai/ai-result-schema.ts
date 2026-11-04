/**
 * P1-05：organize_page 的运行时结果 Schema。
 *
 * 边界：
 * - 不用正则从任意文本里“抢救” JSON；JSON 解析失败即失败；
 * - 结构不合法一律拒绝，不包装成成功，不静默降级为整篇覆盖；
 * - 只允许已有 text block 的内容替换与可选标题；图片、块身份与顺序由应用层保证。
 * - 手写校验器：与仓库既有风格一致（见 notebook-model.ts），不引入新依赖。
 */
import { MAX_PAGE_TEXT_LENGTH, MAX_PAGE_TITLE_LENGTH } from "../notebook/notebook-model";

export type OrganizePageResult = {
  title?: string;
  textBlocks: { blockId: string; content: string }[];
  summary?: string;
};

export type ResultIssue = {
  code:
    | "RESULT_NOT_OBJECT"
    | "RESULT_INVALID_JSON"
    | "RESULT_TITLE_INVALID"
    | "RESULT_BLOCKS_INVALID"
    | "RESULT_BLOCK_INVALID"
    | "RESULT_BLOCK_DUPLICATE"
    | "RESULT_CONTENT_TOO_LONG"
    | "RESULT_SUMMARY_INVALID"
    | "RESULT_EMPTY";
  detail: string;
};

/**
 * 供应商结构化输出用的 JSON Schema（服务端固定定义）。
 * 与下方校验器保持一致；额外字段由 `additionalProperties: false` 拒绝。
 */
export const ORGANIZE_PAGE_RESULT_SCHEMA = {
  name: "organize_page",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["textBlocks"],
    properties: {
      title: { type: "string", maxLength: MAX_PAGE_TITLE_LENGTH },
      summary: { type: "string" },
      textBlocks: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["blockId", "content"],
          properties: {
            blockId: { type: "string", minLength: 1 },
            content: { type: "string", maxLength: MAX_PAGE_TEXT_LENGTH }
          }
        }
      }
    }
  }
} as const;

export function validateOrganizePageResult(value: unknown): ResultIssue[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [{ code: "RESULT_NOT_OBJECT", detail: "结果必须是 JSON 对象。" }];
  }
  const candidate = value as Partial<OrganizePageResult> & Record<string, unknown>;
  const issues: ResultIssue[] = [];
  const allowed = ["title", "textBlocks", "summary"];
  const extra = Object.keys(candidate).filter((key) => !allowed.includes(key));
  if (extra.length > 0) {
    issues.push({ code: "RESULT_BLOCK_INVALID", detail: `不接受的字段：${extra.join(",")}` });
  }

  if (candidate.title !== undefined) {
    if (typeof candidate.title !== "string" || candidate.title.trim().length === 0) {
      issues.push({ code: "RESULT_TITLE_INVALID", detail: "title 必须是非空字符串或省略。" });
    } else if (candidate.title.length > MAX_PAGE_TITLE_LENGTH) {
      issues.push({
        code: "RESULT_TITLE_INVALID",
        detail: `title 超过 ${MAX_PAGE_TITLE_LENGTH} 字。`
      });
    }
  }

  if (candidate.summary !== undefined && typeof candidate.summary !== "string") {
    issues.push({ code: "RESULT_SUMMARY_INVALID", detail: "summary 必须是字符串。" });
  }

  if (!Array.isArray(candidate.textBlocks) || candidate.textBlocks.length === 0) {
    issues.push({ code: "RESULT_BLOCKS_INVALID", detail: "textBlocks 必须是非空数组。" });
    return issues;
  }

  const seen = new Set<string>();
  for (const block of candidate.textBlocks) {
    if (!block || typeof block !== "object") {
      issues.push({ code: "RESULT_BLOCK_INVALID", detail: "textBlocks 元素不是对象。" });
      continue;
    }
    const entry = block as { blockId?: unknown; content?: unknown };
    if (typeof entry.blockId !== "string" || entry.blockId.length === 0) {
      issues.push({ code: "RESULT_BLOCK_INVALID", detail: "blockId 必须是非空字符串。" });
      continue;
    }
    if (seen.has(entry.blockId)) {
      issues.push({ code: "RESULT_BLOCK_DUPLICATE", detail: `blockId 重复：${entry.blockId}` });
      continue;
    }
    seen.add(entry.blockId);
    if (typeof entry.content !== "string") {
      issues.push({
        code: "RESULT_BLOCK_INVALID",
        detail: `blockId ${entry.blockId} 的 content 必须是字符串。`
      });
      continue;
    }
    if (entry.content.length > MAX_PAGE_TEXT_LENGTH) {
      issues.push({
        code: "RESULT_CONTENT_TOO_LONG",
        detail: `blockId ${entry.blockId} 超过单块 ${MAX_PAGE_TEXT_LENGTH} 字上限。`
      });
    }
  }

  return issues;
}

export class OrganizePageResultError extends Error {
  readonly issues: ResultIssue[];
  constructor(issues: ResultIssue[]) {
    super(`AI_RESULT_INVALID:${issues.map((issue) => issue.code).join(",")}`);
    this.name = "OrganizePageResultError";
    this.issues = issues;
  }
}

export function assertOrganizePageResult(value: unknown): OrganizePageResult {
  const issues = validateOrganizePageResult(value);
  if (issues.length > 0) throw new OrganizePageResultError(issues);
  return value as OrganizePageResult;
}

/** 解析供应商返回的 JSON 文本；不合法即失败，不做文本抢救。 */
export function parseOrganizePageResult(content: string): OrganizePageResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new OrganizePageResultError([
      { code: "RESULT_INVALID_JSON", detail: "模型返回的内容不是有效 JSON。" }
    ]);
  }
  return assertOrganizePageResult(parsed);
}
