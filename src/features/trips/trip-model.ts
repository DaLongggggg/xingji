/**
 * P6：Trip / Place 与篇的多对多关系——**纯领域规则与校验**。
 *
 * 本文件只定义当前领域约束，**没有任何持久化**：
 * 不读 IndexedDB、不建 Repository/Manager/占位接口、不写业务数据、不新增证据历史表。
 * 存在的唯一理由：把“身份、唯一约束、日期与坐标合法性、来源保留、悬挂/墓碑判定、
 * 永久删除的关系清理、损坏记录的显式报告”这些无副作用规则固定下来，
 * 供领域校验与隔离测试使用；业务写入由既有 `commitJournalChange` 承担。
 *
 * 边界（复核后收敛）：
 * - 不使用供应商 ID 作为领域身份（供应商引用只在 providerRefs 里）；
 * - 坐标只有 `undefined` 表示未知；合法 WGS84 的 `(0,0)` 是**有效坐标**，不是哨兵值；
 * - 来源不做“强弱排名”：`user`/`exif`/`ai` 各行独立保留，界面可聚合展示但不合并来源；
 * - 相同唯一键且内容相同 = no-op；内容不同 = 明确冲突结果，不静默覆盖、不拼接证据；
 * - 损坏记录**原样保留并明确报告**，不静默过滤后写回（防数据丢失）。
 */

/** 身份前缀：应用自有 ID，与既有 `createNotebookId`/`createPage` 风格一致。 */
export const TRIP_ID_PREFIX = "trip";
export const PLACE_ID_PREFIX = "place";

export const TRIP_LIMITS = {
  titleChars: 120,
  dateChars: 10
} as const;

export const PLACE_LIMITS = {
  nameChars: 120,
  aliasChars: 60,
  aliasCount: 12,
  addressChars: 200
} as const;

/** 关系的来源；`user` 表示用户显式手动关联，`ai`/`exif` 是派生候选/证据。 */
export type PagePlaceLinkSource = "user" | "ai" | "exif";

/** 当地日历日期 `YYYY-MM-DD`；未知一律用 null，不用空串或哨兵日期。 */
export type CalendarDate = string | null;

export type Trip = {
  id: string;
  title: string;
  startDate: CalendarDate;
  endDate: CalendarDate;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type PlaceProviderRef = {
  provider: "amap" | "google" | "osm" | "manual";
  externalId?: string;
};

export type PlaceCoordinates = { latitude: number; longitude: number };

export type Place = {
  id: string;
  name: string;
  aliases?: string[];
  coordinates?: PlaceCoordinates;
  address?: string;
  regionId?: string;
  providerRefs?: PlaceProviderRef[];
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type TripPageLink = {
  tripId: string;
  pageId: string;
  role?: "primary" | "reference";
  addedAt: string;
};

export type PagePlaceLink = {
  pageId: string;
  placeId: string;
  source: PagePlaceLinkSource;
  confidence?: number;
  mentionText?: string;
  createdAt: string;
};

/** 永久删除终态记录：只留身份（与既有 `PurgedPageRecord` 同构）。 */
export type PurgedTargetRecord = { id: string; purgedAt: string };

/**
 * P6 在档案里的六个数组。
 *
 * 这是一个**结构切片**而不是新存储：实施时它们是 `ArchiveCore` 的字段，
 * 本文件只对切片做纯变更，写入仍由既有 `commitJournalChange` 完成。
 */
export type TripArchiveSlice = {
  trips: Trip[];
  places: Place[];
  tripPageLinks: TripPageLink[];
  pagePlaceLinks: PagePlaceLink[];
  purgedTrips: PurgedTargetRecord[];
  purgedPlaces: PurgedTargetRecord[];
};

export const EMPTY_TRIP_SLICE: TripArchiveSlice = {
  trips: [],
  places: [],
  tripPageLinks: [],
  pagePlaceLinks: [],
  purgedTrips: [],
  purgedPlaces: []
};

export type TripIssue = {
  code:
    | "TRIP_TITLE_INVALID"
    | "TRIP_DATE_INVALID"
    | "TRIP_DATE_RANGE_INVALID"
    | "PLACE_NAME_INVALID"
    | "PLACE_ALIAS_INVALID"
    | "PLACE_COORDINATES_INVALID"
    | "PLACE_REGION_INVALID"
    | "PLACE_PROVIDER_REF_INVALID"
    | "LINK_SOURCE_INVALID"
    | "LINK_CONFIDENCE_INVALID"
    | "LINK_TARGET_INVALID"
    | "TRIP_RECORD_INVALID"
    | "PLACE_RECORD_INVALID"
    | "TRIP_LINK_RECORD_INVALID"
    | "PLACE_LINK_RECORD_INVALID"
    | "PURGED_RECORD_INVALID"
    | "STORE_NOT_ARRAY"
    | "STORE_RECORD_INVALID"
    | "STORE_DUPLICATE_KEY"
    | "PURGED_TARGET_RESURRECT";
  detail: string;
};

// —— 基础校验 ——

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * UTC 时间戳（ISO 8601）。
 *
 * R1：只做“非空且不太长”的形状校验不算校验——`createdAt: "broken"` 这类字符串
 * 必须被判为非法，否则损坏记录会被当成可写目标。
 */
function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 40) return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

/** 合法日历日期（含闰年与每月天数）。 */
export function isLocalCalendarDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(Number(match[1]), month, 0)).getUTCDate();
}

