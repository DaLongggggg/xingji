/**
 * P4：手帐本智能整理的**只读结果**运行时 Schema。
 *
 * 边界：
 * - 结果只描述“看到了什么、建议什么”，没有任何正文替换指令；因此它不能被
 *   Safe Commit 应用，也不会写业务或媒体。
 * - 不用正则从任意文本里抢救 JSON；JSON 解析失败即失败。
 * - 引用白名单：结果里每个 pageId/blockId 必须属于**冻结来源**，陌生引用整体拒绝
 *   （宁可失败，也不展示指向范围之外的内容）。
 * - 未知就是未知：日期用 `null` 表示未知/未写；不编造日期。缺口一律标记为建议。
 */
/** 分析维度上限：防止异常输出撑爆存储与界面（不是“质量评分”）。 */
export const NOTEBOOK_ANALYSIS_LIMITS = {
  summaryChars: 4_000,
  timeline: 300,
  themes: 60,
  structure: 60,
  related: 200,
  duplicates: 60,
  gaps: 60,
  entryTitleChars: 200,
  entryNameChars: 80,
  entryTextChars: 600,
  pageIdsPerEntry: 50
} as const;

/** 时间线条目：`date` 为当地日历日期；无法确定时必须为 null（未知），不得猜测。 */
export type NotebookAnalysisTimelineEntry = {
  date: string | null;
  title: string;
  pageIds: string[];
  blockIds?: string[];
};

export type NotebookAnalysisThemeEntry = {
  name: string;
  pageIds: string[];
  /** 判定依据（引用到的文本特征），是解释不是事实。 */
  basis: string;
};

export type NotebookAnalysisStructureEntry = {
  suggestion: string;
  pageIds: string[];
};

export type NotebookAnalysisRelatedEntry = {
  pageId: string;
  relatedPageId: string;
  reason: string;
};

export type NotebookAnalysisDuplicateEntry = {
  pageIds: string[];
  reason: string;
};

/** 内容缺口：明确是建议（suggestion），不是对用户经历的断言。 */
export type NotebookAnalysisGapEntry = {
  suggestion: string;
  basis: string;
};

export type NotebookAnalysisResult = {
  summary: string;
  timeline: NotebookAnalysisTimelineEntry[];
  themes: NotebookAnalysisThemeEntry[];
  structure: NotebookAnalysisStructureEntry[];
  related: NotebookAnalysisRelatedEntry[];
  duplicates: NotebookAnalysisDuplicateEntry[];
  gaps: NotebookAnalysisGapEntry[];
};

export type NotebookAnalysisIssue = {
  code:
    | "RESULT_NOT_OBJECT"
    | "RESULT_INVALID_JSON"
    | "RESULT_EXTRA_FIELD"
    | "RESULT_SECTION_INVALID"
    | "RESULT_ENTRY_INVALID"
    | "RESULT_PAGE_UNKNOWN"
    | "RESULT_BLOCK_UNKNOWN"
    | "RESULT_PAGE_DUPLICATE"
    | "RESULT_DATE_INVALID"
    | "RESULT_TOO_MANY";
  detail: string;
};

/** 供应商结构化输出用的 JSON Schema（服务端固定定义），与下方校验器保持一致。 */
export const NOTEBOOK_ANALYSIS_RESULT_SCHEMA = {
  name: "analyze_notebook",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["summary", "timeline", "themes", "structure", "related", "duplicates", "gaps"],
    properties: {
      summary: { type: "string" },
      timeline: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["date", "title", "pageIds"],
          properties: {
            date: { type: ["string", "null"] },
            title: { type: "string" },
            pageIds: { type: "array", items: { type: "string" } },
            blockIds: { type: "array", items: { type: "string" } }
          }
        }
      },
      themes: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "pageIds", "basis"],
          properties: {
            name: { type: "string" },
            pageIds: { type: "array", items: { type: "string" } },
            basis: { type: "string" }
          }
        }
      },
      structure: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["suggestion", "pageIds"],
          properties: {
            suggestion: { type: "string" },
            pageIds: { type: "array", items: { type: "string" } }
          }
        }
      },
      related: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["pageId", "relatedPageId", "reason"],
          properties: {
            pageId: { type: "string" },
            relatedPageId: { type: "string" },
            reason: { type: "string" }
          }
        }
      },
      duplicates: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["pageIds", "reason"],
          properties: {
            pageIds: { type: "array", items: { type: "string" } },
            reason: { type: "string" }
          }
        }
      },
      gaps: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["suggestion", "basis"],
          properties: {
            suggestion: { type: "string" },
            basis: { type: "string" }
          }
        }
      }
    }
  }
} as const;

const ALLOWED_TOP_FIELDS = [
  "summary",
  "timeline",
  "themes",
  "structure",
  "related",
  "duplicates",
  "gaps"
];

export type NotebookAnalysisValidationOptions = {
  /**
   * 冻结来源的页 ID 白名单。真实边界（预览冻结、存储读取）必须提供；
   * 省略时只做结构/上限校验，不做引用核对。
   */
  allowedPageIds?: ReadonlySet<string>;
  /** 冻结来源的块 ID 白名单；省略时同样只做结构校验。 */
  allowedBlockIds?: ReadonlySet<string>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isLocalCalendarDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth;
}

