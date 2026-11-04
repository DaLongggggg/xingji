/**
 * P8：Light Agent 的**运行时 Schema**（计划 + 只读分组结果）与预算常量。
 *
 * 边界（与 P1/P4 同一套规则）：
 * - 不用正则从任意文本里抢救 JSON；JSON 解析失败即失败；
 * - 未知工具、额外字段、空数组、非法 `fromStep`、非法 limit 一律整体拒绝，不做部分接受；
 * - 计划里的范围参数只能**收窄**用户冻结的范围（`validatePlanAgainstScope`），
 *   越界/空数组都明确拒绝；空数组不是「全部」；
 * - 分组结果的来源必须**恰好划分**实际读取集合：编造、重复、遗漏都为错误；
 *   模型输出是数据，不是指令。
 *
 * 本模块刻意不 import 检索/仓库模块（只依赖 `ai-task` 的类型与日期校验），
 * 避免 `ai-proposal → schema → search-provider → ai-repository → ai-proposal` 的初始化环。
 * 检索 limit 上限由调用方传入（runner 传 `SEARCH_MAX_LIMIT`），不在这里再写一份常量。
 */
import {
  isValidCollectionDate,
  type CollectionScope
} from "./ai-task";

export const LIGHT_AGENT_BUDGETS = {
  /** 工具调用硬上限（失败与重复调用同样计数）。 */
  maxToolCalls: 6,
  /** 模型请求硬上限：计划 1 次 + 综合 1 次。 */
  maxModelRequests: 2,
  /** 单次运行累计读取篇数。 */
  maxReadPages: 20,
  /** 单次运行累计读取字符（篇标题 + 完整正文；超限拒绝，不静默截正文）。 */
  maxReadChars: 30_000,
  /** 整次运行时长（毫秒）；超时主动取消在途请求。 */
  maxDurationMs: 120_000,
  /** 计划请求的输入/输出字符预算。 */
  maxPlanInputChars: 8_000,
  maxPlanOutputChars: 4_000,
  /** 综合请求的输入/输出字符预算。 */
  maxSynthInputChars: 50_000,
  maxSynthOutputChars: 16_000,
  /** 分组结果上限。 */
  maxGroups: 10
} as const;

/** 计划步数上限 = 工具调用上限（一步一次调用，不额外消耗）。 */
export const LIGHT_AGENT_MAX_STEPS = LIGHT_AGENT_BUDGETS.maxToolCalls;

/**
 * R4：预算覆盖解析——只接受**合法有限值**，且只能**降低**硬上限。
 *
 * - 非数字 / NaN / ±Infinity → 视为非法，保持硬默认（绝不变成隐式无限预算或 0ms 定时器异常）；
 * - 小数、负数 → 向下取整并钳到下限（计数下限 0；`maxDurationMs` 下限 1ms）；
 * - 高于硬上限 → 钳回硬上限：调用方不能抬高外发成本；
 * - 零额度语义明确：0 次请求 / 0 次工具调用 = 一律失败且不发出任何请求。
 *
 * 键集合直接取自 `LIGHT_AGENT_BUDGETS`，新增预算不会漏配。
 */
export function resolveLightAgentBudgets(
  overrides?: Partial<Record<keyof typeof LIGHT_AGENT_BUDGETS, number>>
): Record<keyof typeof LIGHT_AGENT_BUDGETS, number> {
  const resolved: Record<keyof typeof LIGHT_AGENT_BUDGETS, number> = { ...LIGHT_AGENT_BUDGETS };
  for (const key of Object.keys(LIGHT_AGENT_BUDGETS) as (keyof typeof LIGHT_AGENT_BUDGETS)[]) {
    const value = overrides?.[key];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const hardCap = LIGHT_AGENT_BUDGETS[key];
    const floor = key === "maxDurationMs" ? 1 : 0;
    resolved[key] = Math.max(floor, Math.min(hardCap, Math.floor(value)));
  }
  return resolved;
}

// —— 计划 ——

/** `search_pages`：关键词 + 结构过滤（没有语义/混合模式，也不带主题元数据过滤）。 */
export type LightAgentSearchStep = {
  tool: "search_pages";
  query?: string;
  notebookIds?: string[];
  regionIds?: string[];
  tripIds?: string[];
  placeIds?: string[];
  from?: string;
  to?: string;
  limit?: number;
};

