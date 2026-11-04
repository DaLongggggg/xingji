/**
 * P5：单篇派生元数据（摘要 + 主题标签）的运行时结果 Schema。
 *
 * 边界：
 * - 只产生派生信息（summary/topics），不产生任何正文改写指令；
 * - 不用正则抢救 JSON；结构不合法即失败；
 * - 主题标签在这里规范化（与搜索过滤共用 `normalizeTopics`），
 *   空/超长/重复项被丢弃而不是静默截断成另一个标签；
 * - people/placeMentions/dateMentions 仍属 FUTURE：不解析、不落库、不冒充已支持。
 */
import { MAX_TOPIC_LENGTH, normalizeTopics } from "./ai-repository";

export const PAGE_METADATA_LIMITS = {
  summaryChars: 2_000,
  topics: 20
} as const;

export type PageMetadataResult = {
  summary?: string;
  topics: string[];
};

export type PageMetadataIssue = {
  code:
    | "RESULT_NOT_OBJECT"
    | "RESULT_INVALID_JSON"
    | "RESULT_EXTRA_FIELD"
    | "RESULT_SUMMARY_INVALID"
    | "RESULT_TOPICS_INVALID"
    | "RESULT_TOO_MANY";
  detail: string;
};

/** 供应商结构化输出用的 JSON Schema（服务端固定定义），与下方校验器一致。 */
export const PAGE_METADATA_RESULT_SCHEMA = {
  name: "page_metadata",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["topics"],
    properties: {
      summary: { type: "string" },
      topics: {
        type: "array",
        maxItems: PAGE_METADATA_LIMITS.topics,
        items: { type: "string", minLength: 1, maxLength: MAX_TOPIC_LENGTH }
      }
    }
  }
} as const;

const ALLOWED_FIELDS = ["summary", "topics"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function validatePageMetadataResult(value: unknown): PageMetadataIssue[] {
  const issues: PageMetadataIssue[] = [];
  if (!isRecord(value)) {
    return [{ code: "RESULT_NOT_OBJECT", detail: "结果必须是 JSON 对象。" }];
  }
  const extra = Object.keys(value).filter((key) => !ALLOWED_FIELDS.includes(key));
  if (extra.length > 0) {
    issues.push({ code: "RESULT_EXTRA_FIELD", detail: `不接受的字段：${extra.join(",")}。` });
  }
  if (value.summary !== undefined) {
    if (typeof value.summary !== "string" || value.summary.trim().length === 0) {
      issues.push({ code: "RESULT_SUMMARY_INVALID", detail: "summary 必须是非空字符串或省略。" });
    } else if (value.summary.length > PAGE_METADATA_LIMITS.summaryChars) {
      issues.push({
        code: "RESULT_SUMMARY_INVALID",
        detail: `summary 超过 ${PAGE_METADATA_LIMITS.summaryChars} 字。`
      });
    }
  }
  if (!Array.isArray(value.topics)) {
    issues.push({ code: "RESULT_TOPICS_INVALID", detail: "topics 必须是数组（可为空数组）。" });
    return issues;
  }
  if (value.topics.length > PAGE_METADATA_LIMITS.topics) {
    issues.push({
      code: "RESULT_TOO_MANY",
      detail: `topics 超过 ${PAGE_METADATA_LIMITS.topics} 条上限。`
    });
    return issues;
  }
  // 每个主题必须是能规范化的非空短字符串；超长/空白项一律拒绝（不截断成另一个标签）。
  for (const topic of value.topics) {
    if (typeof topic !== "string" || topic.trim().length === 0) {
      issues.push({ code: "RESULT_TOPICS_INVALID", detail: "topics 元素必须是非空字符串。" });
      continue;
    }
    if (topic.trim().length > MAX_TOPIC_LENGTH) {
      issues.push({
        code: "RESULT_TOPICS_INVALID",
        detail: `主题超过 ${MAX_TOPIC_LENGTH} 字：${topic.slice(0, MAX_TOPIC_LENGTH)}…`
      });
    }
  }
  return issues;
}

export class PageMetadataResultError extends Error {
  readonly issues: PageMetadataIssue[];
  constructor(issues: PageMetadataIssue[]) {
    super(`AI_METADATA_RESULT_INVALID:${issues.map((issue) => issue.code).join(",")}`);
    this.name = "PageMetadataResultError";
    this.issues = issues;
  }
}

/** 校验并规范化：返回的 topics 已去重、折叠空白、统一小写。 */
export function parsePageMetadataResult(content: string): PageMetadataResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new PageMetadataResultError([
      { code: "RESULT_INVALID_JSON", detail: "模型返回的内容不是有效 JSON。" }
    ]);
  }
  const issues = validatePageMetadataResult(parsed);
  if (issues.length > 0) throw new PageMetadataResultError(issues);
  const candidate = parsed as PageMetadataResult;
  return {
    ...(candidate.summary !== undefined ? { summary: candidate.summary } : {}),
    topics: normalizeTopics(candidate.topics)
  };
}