function checkSection(
  issues: NotebookAnalysisIssue[],
  container: Record<string, unknown>,
  key: string,
  maxEntries: number
): unknown[] | null {
  const value = container[key];
  if (!Array.isArray(value)) {
    issues.push({ code: "RESULT_SECTION_INVALID", detail: `${key} 必须是数组。` });
    return null;
  }
  if (value.length > maxEntries) {
    issues.push({ code: "RESULT_TOO_MANY", detail: `${key} 超过 ${maxEntries} 条上限。` });
    return null;
  }
  return value;
}

function checkPageIds(
  issues: NotebookAnalysisIssue[],
  value: unknown,
  options: NotebookAnalysisValidationOptions,
  field: string,
  minItems: number
): string[] | null {
  if (!Array.isArray(value) || !value.every(isNonEmptyString)) {
    issues.push({ code: "RESULT_ENTRY_INVALID", detail: `${field} 必须是非空字符串数组。` });
    return null;
  }
  if (value.length < minItems || value.length > NOTEBOOK_ANALYSIS_LIMITS.pageIdsPerEntry) {
    issues.push({
      code: "RESULT_ENTRY_INVALID",
      detail: `${field} 数量必须在 ${minItems}..${NOTEBOOK_ANALYSIS_LIMITS.pageIdsPerEntry} 之间。`
    });
    return null;
  }
  if (new Set(value).size !== value.length) {
    issues.push({ code: "RESULT_PAGE_DUPLICATE", detail: `${field} 存在重复 pageId。` });
    return null;
  }
  const allowedPages = options.allowedPageIds;
  const unknown =
    allowedPages === undefined ? [] : value.filter((pageId) => !allowedPages.has(pageId));
  if (unknown.length > 0) {
    issues.push({
      code: "RESULT_PAGE_UNKNOWN",
      detail: `${field} 引用了冻结来源之外的篇：${unknown.join(",")}。`
    });
    return null;
  }
  return value;
}

function checkBlockIds(
  issues: NotebookAnalysisIssue[],
  value: unknown,
  options: NotebookAnalysisValidationOptions,
  field: string
): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || !value.every(isNonEmptyString)) {
    issues.push({ code: "RESULT_ENTRY_INVALID", detail: `${field} 必须是字符串数组。` });
    return;
  }
  if (new Set(value).size !== value.length) {
    issues.push({ code: "RESULT_ENTRY_INVALID", detail: `${field} 存在重复 blockId。` });
    return;
  }
  const allowed = options.allowedBlockIds;
  const unknown = allowed ? value.filter((blockId) => !allowed.has(blockId)) : [];
  if (unknown.length > 0) {
    issues.push({
      code: "RESULT_BLOCK_UNKNOWN",
      detail: `${field} 引用了冻结来源之外的块：${unknown.join(",")}。`
    });
  }
}

function checkText(
  issues: NotebookAnalysisIssue[],
  value: unknown,
  field: string,
  maxChars: number
): void {
  if (typeof value !== "string") {
    issues.push({ code: "RESULT_ENTRY_INVALID", detail: `${field} 必须是字符串。` });
    return;
  }
  if (value.trim().length === 0) {
    issues.push({ code: "RESULT_ENTRY_INVALID", detail: `${field} 不能为空。` });
    return;
  }
  if (value.length > maxChars) {
    issues.push({ code: "RESULT_ENTRY_INVALID", detail: `${field} 超过 ${maxChars} 字。` });
  }
}

/**
 * 运行时校验。所有问题一次性返回，调用方据此整体拒绝，不做部分接受。
 */