/** 规范化为日历日期：空/缺省 → null；非法（含非字符串）→ undefined（表示“要拒绝”）。 */
export function normalizeCalendarDate(value: unknown): CalendarDate | undefined {
  if (value === null || value === undefined || value === "") return null;
  return isLocalCalendarDate(value) ? value : undefined;
}

/** 起止顺序：都已知时必须 start<=end；只有一个或都未知都合法。 */
export function validateTripDateRange(input: {
  startDate: unknown;
  endDate: unknown;
}): TripIssue[] {
  const issues: TripIssue[] = [];
  const start = normalizeCalendarDate(input.startDate);
  const end = normalizeCalendarDate(input.endDate);
  if (start === undefined) {
    issues.push({
      code: "TRIP_DATE_INVALID",
      detail: `startDate 必须是 YYYY-MM-DD 的合法日历日期或 null（当前：${String(input.startDate)}）。`
    });
  }
  if (end === undefined) {
    issues.push({
      code: "TRIP_DATE_INVALID",
      detail: `endDate 必须是 YYYY-MM-DD 的合法日历日期或 null（当前：${String(input.endDate)}）。`
    });
  }
  if (start && end && start > end) {
    issues.push({
      code: "TRIP_DATE_RANGE_INVALID",
      detail: `起始日期 ${start} 晚于结束日期 ${end}。`
    });
  }
  return issues;
}

export function validateTrip(input: {
  title: unknown;
  startDate: unknown;
  endDate: unknown;
}): TripIssue[] {
  const issues: TripIssue[] = [];
  if (!isNonEmptyString(input.title) || input.title.trim().length > TRIP_LIMITS.titleChars) {
    issues.push({
      code: "TRIP_TITLE_INVALID",
      detail: `标题必须是 1..${TRIP_LIMITS.titleChars} 字的非空字符串。`
    });
  }
  return [...issues, ...validateTripDateRange(input)];
}

/**
 * WGS84 范围校验（有限数）。
 * `(0,0)` 是**合法坐标**（几内亚湾），本函数不排斥它；只有类型/有限性/越界才拒绝。
 */
