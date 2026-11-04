/**
 * P6：Trip / Place 与关系的**命令层**（纯计划 + 一次事务提交）。
 *
 * 职责（只有两个）：
 * 1. `planTripCommand`：在给定档案上算出新档案，并在**计划阶段**完成校验
 *    （目标存在/未永久删除、唯一键、删除状态、输入合法性）。相同键相同内容 = no-op；
 *    相同键不同内容 = conflict（不覆盖、不拼接）。
 * 2. `commitTripCommand`：把计划交给既有 `commitJournalChange`（同一 IndexedDB 事务 +
 *    `expectedRevision` CAS + 事务内重读最新档案），不新建 Repository/事务框架。
 *
 * 边界：
 * - 不在这里读写 IndexedDB、不发模型请求、不做 AI/EXIF 提取或地理编码；
 * - 永久删除 Trip/Place 在同一命令内清关系 + 写墓碑；永久删除 Page/本册级联由
 *   `purgeTrash` 走 `applyPurge`（同一事务，见 notebook-model）。
 * - 损坏记录不被静默过滤：目标查找走 `lookupWritableRecord`（复用记录校验），
 *   命中的记录没通过校验就**明确拒绝**；关系表只对通过校验的行做匹配，坏行原样保留。
 *   命令不做整表检查，也不清理坏记录——合法记录的正常操作不能因为别处一条坏数据而全部停摆。
 */
import type { ArchiveCore, NotebookRepository } from "../notebook/notebook-repository";
import { RevisionConflictError } from "../notebook/notebook-repository";
import {
  EMPTY_TRIP_SLICE,
  isPlaceRecord,
  isTripRecord,
  lookupWritableRecord,
  purgePlaceInSlice,
  purgeTripInSlice,
  readTripSlice,
  removePagePlaceLink,
  removeTripPageLink,
  upsertPagePlaceLink,
  upsertTripPageLink,
  validatePagePlaceLink,
  validatePlace,
  validateTrip,
  type PagePlaceLink,
  type PagePlaceLinkSource,
  type Place,
  type Trip,
  type TripArchiveSlice,
  type TripIssue,
  type TripPageLink,
  type UpsertResult
} from "./trip-model";

/** 命令被拒绝时的明确结论（调用方据此显示可见错误，不静默吞掉）。 */
export class TripCommandError extends Error {
  constructor(
    readonly code:
      | "TRIP_NOT_FOUND"
      | "TRIP_PURGED"
      | "TRIP_DELETED"
      | "TRIP_RECORD_INVALID"
      | "PLACE_NOT_FOUND"
      | "PLACE_PURGED"
      | "PLACE_DELETED"
      | "PLACE_RECORD_INVALID"
      | "PAGE_NOT_FOUND"
      | "PAGE_PURGED"
      | "PAGE_DELETED"
      | "LINK_CONFLICT"
      | "INPUT_INVALID",
    readonly detail: string,
    readonly issues: TripIssue[] = []
  ) {
    super(`TRIP_COMMAND_${code}:${detail}`);
    this.name = "TripCommandError";
  }
}

export type TripCommand =
  | {
      kind: "create-trip";
      id: string;
      title: string;
      startDate: string | null;
      endDate: string | null;
    }
  | {
      kind: "update-trip";
      id: string;
      title?: string;
      startDate?: string | null;
      endDate?: string | null;
    }
  | { kind: "soft-delete-trip"; id: string }
  | { kind: "restore-trip"; id: string }
  | { kind: "purge-trip"; id: string }
  | {
      kind: "create-place";
      id: string;
      name: string;
      aliases?: string[];
      coordinates?: { latitude: number; longitude: number };
      address?: string;
      regionId?: string;
    }
  | {
      kind: "update-place";
      id: string;
      name?: string;
      aliases?: string[];
      coordinates?: { latitude: number; longitude: number } | null;
      address?: string | null;
      regionId?: string | null;
    }
  | { kind: "soft-delete-place"; id: string }
  | { kind: "restore-place"; id: string }
  | { kind: "purge-place"; id: string }
  | { kind: "link-trip-page"; tripId: string; pageId: string; role?: "primary" | "reference" }
  | { kind: "unlink-trip-page"; tripId: string; pageId: string }
  | {
      kind: "link-page-place";
      pageId: string;
      placeId: string;
      source: PagePlaceLinkSource;
      confidence?: number;
      mentionText?: string;
    }
  | { kind: "unlink-page-place"; pageId: string; placeId: string; source: PagePlaceLinkSource };