export function validateNotebookAnalysisResult(
  value: unknown,
  options: NotebookAnalysisValidationOptions
): NotebookAnalysisIssue[] {
  const issues: NotebookAnalysisIssue[] = [];
  if (!isRecord(value)) {
    return [{ code: "RESULT_NOT_OBJECT", detail: "结果必须是 JSON 对象。" }];
  }
  const extra = Object.keys(value).filter((key) => !ALLOWED_TOP_FIELDS.includes(key));
  if (extra.length > 0) {
    issues.push({ code: "RESULT_EXTRA_FIELD", detail: `不接受的字段：${extra.join(",")}。` });
  }

  checkText(issues, value.summary, "summary", NOTEBOOK_ANALYSIS_LIMITS.summaryChars);

  const timeline = checkSection(issues, value, "timeline", NOTEBOOK_ANALYSIS_LIMITS.timeline);
  timeline?.forEach((entry, index) => {
    if (!isRecord(entry)) {
      issues.push({ code: "RESULT_ENTRY_INVALID", detail: `timeline[${index}] 不是对象。` });
      return;
    }
    if (entry.date !== null && !isLocalCalendarDate(entry.date)) {
      issues.push({
        code: "RESULT_DATE_INVALID",
        detail: `timeline[${index}].date 必须是 YYYY-MM-DD 或 null（未知）。`
      });
    }
    checkText(issues, entry.title, `timeline[${index}].title`, NOTEBOOK_ANALYSIS_LIMITS.entryTitleChars);
    checkPageIds(issues, entry.pageIds, options, `timeline[${index}].pageIds`, 1);
    checkBlockIds(issues, entry.blockIds, options, `timeline[${index}].blockIds`);
  });

  const themes = checkSection(issues, value, "themes", NOTEBOOK_ANALYSIS_LIMITS.themes);
  themes?.forEach((entry, index) => {
    if (!isRecord(entry)) {
      issues.push({ code: "RESULT_ENTRY_INVALID", detail: `themes[${index}] 不是对象。` });
      return;
    }
    checkText(issues, entry.name, `themes[${index}].name`, NOTEBOOK_ANALYSIS_LIMITS.entryNameChars);
    checkPageIds(issues, entry.pageIds, options, `themes[${index}].pageIds`, 1);
    checkText(issues, entry.basis, `themes[${index}].basis`, NOTEBOOK_ANALYSIS_LIMITS.entryTextChars);
  });

  const structure = checkSection(issues, value, "structure", NOTEBOOK_ANALYSIS_LIMITS.structure);
  structure?.forEach((entry, index) => {
    if (!isRecord(entry)) {
      issues.push({ code: "RESULT_ENTRY_INVALID", detail: `structure[${index}] 不是对象。` });
      return;
    }
    checkText(
      issues,
      entry.suggestion,
      `structure[${index}].suggestion`,
      NOTEBOOK_ANALYSIS_LIMITS.entryTextChars
    );
    checkPageIds(issues, entry.pageIds, options, `structure[${index}].pageIds`, 0);
  });

  const related = checkSection(issues, value, "related", NOTEBOOK_ANALYSIS_LIMITS.related);
  related?.forEach((entry, index) => {
    if (!isRecord(entry)) {
      issues.push({ code: "RESULT_ENTRY_INVALID", detail: `related[${index}] 不是对象。` });
      return;
    }
    checkPageIds(issues, [entry.pageId], options, `related[${index}].pageId`, 1);
    checkPageIds(issues, [entry.relatedPageId], options, `related[${index}].relatedPageId`, 1);
    if (entry.pageId === entry.relatedPageId) {
      issues.push({
        code: "RESULT_ENTRY_INVALID",
        detail: `related[${index}] 的 pageId 与 relatedPageId 相同。`
      });
    }
    checkText(issues, entry.reason, `related[${index}].reason`, NOTEBOOK_ANALYSIS_LIMITS.entryTextChars);
  });

  const duplicates = checkSection(
    issues,
    value,
    "duplicates",
    NOTEBOOK_ANALYSIS_LIMITS.duplicates
  );
  duplicates?.forEach((entry, index) => {
    if (!isRecord(entry)) {
      issues.push({ code: "RESULT_ENTRY_INVALID", detail: `duplicates[${index}] 不是对象。` });
      return;
    }
    checkPageIds(issues, entry.pageIds, options, `duplicates[${index}].pageIds`, 2);
    checkText(
      issues,
      entry.reason,
      `duplicates[${index}].reason`,
      NOTEBOOK_ANALYSIS_LIMITS.entryTextChars
    );
  });

  const gaps = checkSection(issues, value, "gaps", NOTEBOOK_ANALYSIS_LIMITS.gaps);
  gaps?.forEach((entry, index) => {
    if (!isRecord(entry)) {
      issues.push({ code: "RESULT_ENTRY_INVALID", detail: `gaps[${index}] 不是对象。` });
      return;
    }
    checkText(
      issues,
      entry.suggestion,
      `gaps[${index}].suggestion`,
      NOTEBOOK_ANALYSIS_LIMITS.entryTextChars
    );
    checkText(issues, entry.basis, `gaps[${index}].basis`, NOTEBOOK_ANALYSIS_LIMITS.entryTextChars);
  });

  return issues;
}

export class NotebookAnalysisResultError extends Error {
  readonly issues: NotebookAnalysisIssue[];
  constructor(issues: NotebookAnalysisIssue[]) {
    super(`AI_NOTEBOOK_RESULT_INVALID:${issues.map((issue) => issue.code).join(",")}`);
    this.name = "NotebookAnalysisResultError";
    this.issues = issues;
  }
}

export function assertNotebookAnalysisResult(
  value: unknown,
  options: NotebookAnalysisValidationOptions
): NotebookAnalysisResult {
  const issues = validateNotebookAnalysisResult(value, options);
  if (issues.length > 0) throw new NotebookAnalysisResultError(issues);
  return value as NotebookAnalysisResult;
}

/** 解析模型返回的 JSON 文本；不合法即失败，不做文本抢救。 */
export function parseNotebookAnalysisResult(
  content: string,
  options: NotebookAnalysisValidationOptions
): NotebookAnalysisResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new NotebookAnalysisResultError([
      { code: "RESULT_INVALID_JSON", detail: "模型返回的内容不是有效 JSON。" }
    ]);
  }
  return assertNotebookAnalysisResult(parsed, options);
}