/**
 * `read_pages`：读取**前序 search 步骤结果**里的篇。
 *
 * 为什么不接受 pageIds：模型在计划阶段不可能知道检索返回什么 id，
 * 允许它直接写 id 就会把「读取 ID 必须属于合法检索结果」变成一句空话。
 * `fromStep` 是计划内索引，实际 id 由宿主从该步骤结果取出。
 */
export type LightAgentReadStep = {
  tool: "read_pages";
  fromStep: number;
};

export type LightAgentPlanStep = LightAgentSearchStep | LightAgentReadStep;

export type LightAgentPlan = { steps: LightAgentPlanStep[] };

export type LightAgentIssue = { code: string; detail: string };

const PLAN_TOP_FIELDS = ["steps"];
const SEARCH_STEP_FIELDS = [
  "tool",
  "query",
  "notebookIds",
  "regionIds",
  "tripIds",
  "placeIds",
  "from",
  "to",
  "limit"
];
const READ_STEP_FIELDS = ["tool", "fromStep"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** `undefined`（未给）或非空字符串数组；**空数组拒绝**（不是「全部」）。 */
function checkIdArray(
  issues: LightAgentIssue[],
  value: unknown,
  field: string
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || !value.every(isNonEmptyString)) {
    issues.push({
      code: "PLAN_STEP_INVALID",
      detail: `${field} 必须是非空字符串数组；空数组表示没有权限，不被解释为「全部」。`
    });
    return undefined;
  }
  if (new Set(value).size !== value.length) {
    issues.push({ code: "PLAN_STEP_INVALID", detail: `${field} 存在重复项。` });
    return undefined;
  }
  return value;
}

function checkPlanStep(
  issues: LightAgentIssue[],
  value: unknown,
  index: number,
  maxSearchLimit: number
): void {
  if (!isRecord(value)) {
    issues.push({ code: "PLAN_STEP_INVALID", detail: `steps[${index}] 不是对象。` });
    return;
  }
  const tool = value.tool;
  if (tool === "search_pages") {
    const extra = Object.keys(value).filter((key) => !SEARCH_STEP_FIELDS.includes(key));
    if (extra.length > 0) {
      issues.push({
        code: "PLAN_EXTRA_FIELD",
        detail: `steps[${index}] 不接受字段：${extra.join(",")}。`
      });
    }
    if (value.query !== undefined && !isNonEmptyString(value.query)) {
      issues.push({ code: "PLAN_STEP_INVALID", detail: `steps[${index}].query 必须是非空字符串。` });
    } else if (typeof value.query === "string" && value.query.length > 200) {
      issues.push({ code: "PLAN_STEP_INVALID", detail: `steps[${index}].query 超过 200 字。` });
    }
    for (const field of ["notebookIds", "regionIds", "tripIds", "placeIds"] as const) {
      checkIdArray(issues, value[field], `steps[${index}].${field}`);
    }
    for (const field of ["from", "to"] as const) {
      const field$ = value[field];
      if (field$ !== undefined && !isValidCollectionDate(field$)) {
        issues.push({
          code: "PLAN_STEP_INVALID",
          detail: `steps[${index}].${field} 必须是 YYYY-MM-DD。`
        });
      }
    }
    if (
      isValidCollectionDate(value.from) &&
      isValidCollectionDate(value.to) &&
      value.from >= value.to
    ) {
      issues.push({
        code: "PLAN_STEP_INVALID",
        detail: `steps[${index}] 的 from 必须早于 to。`
      });
    }
    if (value.limit !== undefined) {
      const limit = value.limit;
      if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > maxSearchLimit) {
        issues.push({
          code: "PLAN_STEP_INVALID",
          detail: `steps[${index}].limit 必须是 1..${maxSearchLimit} 的整数。`
        });
      }
    }
    return;
  }
  if (tool === "read_pages") {
    const extra = Object.keys(value).filter((key) => !READ_STEP_FIELDS.includes(key));
    if (extra.length > 0) {
      issues.push({
        code: "PLAN_EXTRA_FIELD",
        detail: `steps[${index}] 不接受字段：${extra.join(",")}（读取篇只能由前序检索结果决定）。`
      });
    }
    const fromStep = value.fromStep;
    if (!Number.isInteger(fromStep) || (fromStep as number) < 0 || (fromStep as number) >= index) {
      issues.push({
        code: "PLAN_FROMSTEP_INVALID",
        detail: `steps[${index}].fromStep 必须指向更早的步骤序号。`
      });
    }
    return;
  }
  issues.push({
    code: "PLAN_TOOL_UNKNOWN",
    detail: `steps[${index}] 使用了未注册的工具：${String(tool)}。`
  });
}