export type TripCommandOutcome =
  | { status: "applied"; archive: ArchiveCore; revision: number }
  | { status: "no-op"; archive: ArchiveCore; revision: number }
  | { status: "conflict"; code: string; detail: string };

type PlanResult =
  | { ok: true; slice: TripArchiveSlice; noop: boolean; entity?: Trip | Place }
  | { ok: false; code: string; detail: string; issues?: TripIssue[] };

function issueText(issues: TripIssue[]): string {
  return issues.map((issue) => `${issue.code}:${issue.detail}`).join("；");
}

const TRIP_SLICE_KEYS: (keyof TripArchiveSlice)[] = [
  "trips",
  "places",
  "tripPageLinks",
  "pagePlaceLinks",
  "purgedTrips",
  "purgedPlaces"
];

/**
 * 严格读取切片：非数组容器必须先拒绝（`readTripSlice` 会把它们当空，不能用于写入路径），
 * 记录级损坏则原样保留由 `inspectTripStore` 报告，绝不静默过滤。
 */
function readStrictTripSlice(source: Partial<TripArchiveSlice>): TripArchiveSlice {
  const raw = source as unknown as Record<string, unknown>;
  for (const key of TRIP_SLICE_KEYS) {
    const value = raw[key];
    if (value !== undefined && value !== null && !Array.isArray(value)) {
      throw new TripCommandError("INPUT_INVALID", `${String(key)} 不是数组，拒绝写入。`);
    }
  }
  return readTripSlice(source);
}

/** 损坏目标：明确拒绝，不修改、不依赖（错误信息里给出可执行的下一步）。 */
function damagedTarget(code: "TRIP_RECORD_INVALID" | "PLACE_RECORD_INVALID"): PlanResult {
  const what = code === "TRIP_RECORD_INVALID" ? "旅行" : "地点";
  return {
    ok: false,
    code,
    detail: `目标${what}记录已损坏（未通过记录校验），拒绝对它写入；请先修复或清理该条记录。`
  };
}

function missingTrip(purgedTripIds: ReadonlySet<string>, id: string): PlanResult {
  return purgedTripIds.has(id)
    ? { ok: false, code: "TRIP_PURGED", detail: "该旅行已被永久删除。" }
    : { ok: false, code: "TRIP_NOT_FOUND", detail: "旅行不存在。" };
}

function missingPlace(purgedPlaceIds: ReadonlySet<string>, id: string): PlanResult {
  return purgedPlaceIds.has(id)
    ? { ok: false, code: "PLACE_PURGED", detail: "该地点已被永久删除。" }
    : { ok: false, code: "PLACE_NOT_FOUND", detail: "地点不存在。" };
}

/**
 * 计划一次命令：返回新切片或明确的拒绝结论。
 * 只做纯计算与校验，不触碰存储。
 */
