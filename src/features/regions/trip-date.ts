/**
 * 旅行日期（M2）：范围、精度与明确来源的纯函数。
 *
 * 语义：
 * - 精度表达"部分日期"：year="2026"、month="2026-05"；显示与排序按精度，
 *   不得伪装成具体某天；
 * - 旧字段 `tripDate`（"yyyy-mm-dd" 或 null）读模型兼容为 day 精度；
 * - 相交判定用于年度筛选：区间 [from, to??from] 与 [年初, 年末] 有交集即命中；
 * - 未知日期保持未知：无 tripDateRange 且无 tripDate = 未设置；
 *   创建时间/上传时间/GPS 确认时间一律不参与。
 */

import type { TripDateRange } from "@/features/notebook/notebook-model";

export type { TripDateRange } from "@/features/notebook/notebook-model";

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) return 29;
  return DAYS_IN_MONTH[month - 1];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 日历合法性：月份 01–12、天数符合该月（含闰年二月）。 */
export function isValidCalendarDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const [yearText, monthText, dayText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (month < 1 || month > 12) return false;
  return day >= 1 && day <= daysInMonth(year, month);
}

/** 形状校验 + 区间归一（from ≤ to；单点 to=null）。非法返回 null。 */
export function normalizeTripDateRange(value: unknown): TripDateRange | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<TripDateRange>;
  if (
    typeof candidate.from !== "string" ||
    !isValidCalendarDate(candidate.from) ||
    (candidate.to !== null && (typeof candidate.to !== "string" || !isValidCalendarDate(candidate.to))) ||
    (candidate.precision !== "day" && candidate.precision !== "month" && candidate.precision !== "year") ||
    candidate.basis !== "manual"
  ) {
    return null;
  }
  const from = candidate.from;
  const to = candidate.to ?? from;
  if (to < from) return null;
  return { from, to: candidate.to === from ? null : candidate.to, precision: candidate.precision, basis: "manual" };
}

/**
 * 解析用户输入为规范区间：
 * - precision=year：值 "2026" → 2026-01-01..2026-12-31；
 * - precision=month："2026-05" → 当月整月；
 * - precision=day："2026-05-15"（to 可选且 ≥ from）。
 */
export function parseTripDateInput(input: {
  precision: TripDateRange["precision"];
  value: string;
  toValue?: string;
}): TripDateRange | { error: string } {
  const { precision } = input;
  const value = input.value.trim();
  if (precision === "year") {
    if (!/^\d{4}$/.test(value)) return { error: "年份格式应为 yyyy（如 2026）。" };
    const year = Number(value);
    const feb = isLeapYear(year) ? 29 : 28;
    return {
      from: `${value}-01-01`,
      to: `${value}-12-31`,
      precision,
      basis: "manual"
    };
  }
  if (precision === "month") {
    if (!/^\d{4}-\d{2}$/.test(value)) return { error: "月份格式应为 yyyy-mm（如 2026-05）。" };
    const [yearText, monthText] = value.split("-");
    const year = Number(yearText);
    const month = Number(monthText);
    if (month < 1 || month > 12) return { error: "月份应在 01–12。" };
    return {
      from: `${value}-01`,
      to: `${value}-${String(daysInMonth(year, month)).padStart(2, "0")}`,
      precision,
      basis: "manual"
    };
  }
  if (!isValidCalendarDate(value)) return { error: "日期不存在（请检查月份与天数，含闰年二月）。" };
  const toValue = input.toValue?.trim();
  if (toValue) {
    if (!isValidCalendarDate(toValue)) return { error: "结束日期不存在（请检查月份与天数）。" };
    if (toValue < value) return { error: "结束日期不能早于开始日期。" };
    return { from: value, to: toValue === value ? null : toValue, precision: "day", basis: "manual" };
  }
  return { from: value, to: null, precision: "day", basis: "manual" };
}

/** 读模型：meta 的有效日期（tripDateRange 优先；旧 tripDate 按 day 兼容）。 */
export function effectiveTripDateRange(meta: {
  tripDateRange?: unknown;
  tripDate?: string | null;
} | undefined): TripDateRange | null {
  const range = normalizeTripDateRange(meta?.tripDateRange);
  if (range) return range;
  const legacy = meta?.tripDate;
  // P2（N23）：旧 tripDate 也做日历校验——"2026-02-30" 等非法值在
  // 读取时按未设置处理（保守），不冒充有效日期参与筛选/回放。
  if (typeof legacy === "string" && isValidCalendarDate(legacy)) {
    return { from: legacy, to: null, precision: "day", basis: "manual" };
  }
  return null;
}

/** 区间与某年是否相交（年度筛选；边界日含）。 */
export function rangeIntersectsYear(range: TripDateRange, year: number): boolean {
  const to = range.to ?? range.from;
  return range.from <= `${year}-12-31` && to >= `${year}-01-01`;
}

/** 按精度显示：year→"2026 年"；month→"2026 年 5 月"；day→单日或起止区间。 */
export function formatTripDateRange(range: TripDateRange): string {
  const [year, month, day] = range.from.split("-");
  if (range.precision === "year") return `${year} 年`;
  if (range.precision === "month") return `${year} 年 ${Number(month)} 月`;
  const to = range.to ?? range.from;
  if (to === range.from) return `${year}-${month}-${day}`;
  const [toYear, toMonth, toDay] = to.split("-");
  return `${year}-${month}-${day} 至 ${toYear}-${toMonth}-${toDay}`;
}

/** 排序键（from 升序）：同 from 视为并列，调用方不得据此虚构先后。 */
export function tripDateSortKey(range: TripDateRange): string {
  return range.from;
}