/**
 * 计划运行时校验。`maxSearchLimit` 由调用方传入（检索契约上限），
 * 使本模块不依赖检索实现。
 */
export function validateLightAgentPlan(
  value: unknown,
  options: { maxSearchLimit?: number } = {}
): LightAgentIssue[] {
  const maxSearchLimit = options.maxSearchLimit ?? 100;
  const issues: LightAgentIssue[] = [];
  if (!isRecord(value)) {
    return [{ code: "PLAN_NOT_OBJECT", detail: "计划必须是 JSON 对象。" }];
  }
  const extra = Object.keys(value).filter((key) => !PLAN_TOP_FIELDS.includes(key));
  if (extra.length > 0) {
    issues.push({ code: "PLAN_EXTRA_FIELD", detail: `不接受的字段：${extra.join(",")}。` });
  }
  if (!Array.isArray(value.steps)) {
    return [...issues, { code: "PLAN_STEPS_INVALID", detail: "steps 必须是数组。" }];
  }
  if (value.steps.length === 0) {
    issues.push({ code: "PLAN_STEPS_INVALID", detail: "steps 不能为空。" });
  }
  if (value.steps.length > LIGHT_AGENT_MAX_STEPS) {
    issues.push({
      code: "PLAN_TOO_MANY_STEPS",
      detail: `steps 超过 ${LIGHT_AGENT_MAX_STEPS} 步上限。`
    });
  }
  value.steps.forEach((step, index) => checkPlanStep(issues, step, index, maxSearchLimit));
  const tools = value.steps.flatMap((step) =>
    isRecord(step) && typeof step.tool === "string" ? [step.tool] : []
  );
  if (!tools.includes("search_pages")) {
    issues.push({ code: "PLAN_MISSING_SEARCH_STEP", detail: "计划必须至少包含一个 search_pages 步骤。" });
  }
  if (!tools.includes("read_pages")) {
    issues.push({ code: "PLAN_MISSING_READ_STEP", detail: "计划必须至少包含一个 read_pages 步骤。" });
  }
  return issues;
}

export class LightAgentPlanError extends Error {
  readonly issues: LightAgentIssue[];
  constructor(issues: LightAgentIssue[]) {
    super(`AI_LIGHT_AGENT_PLAN_INVALID:${issues.map((issue) => issue.code).join(",")}`);
    this.name = "LightAgentPlanError";
    this.issues = issues;
  }
}

export function parseLightAgentPlan(
  content: string,
  options: { maxSearchLimit?: number } = {}
): LightAgentPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new LightAgentPlanError([
      { code: "PLAN_INVALID_JSON", detail: "模型返回的计划不是有效 JSON。" }
    ]);
  }
  const issues = validateLightAgentPlan(parsed, options);
  if (issues.length > 0) throw new LightAgentPlanError(issues);
  return parsed as LightAgentPlan;
}

function contained(
  authorized: readonly string[] | null,
  requested: readonly string[] | undefined
): boolean {
  if (requested === undefined) return true;
  if (authorized === null) return true;
  const allowed = new Set(authorized);
  return requested.every((id) => allowed.has(id));
}

/**
 * 计划是否只在冻结范围内收窄。
 *
 * - 授权为 `null`（不额外限制）时，模型给什么 id 都只是「更窄」，没有可越界的边界；
 * - 授权为非空集合时，模型给的每个 id 都必须属于它（**不取交集**：越界即拒绝，
 *   不清洗成合法查询，也不把非法 id 静默丢掉）；
 * - 时间：授权侧有下界时，模型 `from` 不能更早；有上界时，`to` 不能更晚。
 */
export function validatePlanAgainstScope(
  plan: LightAgentPlan,
  scope: CollectionScope
): LightAgentIssue[] {
  const issues: LightAgentIssue[] = [];
  plan.steps.forEach((step, index) => {
    if (step.tool !== "search_pages") return;
    const dimensions: [
      "notebookIds" | "regionIds" | "tripIds" | "placeIds",
      readonly string[] | undefined
    ][] = [
      ["notebookIds", step.notebookIds],
      ["regionIds", step.regionIds],
      ["tripIds", step.tripIds],
      ["placeIds", step.placeIds]
    ];
    for (const [field, requested] of dimensions) {
      if (!contained(scope[field], requested)) {
        issues.push({
          code: "PLAN_SCOPE_DENIED",
          detail: `steps[${index}].${field} 超出本次允许的范围。`
        });
      }
    }
    if (scope.from !== null && step.from !== undefined && step.from < scope.from) {
      issues.push({
        code: "PLAN_SCOPE_DENIED",
        detail: `steps[${index}].from 早于本次允许的起始日期。`
      });
    }
    if (scope.to !== null && step.to !== undefined && step.to > scope.to) {
      issues.push({
        code: "PLAN_SCOPE_DENIED",
        detail: `steps[${index}].to 晚于本次允许的结束日期。`
      });
    }
  });
  return issues;
}