export function planTripCommand(
  archive: Pick<ArchiveCore, "pages" | "purgedPages"> & Partial<TripArchiveSlice>,
  command: TripCommand,
  now: () => Date = () => new Date()
): PlanResult {
  const slice = readStrictTripSlice(archive);
  const timestamp = now().toISOString();
  const purgedTripIds = new Set(slice.purgedTrips.map((record) => record.id));
  const purgedPlaceIds = new Set(slice.purgedPlaces.map((record) => record.id));
  const pageById = new Map(archive.pages.map((page) => [page.id, page] as const));
  const purgedPageIds = new Set(archive.purgedPages.map((record) => record.pageId));

  const requirePage = (pageId: string): PlanResult | null => {
    if (purgedPageIds.has(pageId)) {
      return { ok: false, code: "PAGE_PURGED", detail: "目标篇已被永久删除，不能建立关系。" };
    }
    const page = pageById.get(pageId);
    if (!page) return { ok: false, code: "PAGE_NOT_FOUND", detail: "目标篇不存在。" };
    if (typeof page.deletedAt === "string" && page.deletedAt.length > 0) {
      return { ok: false, code: "PAGE_DELETED", detail: "目标篇在垃圾桶里，先恢复再关联。" };
    }
    return null;
  };

  switch (command.kind) {
    case "create-trip": {
      const issues = validateTrip({
        title: command.title,
        startDate: command.startDate,
        endDate: command.endDate
      });
      if (issues.length > 0) {
        return { ok: false, code: "INPUT_INVALID", detail: issueText(issues), issues };
      }
      if (lookupWritableRecord(slice.trips, command.id, isTripRecord).status !== "missing" || purgedTripIds.has(command.id)) {
        return { ok: false, code: "INPUT_INVALID", detail: "旅行 ID 已存在，拒绝复用。" };
      }
      const trip: Trip = {
        id: command.id,
        title: command.title.trim(),
        startDate: command.startDate,
        endDate: command.endDate,
        createdAt: timestamp,
        updatedAt: timestamp,
        deletedAt: null
      };
      return { ok: true, slice: { ...slice, trips: [...slice.trips, trip] }, noop: false, entity: trip };
    }

    case "update-trip": {
      const found = lookupWritableRecord(slice.trips, command.id, isTripRecord);
      if (found.status === "damaged") return damagedTarget("TRIP_RECORD_INVALID");
      if (found.status === "missing") return missingTrip(purgedTripIds, command.id);
      const existing = found.record;
      const next: Trip = {
        ...existing,
        ...(command.title !== undefined ? { title: command.title.trim() } : {}),
        ...(command.startDate !== undefined ? { startDate: command.startDate } : {}),
        ...(command.endDate !== undefined ? { endDate: command.endDate } : {})
      };
      const issues = validateTrip({
        title: next.title,
        startDate: next.startDate,
        endDate: next.endDate
      });
      if (issues.length > 0) {
        return { ok: false, code: "INPUT_INVALID", detail: issueText(issues), issues };
      }
      const unchanged =
        next.title === existing.title &&
        next.startDate === existing.startDate &&
        next.endDate === existing.endDate;
      if (unchanged) return { ok: true, slice, noop: true, entity: existing };
      const updated: Trip = { ...next, updatedAt: timestamp };
      return {
        ok: true,
        slice: {
          ...slice,
          // 只替换命中的**合法**行；损坏行原样保留（不得被 map 顺手清理或打崩）。
          trips: slice.trips.map((trip) =>
            isTripRecord(trip) && trip.id === updated.id ? updated : trip
          )
        },
        noop: false,
        entity: updated
      };
    }

    case "soft-delete-trip":
    case "restore-trip": {
      const found = lookupWritableRecord(slice.trips, command.id, isTripRecord);
      if (found.status === "damaged") return damagedTarget("TRIP_RECORD_INVALID");
      if (found.status === "missing") return missingTrip(purgedTripIds, command.id);
      const existing = found.record;
      const deletedAt = command.kind === "soft-delete-trip" ? timestamp : null;
      if (existing.deletedAt === deletedAt) return { ok: true, slice, noop: true, entity: existing };
      const updated: Trip = { ...existing, deletedAt, updatedAt: timestamp };
      return {
        ok: true,
        slice: {
          ...slice,
          // 只替换命中的**合法**行；损坏行原样保留（不得被 map 顺手清理或打崩）。
          trips: slice.trips.map((trip) =>
            isTripRecord(trip) && trip.id === updated.id ? updated : trip
          )
        },
        noop: false,
        entity: updated
      };
    }

    case "purge-trip": {
      const found = lookupWritableRecord(slice.trips, command.id, isTripRecord);
      if (found.status === "damaged") return damagedTarget("TRIP_RECORD_INVALID");
      if (found.status === "missing") {
        return purgedTripIds.has(command.id)
          ? { ok: true, slice, noop: true }
          : { ok: false, code: "TRIP_NOT_FOUND", detail: "旅行不存在。" };
      }
      // 同一变更内：移除实体 + 写墓碑 + 清掉它的行程关联。
      return { ok: true, slice: purgeTripInSlice(slice, command.id, timestamp), noop: false };
    }

    case "create-place": {
      const issues = validatePlace({
        name: command.name,
        aliases: command.aliases,
        coordinates: command.coordinates,
        address: command.address,
        regionId: command.regionId
      });
      if (issues.length > 0) {
        return { ok: false, code: "INPUT_INVALID", detail: issueText(issues), issues };
      }
      if (lookupWritableRecord(slice.places, command.id, isPlaceRecord).status !== "missing" || purgedPlaceIds.has(command.id)) {
        return { ok: false, code: "INPUT_INVALID", detail: "地点 ID 已存在，拒绝复用。" };
      }
      const place: Place = {
        id: command.id,
        name: command.name.trim(),
        ...(command.aliases && command.aliases.length > 0 ? { aliases: command.aliases } : {}),
        ...(command.coordinates !== undefined ? { coordinates: command.coordinates } : {}),
        ...(command.address ? { address: command.address } : {}),
        ...(command.regionId ? { regionId: command.regionId } : {}),
        createdAt: timestamp,
        updatedAt: timestamp,
        deletedAt: null
      };
      return {
        ok: true,
        slice: { ...slice, places: [...slice.places, place] },
        noop: false,
        entity: place
      };
    }

    case "update-place": {
      const found = lookupWritableRecord(slice.places, command.id, isPlaceRecord);
      if (found.status === "damaged") return damagedTarget("PLACE_RECORD_INVALID");
      if (found.status === "missing") return missingPlace(purgedPlaceIds, command.id);
      const existing = found.record;
      const next: Place = { ...existing };
      if (command.name !== undefined) next.name = command.name.trim();
      if (command.aliases !== undefined) {
        if (command.aliases.length > 0) next.aliases = command.aliases;
        else delete next.aliases;
      }
      if (command.coordinates !== undefined) {
        // `null` 表示把坐标改回“未知”（不是写入 0）。
        if (command.coordinates === null) delete next.coordinates;
        else next.coordinates = command.coordinates;
      }
      if (command.address !== undefined) {
        if (command.address) next.address = command.address;
        else delete next.address;
      }
      if (command.regionId !== undefined) {
        if (command.regionId) next.regionId = command.regionId;
        else delete next.regionId;
      }
      const issues = validatePlace({
        name: next.name,
        aliases: next.aliases,
        coordinates: next.coordinates,
        address: next.address,
        regionId: next.regionId
      });
      if (issues.length > 0) {
        return { ok: false, code: "INPUT_INVALID", detail: issueText(issues), issues };
      }
      const unchanged = JSON.stringify(next) === JSON.stringify(existing);
      if (unchanged) return { ok: true, slice, noop: true, entity: existing };
      const updated: Place = { ...next, updatedAt: timestamp };
      return {
        ok: true,
        slice: {
          ...slice,
          places: slice.places.map((place) =>
            isPlaceRecord(place) && place.id === updated.id ? updated : place
          )
        },
        noop: false,
        entity: updated
      };
    }

    case "soft-delete-place":
    case "restore-place": {
      const found = lookupWritableRecord(slice.places, command.id, isPlaceRecord);
      if (found.status === "damaged") return damagedTarget("PLACE_RECORD_INVALID");
      if (found.status === "missing") return missingPlace(purgedPlaceIds, command.id);
      const existing = found.record;
      const deletedAt = command.kind === "soft-delete-place" ? timestamp : null;
      if (existing.deletedAt === deletedAt) return { ok: true, slice, noop: true, entity: existing };
      const updated: Place = { ...existing, deletedAt, updatedAt: timestamp };
      return {
        ok: true,
        slice: {
          ...slice,
          places: slice.places.map((place) =>
            isPlaceRecord(place) && place.id === updated.id ? updated : place
          )
        },
        noop: false,
        entity: updated
      };
    }

    case "purge-place": {
      const found = lookupWritableRecord(slice.places, command.id, isPlaceRecord);
      if (found.status === "damaged") return damagedTarget("PLACE_RECORD_INVALID");
      if (found.status === "missing") {
        return purgedPlaceIds.has(command.id)
          ? { ok: true, slice, noop: true }
          : { ok: false, code: "PLACE_NOT_FOUND", detail: "地点不存在。" };
      }
      return { ok: true, slice: purgePlaceInSlice(slice, command.id, timestamp), noop: false };
    }

    case "link-trip-page": {
      const found = lookupWritableRecord(slice.trips, command.tripId, isTripRecord);
      if (found.status === "damaged") return damagedTarget("TRIP_RECORD_INVALID");
      if (found.status === "missing") return missingTrip(purgedTripIds, command.tripId);
      const trip = found.record;
      if (trip.deletedAt) {
        return { ok: false, code: "TRIP_DELETED", detail: "该旅行在垃圾桶里，先恢复再关联。" };
      }
      const pageProblem = requirePage(command.pageId);
      if (pageProblem) return pageProblem;
      const next: TripPageLink = {
        tripId: command.tripId,
        pageId: command.pageId,
        ...(command.role ? { role: command.role } : {}),
        addedAt: timestamp
      };
      const upsert = upsertTripPageLink(slice.tripPageLinks, next);
      return linkResult(slice, "tripPageLinks", upsert);
    }

    case "unlink-trip-page": {
      // 用“移除后长度是否变化”判断 no-op：对损坏行同样安全，且只会移除命中行。
      const remaining = removeTripPageLink(slice.tripPageLinks, command);
      if (remaining.length === slice.tripPageLinks.length) return { ok: true, slice, noop: true };
      return { ok: true, slice: { ...slice, tripPageLinks: remaining }, noop: false };
    }

    case "link-page-place": {
      const found = lookupWritableRecord(slice.places, command.placeId, isPlaceRecord);
      if (found.status === "damaged") return damagedTarget("PLACE_RECORD_INVALID");
      if (found.status === "missing") return missingPlace(purgedPlaceIds, command.placeId);
      const place = found.record;
      // R2：与 link-trip-page 同一规则——垃圾桶里的地点不能新增关系（不靠 UI 隐藏按钮）。
      if (place.deletedAt) {
        return { ok: false, code: "PLACE_DELETED", detail: "该地点在垃圾桶里，先恢复再关联。" };
      }
      const pageProblem = requirePage(command.pageId);
      if (pageProblem) return pageProblem;
      const issues = validatePagePlaceLink({
        pageId: command.pageId,
        placeId: command.placeId,
        source: command.source,
        confidence: command.confidence
      });
      if (issues.length > 0) {
        return { ok: false, code: "INPUT_INVALID", detail: issueText(issues), issues };
      }
      const next: PagePlaceLink = {
        pageId: command.pageId,
        placeId: command.placeId,
        source: command.source,
        ...(command.confidence !== undefined ? { confidence: command.confidence } : {}),
        ...(command.mentionText ? { mentionText: command.mentionText } : {}),
        createdAt: timestamp
      };
      const upsert = upsertPagePlaceLink(slice.pagePlaceLinks, next);
      return linkResult(slice, "pagePlaceLinks", upsert);
    }

    case "unlink-page-place": {
      const remaining = removePagePlaceLink(slice.pagePlaceLinks, command);
      if (remaining.length === slice.pagePlaceLinks.length) return { ok: true, slice, noop: true };
      return { ok: true, slice: { ...slice, pagePlaceLinks: remaining }, noop: false };
    }
  }
}