export function isValidWgs84Coordinates(value: unknown): value is PlaceCoordinates {
  if (!isRecord(value)) return false;
  const { latitude, longitude } = value as Partial<PlaceCoordinates>;
  return (
    typeof latitude === "number" &&
    typeof longitude === "number" &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

/**
 * 是否可以在地图上画点：有合法坐标且未删除。
 * 未知坐标用 `undefined` 表达（不转换成 0），因此不会生成地图点；
 * 但合法 `(0,0)` 会产生一个真实点，这是正确行为。
 */
export function isMappablePlace(place: Pick<Place, "coordinates" | "deletedAt">): boolean {
  if (place.deletedAt) return false;
  if (place.coordinates === undefined) return false;
  return isValidWgs84Coordinates(place.coordinates);
}

export function normalizeAliases(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed.length === 0 || trimmed.length > PLACE_LIMITS.aliasChars) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result.slice(0, PLACE_LIMITS.aliasCount);
}

export function validatePlace(input: {
  name: unknown;
  aliases?: unknown;
  coordinates?: unknown;
  address?: unknown;
  regionId?: unknown;
  providerRefs?: unknown;
}): TripIssue[] {
  const issues: TripIssue[] = [];
  if (!isNonEmptyString(input.name) || input.name.trim().length > PLACE_LIMITS.nameChars) {
    issues.push({
      code: "PLACE_NAME_INVALID",
      detail: `名称必须是 1..${PLACE_LIMITS.nameChars} 字的非空字符串。`
    });
  }
  if (input.aliases !== undefined) {
    if (!Array.isArray(input.aliases)) {
      issues.push({ code: "PLACE_ALIAS_INVALID", detail: "aliases 必须是字符串数组。" });
    } else {
      const hasInvalid = input.aliases.some(
        (alias) =>
          typeof alias !== "string" ||
          alias.trim().length === 0 ||
          alias.trim().length > PLACE_LIMITS.aliasChars
      );
      if (hasInvalid) {
        issues.push({
          code: "PLACE_ALIAS_INVALID",
          detail: `别名必须是非空且不超过 ${PLACE_LIMITS.aliasChars} 字的字符串。`
        });
      }
    }
  }
  if (input.coordinates !== undefined && input.coordinates !== null) {
    if (!isValidWgs84Coordinates(input.coordinates)) {
      issues.push({
        code: "PLACE_COORDINATES_INVALID",
        detail: "坐标必须是 WGS84 范围内的有限数值（纬度 -90..90、经度 -180..180）；未知请省略。"
      });
    }
  }
  if (input.address !== undefined && input.address !== null) {
    if (typeof input.address !== "string" || input.address.length > PLACE_LIMITS.addressChars) {
      issues.push({
        code: "PLACE_NAME_INVALID",
        detail: `地址必须是不超过 ${PLACE_LIMITS.addressChars} 字的字符串。`
      });
    }
  }
  if (input.regionId !== undefined && input.regionId !== null && !isNonEmptyString(input.regionId)) {
    issues.push({ code: "PLACE_REGION_INVALID", detail: "regionId 必须是非空字符串或省略。" });
  }
  if (input.providerRefs !== undefined) {
    if (!Array.isArray(input.providerRefs)) {
      issues.push({
        code: "PLACE_PROVIDER_REF_INVALID",
        detail: "providerRefs 必须是数组。"
      });
    } else {
      for (const ref of input.providerRefs) {
        const candidate = ref as Partial<PlaceProviderRef>;
        const providerOk =
          candidate?.provider === "amap" ||
          candidate?.provider === "google" ||
          candidate?.provider === "osm" ||
          candidate?.provider === "manual";
        const externalOk =
          candidate?.externalId === undefined || isNonEmptyString(candidate.externalId);
        // manual 允许没有 externalId；其它供应商引用必须有外部 ID 才可追溯。
        if (!providerOk || !externalOk || (candidate?.provider !== "manual" && !candidate?.externalId)) {
          issues.push({
            code: "PLACE_PROVIDER_REF_INVALID",
            detail: "供应商引用不合法（provider 必须是 amap/google/osm/manual，且非 manual 需要 externalId）。"
          });
        }
      }
    }
  }
  return issues;
}

export function validatePagePlaceLink(input: {
  pageId: unknown;
  placeId: unknown;
  source: unknown;
  confidence?: unknown;
}): TripIssue[] {
  const issues: TripIssue[] = [];
  if (!isNonEmptyString(input.pageId) || !isNonEmptyString(input.placeId)) {
    issues.push({ code: "LINK_TARGET_INVALID", detail: "pageId 与 placeId 必须是非空字符串。" });
  }
  if (input.source !== "user" && input.source !== "ai" && input.source !== "exif") {
    issues.push({
      code: "LINK_SOURCE_INVALID",
      detail: "source 必须是 user / ai / exif。"
    });
  }
  if (input.confidence !== undefined && input.confidence !== null) {
    if (
      typeof input.confidence !== "number" ||
      !Number.isFinite(input.confidence) ||
      input.confidence < 0 ||
      input.confidence > 1
    ) {
      issues.push({ code: "LINK_CONFIDENCE_INVALID", detail: "confidence 必须在 0..1。" });
    } else if (input.source === "user") {
      issues.push({
        code: "LINK_CONFIDENCE_INVALID",
        detail: "user 来源的关联不需要置信度（它不是模型推断）。"
      });
    }
  }
  return issues;
}

// —— 记录级严格校验（供读取边界“报告而不过滤”使用） ——

/** Trip 记录形状：id/标题/日期/时间戳/删除标记。 */
export function validateTripRecord(value: unknown): TripIssue[] {
  if (!isRecord(value)) {
    return [{ code: "TRIP_RECORD_INVALID", detail: "Trip 记录必须是对象。" }];
  }
  const candidate = value as Partial<Trip>;
  const issues: TripIssue[] = [];
  if (!isNonEmptyString(candidate.id)) {
    issues.push({ code: "TRIP_RECORD_INVALID", detail: "Trip 缺少合法 id。" });
  }
  issues.push(
    ...validateTrip({
      title: candidate.title,
      startDate: candidate.startDate,
      endDate: candidate.endDate
    })
  );
  if (!isTimestamp(candidate.createdAt) || !isTimestamp(candidate.updatedAt)) {
    issues.push({ code: "TRIP_RECORD_INVALID", detail: "Trip 需要 createdAt/updatedAt 时间戳。" });
  }
  if (candidate.deletedAt !== null && !isTimestamp(candidate.deletedAt)) {
    issues.push({ code: "TRIP_RECORD_INVALID", detail: "Trip 的 deletedAt 必须是时间戳或 null。" });
  }
  return issues;
}

/** Place 记录形状：id/名称/可选字段/时间戳/删除标记。 */
export function validatePlaceRecord(value: unknown): TripIssue[] {
  if (!isRecord(value)) {
    return [{ code: "PLACE_RECORD_INVALID", detail: "Place 记录必须是对象。" }];
  }
  const candidate = value as Partial<Place>;
  const issues: TripIssue[] = [];
  if (!isNonEmptyString(candidate.id)) {
    issues.push({ code: "PLACE_RECORD_INVALID", detail: "Place 缺少合法 id。" });
  }
  issues.push(
    ...validatePlace({
      name: candidate.name,
      aliases: candidate.aliases,
      coordinates: candidate.coordinates,
      address: candidate.address,
      regionId: candidate.regionId,
      providerRefs: candidate.providerRefs
    })
  );
  if (!isTimestamp(candidate.createdAt) || !isTimestamp(candidate.updatedAt)) {
    issues.push({ code: "PLACE_RECORD_INVALID", detail: "Place 需要 createdAt/updatedAt 时间戳。" });
  }
  if (candidate.deletedAt !== null && !isTimestamp(candidate.deletedAt)) {
    issues.push({ code: "PLACE_RECORD_INVALID", detail: "Place 的 deletedAt 必须是时间戳或 null。" });
  }
  return issues;
}

export function validateTripPageLinkRecord(value: unknown): TripIssue[] {
  if (!isRecord(value)) {
    return [{ code: "TRIP_LINK_RECORD_INVALID", detail: "TripPageLink 必须是对象。" }];
  }
  const candidate = value as Partial<TripPageLink>;
  const issues: TripIssue[] = [];
  if (!isNonEmptyString(candidate.tripId) || !isNonEmptyString(candidate.pageId)) {
    issues.push({ code: "TRIP_LINK_RECORD_INVALID", detail: "tripId 与 pageId 必须是非空字符串。" });
  }
  if (!isTimestamp(candidate.addedAt)) {
    issues.push({ code: "TRIP_LINK_RECORD_INVALID", detail: "addedAt 必须是时间戳。" });
  }
  if (candidate.role !== undefined && candidate.role !== "primary" && candidate.role !== "reference") {
    issues.push({ code: "TRIP_LINK_RECORD_INVALID", detail: "role 只能是 primary/reference。" });
  }
  return issues;
}

export function validatePagePlaceLinkRecord(value: unknown): TripIssue[] {
  if (!isRecord(value)) {
    return [{ code: "PLACE_LINK_RECORD_INVALID", detail: "PagePlaceLink 必须是对象。" }];
  }
  const candidate = value as Partial<PagePlaceLink>;
  // 保留具体原因（来源/置信度/目标），只有结构缺失才报 record 级错误。
  const issues: TripIssue[] = validatePagePlaceLink({
    pageId: candidate.pageId,
    placeId: candidate.placeId,
    source: candidate.source,
    confidence: candidate.confidence
  });
  if (!isTimestamp(candidate.createdAt)) {
    issues.push({ code: "PLACE_LINK_RECORD_INVALID", detail: "createdAt 必须是时间戳。" });
  }
  if (candidate.mentionText !== undefined && typeof candidate.mentionText !== "string") {
    issues.push({ code: "PLACE_LINK_RECORD_INVALID", detail: "mentionText 必须是字符串。" });
  }
  return issues;
}

export function validatePurgedTargetRecord(value: unknown): TripIssue[] {
  if (!isRecord(value)) {
    return [{ code: "PURGED_RECORD_INVALID", detail: "墓碑记录必须是对象。" }];
  }
  const candidate = value as Partial<PurgedTargetRecord>;
  if (!isNonEmptyString(candidate.id) || !isTimestamp(candidate.purgedAt)) {
    return [{ code: "PURGED_RECORD_INVALID", detail: "墓碑需要 id 与 purgedAt。" }];
  }
  return [];
}

/**
 * 记录级**布尔**守卫：复用同一批校验器，供 `isOptionalArray` 式的档案/清单校验使用。
 * 语义与对应 `validate*Record` 完全一致，不重复实现规则。
 */
export function isTripRecord(value: unknown): value is Trip {
  return validateTripRecord(value).length === 0;
}

export function isPlaceRecord(value: unknown): value is Place {
  return validatePlaceRecord(value).length === 0;
}

export function isTripPageLinkRecord(value: unknown): value is TripPageLink {
  return validateTripPageLinkRecord(value).length === 0;
}

export function isPagePlaceLinkRecord(value: unknown): value is PagePlaceLink {
  return validatePagePlaceLinkRecord(value).length === 0;
}

export function isPurgedTargetRecordShaped(value: unknown): value is PurgedTargetRecord {
  return validatePurgedTargetRecord(value).length === 0;
}

/**
 * 按 id 查找**可写**记录（命令边界的唯一查找入口）。
 *
 * - `missing`：没有这个 id（可以走“不存在/已永久删除”的既有分支）；
 * - `damaged`：找到了同 id 的记录，但它没通过记录校验 → **拒绝写入**，不修改、不依赖；
 * - `ok`：通过校验的记录，可以安全参与命令。
 *
 * 读取边界保留损坏记录，因此命令不能假设读到的行都满足类型。
 */
export type WritableLookup<T> =
  | { status: "ok"; record: T }
  | { status: "damaged" }
  | { status: "missing" };

export function lookupWritableRecord<T>(
  records: readonly unknown[],
  id: string,
  isValid: (value: unknown) => value is T
): WritableLookup<T> {
  const candidate = records.find((record) => isRecord(record) && record.id === id);
  if (!candidate) return { status: "missing" };
  return isValid(candidate) ? { status: "ok", record: candidate } : { status: "damaged" };
}

/**
 * 只读**投影**：六个数组只保留通过记录校验的行，供界面与查询安全消费。
 *
 * **禁止**把投影结果写回存储：损坏行必须原样保留，并由 `inspectTripStore` 报告
 * （见 `use-trips` 的 `damage`）。投影只解决“界面不被坏记录打崩”，不解决“数据损坏”。
 */
export function projectTripSlice(slice: TripArchiveSlice): TripArchiveSlice {
  return {
    trips: slice.trips.filter(isTripRecord),
    places: slice.places.filter(isPlaceRecord),
    tripPageLinks: slice.tripPageLinks.filter(isTripPageLinkRecord),
    pagePlaceLinks: slice.pagePlaceLinks.filter(isPagePlaceLinkRecord),
    purgedTrips: slice.purgedTrips.filter(isPurgedTargetRecordShaped),
    purgedPlaces: slice.purgedPlaces.filter(isPurgedTargetRecordShaped)
  };
}

/** 从档案/切片读取六数组（缺省视为空，不做业务判断）。 */
export function readTripSlice(source: Partial<TripArchiveSlice>): TripArchiveSlice {
  return {
    trips: Array.isArray(source.trips) ? source.trips : [],
    places: Array.isArray(source.places) ? source.places : [],
    tripPageLinks: Array.isArray(source.tripPageLinks) ? source.tripPageLinks : [],
    pagePlaceLinks: Array.isArray(source.pagePlaceLinks) ? source.pagePlaceLinks : [],
    purgedTrips: Array.isArray(source.purgedTrips) ? source.purgedTrips : [],
    purgedPlaces: Array.isArray(source.purgedPlaces) ? source.purgedPlaces : []
  };
}

/** 把切片写回档案对象（只覆盖六数组，其他字段原样保留）。 */
export function writeTripSlice<T extends Record<string, unknown>>(
  archive: T,
  slice: TripArchiveSlice
): T {
  return { ...archive, ...slice };
}

// —— 唯一键、内容相等与幂等/冲突 ——

export function tripPageLinkKey(link: Pick<TripPageLink, "tripId" | "pageId">): string {
  return `${link.tripId}\u0001${link.pageId}`;
}

export function pagePlaceLinkKey(
  link: Pick<PagePlaceLink, "pageId" | "placeId" | "source">
): string {
  return `${link.pageId}\u0001${link.placeId}\u0001${link.source}`;
}

/**
 * F3：从**原始行**识别唯一键（对损坏行也尽力识别）。
 *
 * 读取边界会保留坏行，“键被占用”和“记录内容合法”必须分开判断：
 * 一个 `addedAt` 非法、但 `tripId`/`pageId` 可读的坏行**仍然占用**它自己的唯一键，
 * 否则再次关联会新增一条同键行（制造重复键）。识别不出键的坏行返回 `undefined`。
 */
export function tripPageLinkKeyOf(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const { tripId, pageId } = value as { tripId?: unknown; pageId?: unknown };
  if (!isNonEmptyString(tripId) || !isNonEmptyString(pageId)) return undefined;
  return tripPageLinkKey({ tripId, pageId });
}

export function pagePlaceLinkKeyOf(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const { pageId, placeId, source } = value as {
    pageId?: unknown;
    placeId?: unknown;
    source?: unknown;
  };
  if (!isNonEmptyString(pageId) || !isNonEmptyString(placeId)) return undefined;
  if (source !== "user" && source !== "ai" && source !== "exif") return undefined;
  return pagePlaceLinkKey({ pageId, placeId, source });
}

/** 内容相等：同键时用于区分“重复添加 = no-op”与“内容不同 = 冲突”。 */
export function tripPageLinkContentEqual(a: TripPageLink, b: TripPageLink): boolean {
  return (a.role ?? "") === (b.role ?? "");
}

export function pagePlaceLinkContentEqual(a: PagePlaceLink, b: PagePlaceLink): boolean {
  return (
    (a.confidence ?? null) === (b.confidence ?? null) &&
    (a.mentionText ?? "") === (b.mentionText ?? "")
  );
}

export type UpsertResult<T> =
  | { result: "added"; links: T[] }
  | { result: "noop"; links: T[] }
  /*
   * `existing` 只在“同键的合法行”上给出；键被损坏行或重复行占用时没有可返回的合法记录
   * （调用方据此给出更准确的可见错误）。
   */
  | { result: "conflict"; links: T[]; existing?: T };

/**
 * 添加行程关联。
 * - 键未被占用 → `added`（坏行原样保留在结果里）；
 * - 同键且**唯一一条合法行内容相同** → `noop`（不改 `addedAt`，幂等）；
 * - 同键但内容不同，或同键被坏行/多行占用 → `conflict`，不覆盖、不新增、不清理。
 */
export function upsertTripPageLink(
  links: readonly TripPageLink[],
  next: TripPageLink
): UpsertResult<TripPageLink> {
  const key = tripPageLinkKey(next);
  // F3：按**可识别的键**判断占用（含损坏行），而不是只在合法行里找。
  const sameKey = links.filter((link) => tripPageLinkKeyOf(link) === key);
  if (sameKey.length === 0) return { result: "added", links: [...links, next] };
  const only = sameKey.length === 1 ? sameKey[0] : undefined;
  if (only && isTripPageLinkRecord(only) && tripPageLinkContentEqual(only, next)) {
    return { result: "noop", links: [...links] };
  }
  return {
    result: "conflict",
    links: [...links],
    ...(only && isTripPageLinkRecord(only) ? { existing: only } : {})
  };
}

/**
 * 添加地点关联。
 * - 同键同内容（且唯一一条合法行）→ `noop`；
 * - 同键不同内容，或同键被坏行/多行占用 → `conflict`，**不覆盖、不拼接、不清理**；
 * - 新键（含同一 (page,place) 的另一来源）→ `added`。
 *
 * 注意：接受 AI/EXIF 候选**不**产生 user 行；user 行只来自用户独立的手动关联动作。
 */
export function upsertPagePlaceLink(
  links: readonly PagePlaceLink[],
  next: PagePlaceLink
): UpsertResult<PagePlaceLink> {
  const key = pagePlaceLinkKey(next);
  const sameKey = links.filter((link) => pagePlaceLinkKeyOf(link) === key);
  if (sameKey.length === 0) return { result: "added", links: [...links, next] };
  const only = sameKey.length === 1 ? sameKey[0] : undefined;
  if (only && isPagePlaceLinkRecord(only) && pagePlaceLinkContentEqual(only, next)) {
    return { result: "noop", links: [...links] };
  }
  return {
    result: "conflict",
    links: [...links],
    ...(only && isPagePlaceLinkRecord(only) ? { existing: only } : {})
  };
}

export type LinkKeyConflict<T> = { key: string; links: T[] };

function groupConflicts<T>(
  links: readonly T[],
  keyOf: (link: T) => string,
  contentEqual: (a: T, b: T) => boolean
): LinkKeyConflict<T>[] {
  const grouped = new Map<string, T[]>();
  for (const link of links) {
    const key = keyOf(link);
    grouped.set(key, [...(grouped.get(key) ?? []), link]);
  }
  const conflicts: LinkKeyConflict<T>[] = [];
  for (const [key, group] of grouped) {
    if (group.length < 2) continue;
    const first = group[0];
    if (group.some((link) => !contentEqual(first, link))) {
      conflicts.push({ key, links: group });
    }
  }
  return conflicts;
}

/**
 * 唯一键重复但内容不同的记录：读取边界用它**报告**，不静默保留任意一条。
 * 返回空数组表示没有冲突（同键同内容的重复不计入）。
 */
export function findTripPageLinkConflicts(
  links: readonly TripPageLink[]
): LinkKeyConflict<TripPageLink>[] {
  return groupConflicts(links.filter(isTripPageLinkRecord), tripPageLinkKey, tripPageLinkContentEqual);
}

export function findPagePlaceLinkConflicts(
  links: readonly PagePlaceLink[]
): LinkKeyConflict<PagePlaceLink>[] {
  return groupConflicts(
    links.filter(isPagePlaceLinkRecord),
    pagePlaceLinkKey,
    pagePlaceLinkContentEqual
  );
}

export function removeTripPageLink(
  links: readonly TripPageLink[],
  target: Pick<TripPageLink, "tripId" | "pageId">
): TripPageLink[] {
  const key = tripPageLinkKey(target);
  // 只移除命中的**合法**行；损坏行原样保留（不静默清理）。
  return links.filter((link) => !(isTripPageLinkRecord(link) && tripPageLinkKey(link) === key));
}

/** 解除关联：默认只移除指定来源的那一行（保留 AI/EXIF 证据行）。 */
export function removePagePlaceLink(
  links: readonly PagePlaceLink[],
  target: Pick<PagePlaceLink, "pageId" | "placeId" | "source">
): PagePlaceLink[] {
  const key = pagePlaceLinkKey(target);
  return links.filter((link) => !(isPagePlaceLinkRecord(link) && pagePlaceLinkKey(link) === key));
}

export function placeLinksFor(
  links: readonly PagePlaceLink[],
  pageId: string,
  placeId: string
): PagePlaceLink[] {
  return links.filter(
    (link) => isPagePlaceLinkRecord(link) && link.pageId === pageId && link.placeId === placeId
  );
}

/**
 * 同一 (page, place) 现有的来源集合，用于界面**聚合展示**。
 * 不做 user > exif > ai 的强弱排名：来源是并列的证据，不是等级。
 */
export function placeLinkSources(links: readonly PagePlaceLink[]): PagePlaceLinkSource[] {
  const order: PagePlaceLinkSource[] = ["user", "exif", "ai"];
  return order.filter((source) =>
    links.some((link) => isPagePlaceLinkRecord(link) && link.source === source)
  );
}

// —— 悬挂 / 墓碑判定 ——

export type RelationState = "active" | "deleted" | "purged" | "missing";

export function relationState(
  target: { id: string; deletedAt: string | null } | undefined,
  purgedIds: ReadonlySet<string>,
  targetId: string
): RelationState {
  if (purgedIds.has(targetId)) return "purged";
  if (!target) return "missing";
  if (target.deletedAt) return "deleted";
  return "active";
}

export type RelationPartition<T> = {
  active: T[];
  deleted: T[];
  purged: T[];
  missing: T[];
};

function partition<T>(entries: readonly T[], stateOf: (entry: T) => RelationState): RelationPartition<T> {
  const result: RelationPartition<T> = { active: [], deleted: [], purged: [], missing: [] };
  for (const entry of entries) {
    result[stateOf(entry)].push(entry);
  }
  return result;
}

export function partitionTripPageLinks(input: {
  links: readonly TripPageLink[];
  trips: readonly Pick<Trip, "id" | "deletedAt">[];
  purgedTripIds?: ReadonlySet<string>;
}): RelationPartition<TripPageLink> {
  const purged = input.purgedTripIds ?? new Set<string>();
  const byId = new Map(
    input.trips.filter(isTripRecord).map((trip) => [trip.id, trip] as const)
  );
  return partition(input.links.filter(isTripPageLinkRecord), (link) =>
    relationState(byId.get(link.tripId), purged, link.tripId)
  );
}

export function partitionPagePlaceLinks(input: {
  links: readonly PagePlaceLink[];
  places: readonly Pick<Place, "id" | "deletedAt">[];
  purgedPlaceIds?: ReadonlySet<string>;
}): RelationPartition<PagePlaceLink> {
  const purged = input.purgedPlaceIds ?? new Set<string>();
  const byId = new Map(
    input.places.filter(isPlaceRecord).map((place) => [place.id, place] as const)
  );
  return partition(input.links.filter(isPagePlaceLinkRecord), (link) =>
    relationState(byId.get(link.placeId), purged, link.placeId)
  );
}

// —— 读取边界的完整性报告（报告而不过滤、不写回） ——

export type TripStoreIssue = TripIssue & {
  /** 出问题的数组名（容器级问题时是数组本身的名字）。 */
  store: keyof TripArchiveSlice;
  /** 记录下标；容器级问题为 -1。 */
  index: number;
};

export type TripStoreInspection = {
  issues: TripStoreIssue[];
  /** 唯一键重复且内容不同的分组（报告用）。 */
  linkConflicts: {
    tripPageLinks: LinkKeyConflict<TripPageLink>[];
    pagePlaceLinks: LinkKeyConflict<PagePlaceLink>[];
  };
  /** 指向不存在/已永久删除目标的悬挂关系数量。 */
  dangling: { tripPageLinks: number; pagePlaceLinks: number };
  /** 墓碑与本地活实体同 ID（禁止静默复活）的数量。 */
  resurrectConflicts: { trips: number; places: number };
};

const TRIP_STORES: (keyof TripArchiveSlice)[] = [
  "trips",
  "places",
  "tripPageLinks",
  "pagePlaceLinks",
  "purgedTrips",
  "purgedPlaces"
];

function recordIssuesFor(store: keyof TripArchiveSlice, record: unknown): TripIssue[] {
  if (store === "trips") return validateTripRecord(record);
  if (store === "places") return validatePlaceRecord(record);
  if (store === "tripPageLinks") return validateTripPageLinkRecord(record);
  if (store === "pagePlaceLinks") return validatePagePlaceLinkRecord(record);
  return validatePurgedTargetRecord(record);
}

/**
 * 检查切片完整性：**只报告**。
 * - 容器不是数组 → `STORE_NOT_ARRAY`（无法原样保留，必须显式报错）；
 * - 记录非法 → `STORE_RECORD_INVALID`（读取边界原样保留并报告，不静默过滤后写回）；
 * - 同键不同内容、悬挂关系、墓碑与活实体同 ID → 分别报告。
 */
export function inspectTripStore(slice: TripArchiveSlice): TripStoreInspection {
  const issues: TripStoreIssue[] = [];
  for (const store of TRIP_STORES) {
    const value = (slice as unknown as Record<string, unknown>)[store];
    if (!Array.isArray(value)) {
      issues.push({
        code: "STORE_NOT_ARRAY",
        store,
        index: -1,
        detail: `${store} 必须是数组；当前不是数组，无法原样保留。`
      });
      continue;
    }
    value.forEach((record, index) => {
      for (const issue of recordIssuesFor(store, record)) {
        issues.push({ ...issue, code: "STORE_RECORD_INVALID", store, index });
      }
    });
  }

  const tripPageLinks = Array.isArray(slice.tripPageLinks) ? slice.tripPageLinks : [];
  const pagePlaceLinks = Array.isArray(slice.pagePlaceLinks) ? slice.pagePlaceLinks : [];
  const trips = Array.isArray(slice.trips) ? slice.trips : [];
  const places = Array.isArray(slice.places) ? slice.places : [];
  const purgedTrips = Array.isArray(slice.purgedTrips) ? slice.purgedTrips : [];
  const purgedPlaces = Array.isArray(slice.purgedPlaces) ? slice.purgedPlaces : [];

  const purgedTripIds = new Set(purgedTrips.map((record) => record?.id));
  const purgedPlaceIds = new Set(purgedPlaces.map((record) => record?.id));
  const partitionedTrips = partitionTripPageLinks({
    links: tripPageLinks,
    trips,
    purgedTripIds
  });
  const partitionedPlaces = partitionPagePlaceLinks({
    links: pagePlaceLinks,
    places,
    purgedPlaceIds
  });

  const linkConflicts = {
    tripPageLinks: findTripPageLinkConflicts(tripPageLinks),
    pagePlaceLinks: findPagePlaceLinkConflicts(pagePlaceLinks)
  };
  for (const conflict of linkConflicts.tripPageLinks) {
    issues.push({
      code: "STORE_DUPLICATE_KEY",
      store: "tripPageLinks",
      index: -1,
      detail: `tripPageLinks 唯一键重复且内容不同：${conflict.key}（${conflict.links.length} 条）。`
    });
  }
  for (const conflict of linkConflicts.pagePlaceLinks) {
    issues.push({
      code: "STORE_DUPLICATE_KEY",
      store: "pagePlaceLinks",
      index: -1,
      detail: `pagePlaceLinks 唯一键重复且内容不同：${conflict.key}（${conflict.links.length} 条）。`
    });
  }

  const tripResurrect = trips.filter((trip) => purgedTripIds.has(trip?.id)).length;
  const placeResurrect = places.filter((place) => purgedPlaceIds.has(place?.id)).length;
  if (tripResurrect > 0) {
    issues.push({
      code: "PURGED_TARGET_RESURRECT",
      store: "trips",
      index: -1,
      detail: `有 ${tripResurrect} 个 Trip 与本地墓碑同 ID（禁止静默复活）。`
    });
  }
  if (placeResurrect > 0) {
    issues.push({
      code: "PURGED_TARGET_RESURRECT",
      store: "places",
      index: -1,
      detail: `有 ${placeResurrect} 个 Place 与本地墓碑同 ID（禁止静默复活）。`
    });
  }

  return {
    issues,
    linkConflicts,
    dangling: {
      tripPageLinks: partitionedTrips.missing.length + partitionedTrips.purged.length,
      pagePlaceLinks: partitionedPlaces.missing.length + partitionedPlaces.purged.length
    },
    resurrectConflicts: { trips: tripResurrect, places: placeResurrect }
  };
}

// —— 永久删除的关系清理（R5：关系与墓碑在同一变更内完成） ——

/** 永久删除 Trip：移除实体、写墓碑、清掉它引用的行程关联。 */
export function purgeTripInSlice(
  slice: TripArchiveSlice,
  tripId: string,
  purgedAt: string
): TripArchiveSlice {
  return {
    ...slice,
    // 只移除命中的**合法**行；损坏行原样保留（不得借永久删除静默清理坏数据）。
    trips: slice.trips.filter((trip) => !(isTripRecord(trip) && trip.id === tripId)),
    tripPageLinks: slice.tripPageLinks.filter(
      (link) => !(isTripPageLinkRecord(link) && link.tripId === tripId)
    ),
    purgedTrips: slice.purgedTrips.some(
      (record) => isPurgedTargetRecordShaped(record) && record.id === tripId
    )
      ? slice.purgedTrips
      : [...slice.purgedTrips, { id: tripId, purgedAt }]
  };
}

/** 永久删除 Place：移除实体、写墓碑、清掉指向它的地点关联。 */
export function purgePlaceInSlice(
  slice: TripArchiveSlice,
  placeId: string,
  purgedAt: string
): TripArchiveSlice {
  return {
    ...slice,
    places: slice.places.filter((place) => !(isPlaceRecord(place) && place.id === placeId)),
    pagePlaceLinks: slice.pagePlaceLinks.filter(
      (link) => !(isPagePlaceLinkRecord(link) && link.placeId === placeId)
    ),
    purgedPlaces: slice.purgedPlaces.some(
      (record) => isPurgedTargetRecordShaped(record) && record.id === placeId
    )
      ? slice.purgedPlaces
      : [...slice.purgedPlaces, { id: placeId, purgedAt }]
  };
}

/**
 * 永久删除篇（或删本导致篇被永久删除）时清理关系。
 * 篇本身的墓碑由既有 `purgedPages` 负责，本函数只处理 P6 关系，避免第二套墓碑。
 */
export function purgePageInSlice(slice: TripArchiveSlice, pageId: string): TripArchiveSlice {
  return {
    ...slice,
    tripPageLinks: slice.tripPageLinks.filter(
      (link) => !(isTripPageLinkRecord(link) && link.pageId === pageId)
    ),
    pagePlaceLinks: slice.pagePlaceLinks.filter(
      (link) => !(isPagePlaceLinkRecord(link) && link.pageId === pageId)
    )
  };
}

/** 只读投影：永久删除某个目标时需要移除的关系行（供评审与测试核对）。 */
export function sliceLinksForTarget(
  slice: TripArchiveSlice,
  target: { tripId?: string; placeId?: string; pageId?: string }
): { tripPageLinks: TripPageLink[]; pagePlaceLinks: PagePlaceLink[] } {
  return {
    tripPageLinks: slice.tripPageLinks.filter(
      (link) =>
        isTripPageLinkRecord(link) &&
        (link.tripId === target.tripId || link.pageId === target.pageId)
    ),
    pagePlaceLinks: slice.pagePlaceLinks.filter(
      (link) =>
        isPagePlaceLinkRecord(link) &&
        (link.placeId === target.placeId || link.pageId === target.pageId)
    )
  };
}

/** 行程列表展示顺序：startDate 升序，未知排最后，id 降序稳定破同序。 */
export function sortTripsForDisplay(trips: readonly Trip[]): Trip[] {
  return [...trips].sort((left, right) => {
    if (left.startDate === right.startDate) return right.id.localeCompare(left.id);
    if (left.startDate === null) return 1;
    if (right.startDate === null) return -1;
    return left.startDate.localeCompare(right.startDate);
  });
}
