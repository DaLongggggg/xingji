/**
 * P3-02：organize_captures 的运行时结果 Schema。
 *
 * 边界（与 organize_page 同一取向）：
 * - 不用正则从任意文本里"抢救" JSON；JSON 解析失败即失败；
 * - 结构不合法一律拒绝，不包装成成功，不静默丢弃非法项或偷偷排序；
 * - sourceIndex 的范围（< 来源总数）由调用方传入 sourceCount 后在此校验；
 * - 手写校验器：与仓库既有风格一致（见 notebook-model.ts），不引入新依赖。
 */
import { MAX_PAGE_TEXT_LENGTH } from "../notebook/notebook-model";

export type CaptureOrganizeResult = {
  sections: { sourceIndex: number; content: string }[];
};

export type CaptureResultIssue = {
  code:
    | "RESULT_NOT_OBJECT"
    | "RESULT_INVALID_JSON"
    | "RESULT_SECTIONS_INVALID"
    | "RESULT_SECTION_INVALID"
    | "RESULT_INDEX_INVALID"
    | "RESULT_INDEX_DUPLICATE"
    | "RESULT_INDEX_UNORDERED"
    | "RESULT_INDEX_OUT_OF_RANGE"
    | "RESULT_CONTENT_INVALID"
    | "RESULT_CONTENT_TOO_LONG"
    | "RESULT_UNKNOWN_FIELD"
    | "RESULT_EMPTY";
  detail: string;
};

/**
 * 供应商结构化输出用的 JSON Schema（服务端固定定义）。
 * sourceIndex 的来源数量上界在运行时校验器里按实际来源数判断；
 * content 的单项上限沿用单块文本上限。
 */
export const CAPTURE_ORGANIZE_RESULT_SCHEMA = {
  name: "organize_captures",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["sections"],
    properties: {
      sections: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["sourceIndex", "content"],
          properties: {
            sourceIndex: { type: "integer", minimum: 0 },
            content: { type: "string", minLength: 1, maxLength: MAX_PAGE_TEXT_LENGTH }
          }
        }
      }
    }
  }
} as const;

export function validateCaptureOrganizeResult(
  value: unknown,
  sourceCount?: number
): CaptureResultIssue[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [{ code: "RESULT_NOT_OBJECT", detail: "结果必须是 JSON 对象。" }];
  }
  const candidate = value as Partial<CaptureOrganizeResult> & Record<string, unknown>;
  const issues: CaptureResultIssue[] = [];
  const allowed = ["sections"];
  const extra = Object.keys(candidate).filter((key) => !allowed.includes(key));
  if (extra.length > 0) {
    issues.push({ code: "RESULT_UNKNOWN_FIELD", detail: `不接受的字段：${extra.join(",")}` });
  }

  if (!Array.isArray(candidate.sections)) {
    issues.push({ code: "RESULT_SECTIONS_INVALID", detail: "sections 必须是数组。" });
    return issues;
  }

  const seen = new Set<number>();
  let previousIndex = -1;
  for (const item of candidate.sections) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      issues.push({ code: "RESULT_SECTION_INVALID", detail: "sections 元素必须是对象。" });
      continue;
    }
    const entry = item as { sourceIndex?: unknown; content?: unknown };
    const extraEntry = Object.keys(entry).filter((key) => key !== "sourceIndex" && key !== "content");
    if (extraEntry.length > 0) {
      issues.push({
        code: "RESULT_SECTION_INVALID",
        detail: `section 不接受的字段：${extraEntry.join(",")}`
      });
      continue;
    }
    if (
      typeof entry.sourceIndex !== "number" ||
      !Number.isInteger(entry.sourceIndex) ||
      entry.sourceIndex < 0
    ) {
      issues.push({
        code: "RESULT_INDEX_INVALID",
        detail: `sourceIndex 必须是非负整数：${String(entry.sourceIndex)}。`
      });
      continue;
    }
    if (sourceCount !== undefined && entry.sourceIndex >= sourceCount) {
      issues.push({
        code: "RESULT_INDEX_OUT_OF_RANGE",
        detail: `sourceIndex ${entry.sourceIndex} 超出来源范围（0..${sourceCount - 1}）。`
      });
      continue;
    }
    if (seen.has(entry.sourceIndex)) {
      issues.push({
        code: "RESULT_INDEX_DUPLICATE",
        detail: `sourceIndex 重复：${entry.sourceIndex}。`
      });
      continue;
    }
    if (seen.size > 0 && (entry.sourceIndex as number) <= previousIndex) {
      issues.push({
        code: "RESULT_INDEX_UNORDERED",
        detail: `sourceIndex 必须严格升序：${entry.sourceIndex} 出现在 ${previousIndex} 之后。`
      });
      continue;
    }
    seen.add(entry.sourceIndex);
    previousIndex = entry.sourceIndex;
    if (typeof entry.content !== "string" || entry.content.trim().length === 0) {
      issues.push({
        code: "RESULT_CONTENT_INVALID",
        detail: `sourceIndex ${entry.sourceIndex} 的 content 必须是非空字符串。`
      });
      continue;
    }
    if (entry.content.length > MAX_PAGE_TEXT_LENGTH) {
      issues.push({
        code: "RESULT_CONTENT_TOO_LONG",
        detail: `sourceIndex ${entry.sourceIndex} 的 content 超过单块 ${MAX_PAGE_TEXT_LENGTH} 字上限。`
      });
    }
  }

  return issues;
}

export class CaptureOrganizeResultError extends Error {
  readonly issues: CaptureResultIssue[];
  constructor(issues: CaptureResultIssue[]) {
    super(`AI_RESULT_INVALID:${issues.map((issue) => issue.code).join(",")}`);
    this.name = "CaptureOrganizeResultError";
    this.issues = issues;
  }
}

export function assertCaptureOrganizeResult(
  value: unknown,
  sourceCount?: number
): CaptureOrganizeResult {
  const issues = validateCaptureOrganizeResult(value, sourceCount);
  if (issues.length > 0) throw new CaptureOrganizeResultError(issues);
  return value as CaptureOrganizeResult;
}

/** 解析供应商返回的 JSON 文本；不合法即失败，不做文本抢救。 */
export function parseCaptureOrganizeResult(content: string, sourceCount?: number) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new CaptureOrganizeResultError([
      { code: "RESULT_INVALID_JSON", detail: "模型返回的内容不是有效 JSON。" }
    ]);
  }
  return assertCaptureOrganizeResult(parsed, sourceCount);
}