/** 关系 upsert 的三态映射：同键同内容 no-op，不同内容 conflict（不覆盖不拼接）。 */
function linkResult<T extends TripPageLink | PagePlaceLink>(
  slice: TripArchiveSlice,
  key: "tripPageLinks" | "pagePlaceLinks",
  upsert: UpsertResult<T>
): PlanResult {
  if (upsert.result === "conflict") {
    return {
      ok: false,
      code: "LINK_CONFLICT",
      /*
       * F3：键被**损坏行**或同键多行占用时没有合法的 `existing` 可以返回；
       * 两种情况都必须明确可见，并且都不新增、不覆盖、不清理。
       */
      detail: upsert.existing
        ? "已存在同键但内容不同的关系；未覆盖既有记录，请先解除再添加。"
        : "该唯一键已被一条损坏记录（或同键多行）占用；未新增、未覆盖，也未清理既有记录，请先修复或清理损坏数据。"
    };
  }
  if (upsert.result === "noop") return { ok: true, slice, noop: true };
  return {
    ok: true,
    slice: key === "tripPageLinks"
      ? { ...slice, tripPageLinks: upsert.links as TripPageLink[] }
      : { ...slice, pagePlaceLinks: upsert.links as PagePlaceLink[] },
    noop: false
  };
}