// —— 只读分组结果 ——

export type LightAgentGroup = {
  name: string;
  /** 简短分组理由（为什么把这些篇放在一起）。 */
  reason: string;
  pageIds: string[];
};

/**
 * 只读分组提案载荷：**没有任何**可应用写入指令。
 * `ungroupedPageIds` + `groups[*].pageIds` 必须恰好划分实际读取集合。
 */
export type LightAgentResult = {
  title: string;
  groups: LightAgentGroup[];
  ungroupedPageIds: string[];
  coverageNote?: string;
};

export const LIGHT_AGENT_RESULT_LIMITS = {
  titleChars: 200,
  groupNameChars: 80,
  groupReasonChars: 600,
  coverageNoteChars: 600
} as const;

const RESULT_TOP_FIELDS = ["title", "groups", "ungroupedPageIds", "coverageNote"];
const GROUP_FIELDS = ["name", "reason", "pageIds"];

function checkText(
  issues: LightAgentIssue[],
  value: unknown,
  field: string,
  maxChars: number,
  required = true
): void {
  if (value === undefined && !required) return;
  if (!isNonEmptyString(value)) {
    issues.push({ code: "RESULT_GROUP_INVALID", detail: `${field} 必须是非空字符串。` });
    return;
  }
  if (typeof value === "string" && value.length > maxChars) {
    issues.push({ code: "RESULT_GROUP_INVALID", detail: `${field} 超过 ${maxChars} 字。` });
  }
}

/**
 * 运行时校验（含引用白名单与覆盖一致性）。
 * `allowedPageIds` 是**实际成功读取**的篇集合；真实边界（预览冻结、存储读取）必须提供，
 * 省略时只做结构/上限/重复校验，不做引用与覆盖核对。
 */
export function validateLightAgentResult(
  value: unknown,
  options: { allowedPageIds?: ReadonlySet<string> } = {}
): LightAgentIssue[] {
  const issues: LightAgentIssue[] = [];
  if (!isRecord(value)) {
    return [{ code: "RESULT_NOT_OBJECT", detail: "结果必须是 JSON 对象。" }];
  }
  const extra = Object.keys(value).filter((key) => !RESULT_TOP_FIELDS.includes(key));
  if (extra.length > 0) {
    issues.push({ code: "RESULT_EXTRA_FIELD", detail: `不接受的字段：${extra.join(",")}。` });
  }
  checkText(issues, value.title, "title", LIGHT_AGENT_RESULT_LIMITS.titleChars);
  checkText(
    issues,
    value.coverageNote,
    "coverageNote",
    LIGHT_AGENT_RESULT_LIMITS.coverageNoteChars,
    false
  );

  const collected: string[] = [];
  if (!Array.isArray(value.groups)) {
    issues.push({ code: "RESULT_GROUP_INVALID", detail: "groups 必须是数组。" });
  } else {
    if (value.groups.length > LIGHT_AGENT_BUDGETS.maxGroups) {
      issues.push({
        code: "RESULT_TOO_MANY_GROUPS",
        detail: `groups 超过 ${LIGHT_AGENT_BUDGETS.maxGroups} 组上限。`
      });
    }
    value.groups.forEach((group, index) => {
      if (!isRecord(group)) {
        issues.push({ code: "RESULT_GROUP_INVALID", detail: `groups[${index}] 不是对象。` });
        return;
      }
      const groupExtra = Object.keys(group).filter((key) => !GROUP_FIELDS.includes(key));
      if (groupExtra.length > 0) {
        issues.push({
          code: "RESULT_EXTRA_FIELD",
          detail: `groups[${index}] 不接受字段：${groupExtra.join(",")}。`
        });
      }
      checkText(issues, group.name, `groups[${index}].name`, LIGHT_AGENT_RESULT_LIMITS.groupNameChars);
      checkText(
        issues,
        group.reason,
        `groups[${index}].reason`,
        LIGHT_AGENT_RESULT_LIMITS.groupReasonChars
      );
      if (!Array.isArray(group.pageIds) || group.pageIds.length === 0) {
        issues.push({
          code: "RESULT_GROUP_INVALID",
          detail: `groups[${index}].pageIds 必须是非空字符串数组。`
        });
        return;
      }
      if (!group.pageIds.every(isNonEmptyString)) {
        issues.push({
          code: "RESULT_GROUP_INVALID",
          detail: `groups[${index}].pageIds 必须是非空字符串数组。`
        });
        return;
      }
      if (new Set(group.pageIds).size !== group.pageIds.length) {
        issues.push({
          code: "RESULT_PAGE_DUPLICATE",
          detail: `groups[${index}].pageIds 组内存在重复。`
        });
        return;
      }
      collected.push(...group.pageIds);
    });
  }

  const ungrouped = value.ungroupedPageIds;
  if (!Array.isArray(ungrouped) || !ungrouped.every(isNonEmptyString)) {
    issues.push({
      code: "RESULT_GROUP_INVALID",
      detail: "ungroupedPageIds 必须是字符串数组（可以为空数组）。"
    });
  } else {
    collected.push(...ungrouped);
  }

  if (new Set(collected).size !== collected.length) {
    issues.push({ code: "RESULT_PAGE_DUPLICATE", detail: "同一篇被放进了多个分组或重复列出。" });
  }
  const allowedPageIds = options.allowedPageIds;
  if (allowedPageIds === undefined) return issues;
  const unknown = collected.filter((pageId) => !allowedPageIds.has(pageId));
  if (unknown.length > 0) {
    issues.push({
      code: "RESULT_PAGE_UNKNOWN",
      detail: `引用了本次未读取的篇：${unknown.join(",")}。`
    });
  }
  if (issues.length === 0) {
    const expected = [...allowedPageIds];
    const missing = expected.filter((pageId) => !collected.includes(pageId));
    if (missing.length > 0 || collected.length !== expected.length) {
      issues.push({
        code: "RESULT_COVERAGE_MISMATCH",
        detail:
          `分组与未归组必须恰好覆盖本次读取的 ${expected.length} 篇；` +
          `遗漏或多余：${(missing.length > 0 ? missing : collected).join(",")}。`
      });
    }
  }
  return issues;
}

export class LightAgentResultError extends Error {
  readonly issues: LightAgentIssue[];
  constructor(issues: LightAgentIssue[]) {
    super(`AI_LIGHT_AGENT_RESULT_INVALID:${issues.map((issue) => issue.code).join(",")}`);
    this.name = "LightAgentResultError";
    this.issues = issues;
  }
}

export function parseLightAgentResult(
  content: string,
  options: { allowedPageIds?: ReadonlySet<string> } = {}
): LightAgentResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new LightAgentResultError([
      { code: "RESULT_INVALID_JSON", detail: "模型返回的结果不是有效 JSON。" }
    ]);
  }
  const issues = validateLightAgentResult(parsed, options);
  if (issues.length > 0) throw new LightAgentResultError(issues);
  return parsed as LightAgentResult;
}

/** 供应商结构化输出用的 JSON Schema（服务端固定定义），与上方校验器保持一致。 */
export const LIGHT_AGENT_PLAN_RESULT_SCHEMA = {
  name: "organize_collection_plan",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["steps"],
    properties: {
      steps: {
        type: "array",
        minItems: 1,
        maxItems: LIGHT_AGENT_MAX_STEPS,
        items: {
          type: "object",
          required: ["tool"],
          properties: {
            tool: { type: "string", enum: ["search_pages", "read_pages"] },
            query: { type: "string" },
            notebookIds: { type: "array", items: { type: "string" } },
            regionIds: { type: "array", items: { type: "string" } },
            tripIds: { type: "array", items: { type: "string" } },
            placeIds: { type: "array", items: { type: "string" } },
            from: { type: "string" },
            to: { type: "string" },
            limit: { type: "integer" },
            fromStep: { type: "integer" }
          }
        }
      }
    }
  }
} as const;

export const LIGHT_AGENT_GROUPING_RESULT_SCHEMA = {
  name: "organize_collection_groups",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["title", "groups", "ungroupedPageIds"],
    properties: {
      title: { type: "string" },
      groups: {
        type: "array",
        maxItems: LIGHT_AGENT_BUDGETS.maxGroups,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "reason", "pageIds"],
          properties: {
            name: { type: "string" },
            reason: { type: "string" },
            pageIds: { type: "array", minItems: 1, items: { type: "string" } }
          }
        }
      },
      ungroupedPageIds: { type: "array", items: { type: "string" } },
      coverageNote: { type: "string" }
    }
  }
} as const;