/** 计划结果的统一校验入口（供测试与提交路径共用）。 */
export function assertPlan(plan: PlanResult): Extract<PlanResult, { ok: true }> {
  if (!plan.ok) throw new TripCommandError(plan.code as "INPUT_INVALID", plan.detail, plan.issues);
  return plan;
}

/** 把计划写入档案（不改其他字段）。 */
export function applyTripPlan(archive: ArchiveCore, plan: Extract<PlanResult, { ok: true }>): ArchiveCore {
  return { ...archive, ...plan.slice };
}

/**
 * 提交一次命令：复用既有 `commitJournalChange`（同一事务 + 事务内重读 + revision CAS）。
 * 返回乐观并发结论：`applied` / `no-op` / `conflict`（不抛异常给 UI 当崩溃处理）。
 */
export async function commitTripCommand(
  repository: NotebookRepository,
  command: TripCommand,
  options: { expectedRevision?: number; now?: () => Date } = {}
): Promise<TripCommandOutcome> {
  const now = options.now ?? (() => new Date());

  /*
   * 先用当前档案试算：真正的 no-op / 输入非法 / revision 过期都在这里给出结论，
   * **不写事务也不推进 revision**（重复点击、重复关联不应无意义地改动档案）。
   * 事务内仍会基于事务读到的档案重新计划，那才是权威判定。
   */
  const current = await repository.loadArchive();
  if (options.expectedRevision !== undefined && current.revision !== options.expectedRevision) {
    return {
      status: "conflict",
      code: "REVISION_CONFLICT",
      detail: `档案版本冲突（当前 ${current.revision}），未写入；请刷新后重试。`
    };
  }
  const preview = planTripCommand(current, command, now);
  if (!preview.ok) {
    return { status: "conflict", code: preview.code, detail: preview.detail };
  }
  if (preview.noop) {
    return { status: "no-op", archive: current, revision: current.revision };
  }

  let planned: Extract<PlanResult, { ok: true }> | undefined;
  let outcome: TripCommandOutcome;
  try {
    const committed = await repository.commitJournalChange(
      (current) => {
        // 计划在**事务内读到的最新档案**上进行：目标核对与唯一性没有 TOCTOU 窗口。
        const plan = planTripCommand(current, command, now);
        if (!plan.ok) throw new TripCommandError(plan.code as "INPUT_INVALID", plan.detail, plan.issues);
        planned = plan;
        return applyTripPlan(current, plan);
      },
      options.expectedRevision !== undefined
        ? { expectedRevision: options.expectedRevision }
        : {}
    );
    outcome = {
      status: planned?.noop ? "no-op" : "applied",
      archive: committed.archive,
      revision: committed.revision
    };
  } catch (error) {
    if (error instanceof RevisionConflictError) {
      return {
        status: "conflict",
        code: "REVISION_CONFLICT",
        detail: `档案版本冲突（当前 ${error.actualRevision}），未写入；请刷新后重试。`
      };
    }
    if (error instanceof TripCommandError) {
      return { status: "conflict", code: error.code, detail: error.detail };
    }
    throw error;
  }
  return outcome;
}

export { EMPTY_TRIP_SLICE };
