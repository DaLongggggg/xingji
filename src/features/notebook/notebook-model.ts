import {
  purgePageInSlice,
  readTripSlice,
  isPagePlaceLinkRecord,
  isPlaceRecord,
  isPurgedTargetRecordShaped,
  isTripPageLinkRecord,
  isTripRecord,
  type PagePlaceLink,
  type Place,
  type PurgedTargetRecord,
  type Trip,
  type TripArchiveSlice,
  type TripPageLink
} from "../trips/trip-model";

export const NOTEBOOK_STORAGE_KEY = "xingji:notebooks:v1";
/**
 * 档案结构版本。v1 无篇附属元数据/来源关联/操作收据；
 * v2 增加 revision、tripJournals、pageSources、appendOperations；
 * v3 增加 Trip/Place 与两类多对多关系及永久删除墓碑（P6）。
 * 读取 v1/v2 时缺字段按“未设置/空数组”解释；写入恒为当前版本。
 */
export const NOTEBOOK_ARCHIVE_VERSION = 3;
export const NOTEBOOK_DB_NAME = "xingji-notebooks";
/**
 * IndexedDB 库版本。P6 增到 2：store 集合仍未变（无新 store/index），
 * 但物理版本必须体现“六数组已进入 meta”，用于初始化屏障与旧客户端防写。
 */
export const NOTEBOOK_DB_VERSION = 2;
export const MAX_NOTEBOOK_PAGES = 500;
export const MAX_NOTEBOOK_TITLE_LENGTH = 60;
export const MAX_PAGE_TITLE_LENGTH = 120;
export const MAX_PAGE_TEXT_LENGTH = 20_000;
/**
 * 内容块数的内部防御上限。200 块不再是产品配额（014 已取消该提案），
 * 仅用于拒绝明显异常的档案，不写进用户文案。
 */
export const MAX_PAGE_BLOCKS_HARD_LIMIT = 10_000;
/** 单张原图上限：50,000,000 字节。 */
export const MAX_MEDIA_BYTES = 50_000_000;
/** 单篇 photo 块出现次数上限（014-A 批准：100 张）。 */
export const MAX_PHOTO_BLOCKS_PER_PAGE = 100;
/** 一次选择/导入批次的张数上限。 */
export const MAX_PHOTO_BATCH_SIZE = 50;
/** 单篇总量字节上限（014-A 批准：十进制 500,000,000）。 */
export const MAX_PAGE_TOTAL_BYTES = 500_000_000;
/** @deprecated 使用 MAX_PHOTO_BLOCKS_PER_PAGE；旧名保留以兼容既有入口接线。 */
export const MAX_MEDIA_PER_PAGE = MAX_PHOTO_BLOCKS_PER_PAGE;
export const DEFAULT_NOTEBOOK_TITLE = "我的笔记本";
export const LEGACY_NOTEBOOK_TITLE = "1.x 旧游记";

export type Notebook = {
  schemaVersion: typeof NOTEBOOK_ARCHIVE_VERSION;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** 排序键，越小越靠前。 */
  order: number;
  archivedAt: string | null;
  deletedAt: string | null;
};

export type NotebookMediaOrigin =
  | { kind: "local-upload" }
  | { kind: "legacy-journal-photo"; spotId: string; photoId: string }
  /** 从原始记录（记录箱）复制到笔记本的资产：笔记本自有，来源删除不影响。 */
  | { kind: "capture-message"; messageId: string; sourceMediaId: string };

/**
 * 媒体以独立记录保存：元数据与 Blob 同记录，但页面只引用 mediaId，
 * 不把二进制内联进页面或档案 JSON。
 */
/**
 * 照片拍摄位置（M1.5 方案 A 修订版）：识别结果的**照片级归属**。
 *
 * - 只保存照片原始 **WGS-84** 坐标（GCJ-02 转换仅用于匹配，不落库）；
 * - `datumBasis` 记录依据：EXIF 明确声明 WGS-84（declared）或缺失声明的
 *   工程假定（presumed）——presumed 不是"已核实"；
 * - 用户显式确认才写入（confirmedAt）；不改动照片字节/EXIF；
 * - 媒体可被多篇引用：本字段是**共享媒体记录**的一部分，清除影响所有
 *   引用篇，且不会自动移除笔记的地区关联（关联级追溯/撤销需另定来源记录）。
 */
export type NotebookMediaGps = {
  lat: number;
  lng: number;
  datum: "WGS-84";
  datumBasis: "declared" | "presumed";
  capturedFrom: "exif";
  confirmedAt: string;
};

/** 照片位置形状校验（旧数据缺字段 = 未识别，一律放行）。 */
export function isNotebookMediaGps(value: unknown): value is NotebookMediaGps {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<NotebookMediaGps>;
  return (
    typeof candidate.lat === "number" &&
    Number.isFinite(candidate.lat) &&
    candidate.lat >= -90 &&
    candidate.lat <= 90 &&
    typeof candidate.lng === "number" &&
    Number.isFinite(candidate.lng) &&
    candidate.lng >= -180 &&
    candidate.lng <= 180 &&
    candidate.datum === "WGS-84" &&
    (candidate.datumBasis === "declared" || candidate.datumBasis === "presumed") &&
    candidate.capturedFrom === "exif" &&
    typeof candidate.confirmedAt === "string" &&
    candidate.confirmedAt.length > 0
  );
}

export type NotebookMedia = {
  id: string;
  name: string;
  type: string;
  size: number;
  createdAt: string;
  blob: Blob;
  origin: NotebookMediaOrigin;
  /** 照片级拍摄位置（可选；旧数据无此字段 = 未识别）。 */
  gps?: NotebookMediaGps;
};

export type NotebookPageBlock =
  | { id: string; type: "text"; text: string }
  | { id: string; type: "photo"; mediaId: string; caption: string; width?: number; height?: number }
  /**
   * 未支持的图片来源（外部 http(s) 链接等）：原样保留原始 Markdown。
   * 不转成本地媒体（本阶段不下载外链），也不改写原文。
   */
  | { id: string; type: "unsupported-image"; markdown: string };

/** 页面来源：手动记录、关联查看旧游记、或已从旧游记独立复制。 */
export type NotebookPageSource =
  | { kind: "manual" }
  | { kind: "legacy-journal"; spotId: string }
  | { kind: "copied-legacy-journal"; spotId: string; copiedAt: string };

export type NotebookPage = {
  schemaVersion: typeof NOTEBOOK_ARCHIVE_VERSION;
  id: string;
  notebookId: string;
  title: string;
  blocks: NotebookPageBlock[];
  source: NotebookPageSource;
  capturedAt: string;
  createdAt: string;
  updatedAt: string;
  /**
   * 024：软删除时间（进入垃圾桶）。可选：旧档案没有这个键时按 `null`（未删除）解释，
   * 升级校验器不会让旧数据读取失败；日期不可解析时不得判为过期。
   */
  deletedAt?: string | null;
};

/**
 * 024：永久删除过的最小终态（只留 id 与时间，不留正文/图片信息）。
 * 这里只保留**身份**：哪一篇被永久删除、何时删除。
 */
export type PurgedPageRecord = { pageId: string; purgedAt: string };

/**
 * 档案级单调递增版本。每次成功提交 +1；比较写入依赖它识别过期基线，
 * 不再只靠 hook 内队列（队列只保证单实例顺序）。
 */
export type NotebookRevision = number;

/**
 * 篇附属元数据（014-A）：与正文同处 notebook 存储边界，不塞进 Markdown 正文。
 * 旧数据缺字段一律解释为“未设置”。
 */
export type NotebookRegionRef = {
  /** 应用稳定 ID：`<sourceId>:<sourceRegionId>`，不是地图供应商命名空间的永久身份。 */
  regionId: string;
  parentRegionId: string | null;
  level: "province" | "city" | "unknown";
  name: string;
  /** 地区目录版本。 */
  catalogVersion: string;
};

/**
 * 旅行日期（M2）：范围 + 精度 + 明确来源。
 * - 旧字段 `tripDate` 保留（读模型兼容：有 tripDateRange 用 range，
 *   否则 tripDate 按 day 精度解释）；
 * - 精度表达"部分日期"：year="2026"、month="2026-05"，不得伪装成具体某天；
 * - `to` 为 null 表示单点（精度内的一个区间，如整月）；来源目前只有用户
 *   补填/编辑（manual），不来自创建时间、上传时间或 GPS 确认时间。
 */
export type TripDateRange = {
  /** 含起日（ISO 日期 yyyy-mm-dd，按精度归一后的区间起点）。 */
  from: string;
  /** 含止日；null = 与 from 同（按精度归一的区间）。 */
  to: string | null;
  precision: "day" | "month" | "year";
  basis: "manual";
};

/** 旅行日期形状校验（旧数据缺字段 = 未设置）。
  * P2（N23）：含日历合法性（月/日/闰年）与范围顺序（from ≤ to）——
  * 不只是格式检查，旧档案中的 2026-02-30 等非法值在校验层即被拒绝。 */
export function isTripDateRange(value: unknown): value is TripDateRange {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<TripDateRange>;
  if (
    typeof candidate.from !== "string" ||
    !isValidIsoDate(candidate.from) ||
    (candidate.to !== null &&
      (typeof candidate.to !== "string" || !isValidIsoDate(candidate.to))) ||
    (candidate.precision !== "day" && candidate.precision !== "month" && candidate.precision !== "year") ||
    candidate.basis !== "manual"
  ) {
    return false;
  }
  // 范围顺序：to 非空时不得早于 from。
  if (candidate.to !== null && candidate.to < candidate.from) return false;
  return true;
}

/** ISO 日期格式 + 日历合法性（月/日/闰年）。 */
function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (month < 1 || month > 12) return false;
  const daysInMonth = [31, (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= daysInMonth[month - 1];
}

/** 已退役到访功能的兼容记录，仅供旧档案保留。 */
export type VisitedRegionRecord = {
  regionId: string;
  /** 旧确认时间，与旅行日期分开保留。 */
  confirmedAt: string;
};

/** 旧到访记录形状校验。 */
export function isVisitedRegionRecord(value: unknown): value is VisitedRegionRecord {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<VisitedRegionRecord>;
  return (
    typeof candidate.regionId === "string" &&
    candidate.regionId.length > 0 &&
    typeof candidate.confirmedAt === "string" &&
    candidate.confirmedAt.length > 0
  );
}

export type TripJournalMeta = {
  /** 出行时间可空，之后可补填；与创建/修改时间分开。 */
  tripDate: string | null;
  regions: NotebookRegionRef[];
  updatedAt: string;
  /**
   * M1.5：地区关联来源记录（可选）。缺失 = 来源未知（历史手动/旧数据），
   * 保守保留、不参与自动移除。见 regions/region-sources.ts。
   */
  regionSources?: import("../regions/region-sources").RegionAssociationSource[];
  /** M2：旅行日期范围与精度（可选；用户补填，来源 manual）。 */
  tripDateRange?: TripDateRange;
  /** 旧到访记录，仅兼容保留；不再提供确认或地图邮戳。 */
  visitedRegions?: VisitedRegionRecord[];
};

export type NotebookTripJournal = {
  pageId: string;
  meta: TripJournalMeta;
};

/** 来源记录关联：登记加入时的快照指纹，不把原始记录当作内容来源。 */
export type NotebookPageSourceLink = {
  pageId: string;
  messageId: string;
  snapshotDigest: string;
  blockIds: string[];
  mediaAssetIds: string[];
  appendedAt: string;
  operationId: string;
};

/** 追加操作收据：幂等与重复识别的事实来源。 */
export type AppendOperationReceipt = {
  operationId: string;
  /** 追加操作的目标篇。 */
  pageId: string;
  /** “新建即写入”操作的目标笔记本；普通追加为空。 */
  notebookId?: string;
  /** “新建即写入”操作实际创建的篇；避免把占位 ID 当作真实篇。 */
  resultPageId?: string;
  /** 稳定规范化输入的摘要；同 ID 不同摘要必须拒绝。 */
  requestDigest: string;
  /** 024：目标被永久删除后降级为最小终态，重放时不得复活页面。 */
  status: "applied" | "purged";
  /** 用户显式选择“仍然追加副本”。 */
  duplicateIntent: boolean;
  appendedBlockIds: string[];
  appendedMediaIds: string[];
  messageIds: string[];
  skippedMessageIds: string[];
  resultRevision: NotebookRevision;
  createdAt: string;
};

export type AppendDuplicatePolicy = "needs-confirmation" | "skip" | "append-duplicate";

/**
 * P1-03：AI 安全提交收据。
 *
 * 为什么放在 Notebook 档案而不是可删除的 AI 库：AI 库与笔记本库没有跨库事务，
 * “用户已接受 → 业务已提交”必须有一个与业务修改**同事务**落地的证据，
 * 否则清除 AI 库后旧请求会被重放。收据只记录提交身份，不保存正文或密钥。
 */
export type AiCommitReceipt = {
  /** 稳定操作身份：Proposal ID。 */
  operationId: string;
  /** 冻结载荷摘要；同 ID 不同载荷必须拒绝，不能靠换 ID 规避。 */
  payloadDigest: string;
  /** 请求应用的目标篇。 */
  pageId: string;
  /** 实际写入的本（页可能被移动到别处）。 */
  notebookId: string;
  /** 提交后的篇 revision，用于恢复时判断是否已被后续写入覆盖。 */
  appliedRevision: NotebookRevision;
  /** 提交后的页级基线，回读核对用。 */
  appliedPageUpdatedAt: string;
  appliedAt: string;
};

/**
 * 收据容量：达到上限后**拒绝**新的 AI 提交，而不是静默淘汰旧收据——
 * 淘汰等于允许旧请求重放。后续治理与 Capture 收据同性质，属独立任务。
 */
export const AI_COMMIT_RECEIPT_LIMIT = 200;

export function isAiCommitReceipt(value: unknown): value is AiCommitReceipt {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AiCommitReceipt>;
  return (
    isNonEmptyString(candidate.operationId) &&
    isNonEmptyString(candidate.payloadDigest) &&
    isNonEmptyString(candidate.pageId) &&
    isNonEmptyString(candidate.notebookId) &&
    typeof candidate.appliedRevision === "number" &&
    Number.isInteger(candidate.appliedRevision) &&
    candidate.appliedRevision >= 0 &&
    isDateLike(candidate.appliedPageUpdatedAt) &&
    isDateLike(candidate.appliedAt)
  );
}

/** 复制结果：不完整复制不得报告为成功。 */
export type LegacyCopyStatus = "complete" | "partial";

export type LegacyImportRecord = {
  /** 稳定来源 ID。 */
  spotId: string;
  /** 关联查看页（引用旧游记）。 */
  linkedPageId: string;
  /** 已独立复制出的页面 ID；未复制时为 null。 */
  copiedPageId: string | null;
  copiedAt: string | null;
  copyStatus: LegacyCopyStatus | null;
  /** 来源指纹，用于识别来源已变化。 */
  sourceFingerprint: string;
  /** 缺失媒体等问题的说明，非空表示该记录可重试。 */
  issues: string[];
  importedAt: string;
};

export type NotebookArchive = {
  schemaVersion: typeof NOTEBOOK_ARCHIVE_VERSION;
  /** 档案 revision；v1 读入时为 0。 */
  revision: NotebookRevision;
  notebooks: Notebook[];
  pages: NotebookPage[];
  media: NotebookMedia[];
  legacyImports: LegacyImportRecord[];
  tripJournals: NotebookTripJournal[];
  pageSources: NotebookPageSourceLink[];
  appendOperations: AppendOperationReceipt[];
  /**
   * P1-03：AI 安全提交收据。可缺省；旧档案按空数组解释。
   * 与 AI 库分离：它必须与业务修改同事务提交，因此属于笔记本档案。
   */
  aiCommitReceipts: AiCommitReceipt[];
  /**
   * 024：永久删除过的篇（幂等终态）。可缺省；旧档案按空数组解释。
   * 它让“已永久删除”的追加操作重放不会复活页面，同时不保留任何正文信息。
   */
  purgedPages: PurgedPageRecord[];
  /**
   * 024：用户是否显式确认过旧垃圾桶（首次自动清理前必须确认）。
   * 可缺省；`null` 表示尚未确认，此时不自动清理。
   */
  trashConfirmedAt: string | null;
  /**
   * P6：旅行事件、真实地点与两类多对多关系（含永久删除墓碑）。
   * 可缺省；v1/v2 旧档案按空数组解释，规范化后恒为数组。
   */
  trips: Trip[];
  places: Place[];
  tripPageLinks: TripPageLink[];
  pagePlaceLinks: PagePlaceLink[];
  purgedTrips: PurgedTargetRecord[];
  purgedPlaces: PurgedTargetRecord[];
};

/** P6：Trip/Place 与关系六数组的切片（便于纯命令与校验函数复用）。 */
export type NotebookTripSlice = TripArchiveSlice;

/** 读/导入兼容的历史结构版本；写入恒为 `NOTEBOOK_ARCHIVE_VERSION`。 */
export const SUPPORTED_NOTEBOOK_ARCHIVE_VERSIONS = [1, 2, NOTEBOOK_ARCHIVE_VERSION] as const;

/** 结构版本是否属于已知集合（未知/未来版本必须明确拒绝，不静默降级）。 */
export function isKnownArchiveVersion(value: unknown): value is number {
  return (
    typeof value === "number" &&
    (SUPPORTED_NOTEBOOK_ARCHIVE_VERSIONS as readonly number[]).includes(value)
  );
}

/** 旧版（v1）档案结构，仅用于读取与迁移，不用于写入。 */
export type NotebookArchiveV1 = {
  schemaVersion: 1;
  notebooks: Notebook[];
  pages: NotebookPage[];
  media: NotebookMedia[];
  legacyImports: LegacyImportRecord[];
};

export const EMPTY_NOTEBOOK_ARCHIVE: NotebookArchive = {
  schemaVersion: NOTEBOOK_ARCHIVE_VERSION,
  revision: 0,
  notebooks: [],
  pages: [],
  media: [],
  legacyImports: [],
  tripJournals: [],
  pageSources: [],
  appendOperations: [],
  aiCommitReceipts: [],
  purgedPages: [],
  trashConfirmedAt: null,
  trips: [],
  places: [],
  tripPageLinks: [],
  pagePlaceLinks: [],
  purgedTrips: [],
  purgedPlaces: []
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isDateLike(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40;
}

/** 可缺省数组：undefined 视为空数组，给了就必须全部通过校验。 */
function isOptionalArray<T>(value: unknown, check: (item: unknown) => item is T): boolean {
  if (value === undefined) return true;
  return Array.isArray(value) && value.every(check);
}

/** 可选字段：undefined / null / 合法日期串都接受（旧档案没有该键）。 */
function isOptionalNullableDateLike(value: unknown): value is string | null | undefined {
  return value === undefined || isNullableDateLike(value);
}

/**
 * 024：永久删除终态记录。
 * 读取与规范化共用同一判定，避免两处规则漂移。
 */
export function isPurgedPageRecord(value: unknown): value is PurgedPageRecord {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PurgedPageRecord>;
  return isNonEmptyString(candidate.pageId) && isDateLike(candidate.purgedAt);
}

function isNullableDateLike(value: unknown): value is string | null {
  return value === null || isDateLike(value);
}

function isNotebook(value: unknown): value is Notebook {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Notebook>;
  const version: unknown = (value as { schemaVersion?: unknown }).schemaVersion;
  return (
    isKnownArchiveVersion(version) &&
    isNonEmptyString(candidate.id) &&
    typeof candidate.title === "string" &&
    candidate.title.length <= MAX_NOTEBOOK_TITLE_LENGTH &&
    isDateLike(candidate.createdAt) &&
    isDateLike(candidate.updatedAt) &&
    typeof candidate.order === "number" &&
    Number.isFinite(candidate.order) &&
    isNullableDateLike(candidate.archivedAt) &&
    isNullableDateLike(candidate.deletedAt)
  );
}

/** 接受任何类 Blob 二进制（含结构化克隆后的副本）。 */
export function isBlobLike(value: unknown): value is Blob {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Blob>;
  return (
    typeof candidate.size === "number" &&
    Number.isFinite(candidate.size) &&
    typeof candidate.type === "string" &&
    typeof candidate.slice === "function"
  );
}

function isMediaOrigin(value: unknown): value is NotebookMediaOrigin {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<NotebookMediaOrigin>;
  if (candidate.kind === "local-upload") return true;
  if (candidate.kind === "legacy-journal-photo") {
    const origin = candidate as { spotId?: unknown; photoId?: unknown };
    return isNonEmptyString(origin.spotId) && isNonEmptyString(origin.photoId);
  }
  if (candidate.kind === "capture-message") {
    const origin = candidate as { messageId?: unknown; sourceMediaId?: unknown };
    return isNonEmptyString(origin.messageId) && isNonEmptyString(origin.sourceMediaId);
  }
  return false;
}

export function isNotebookMedia(value: unknown): value is NotebookMedia {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<NotebookMedia>;
  return (
    isNonEmptyString(candidate.id) &&
    isNonEmptyString(candidate.name) &&
    isNonEmptyString(candidate.type) &&
    typeof candidate.size === "number" &&
    Number.isInteger(candidate.size) &&
    candidate.size >= 0 &&
    candidate.size <= MAX_MEDIA_BYTES &&
    isDateLike(candidate.createdAt) &&
    // 结构化克隆后 Blob 可能不是当前 realm 的 Blob 实例（IndexedDB 实现差异），
    // 因此按能力判断而不是 instanceof，否则会把已写入的媒体整条丢弃。
    isBlobLike(candidate.blob) &&
    isMediaOrigin(candidate.origin)
  );
}

function isPageBlock(value: unknown): value is NotebookPageBlock {
  if (!value || typeof value !== "object") return false;
  const candidate = value as {
    id?: unknown;
    type?: unknown;
    text?: unknown;
    mediaId?: unknown;
    width?: unknown;
    height?: unknown;
    markdown?: unknown;
  };
  if (!isNonEmptyString(candidate.id)) return false;
  if (candidate.type === "text") return typeof candidate.text === "string";
  if (candidate.type === "photo") {
    const validDimension = (value: unknown) =>
      value === undefined || (typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 10000);
    return isNonEmptyString(candidate.mediaId) &&
      validDimension(candidate.width) && validDimension(candidate.height);
  }
  if (candidate.type === "unsupported-image") {
    return typeof candidate.markdown === "string" && candidate.markdown.length > 0;
  }
  return false;
}

function isPageSource(value: unknown): value is NotebookPageSource {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<NotebookPageSource>;
  if (candidate.kind === "manual") return true;
  if (candidate.kind === "legacy-journal") {
    return isNonEmptyString((candidate as { spotId?: unknown }).spotId);
  }
  if (candidate.kind === "copied-legacy-journal") {
    const source = candidate as { spotId?: unknown; copiedAt?: unknown };
    return isNonEmptyString(source.spotId) && isDateLike(source.copiedAt);
  }
  return false;
}

export function isNotebookPage(value: unknown): value is NotebookPage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as {
    schemaVersion?: unknown;
    id?: unknown;
    notebookId?: unknown;
    title?: unknown;
    blocks?: unknown;
    source?: unknown;
    capturedAt?: unknown;
    createdAt?: unknown;
    updatedAt?: unknown;
    deletedAt?: unknown;
  };
  return (
    isKnownArchiveVersion(candidate.schemaVersion) &&
    isOptionalNullableDateLike(candidate.deletedAt) &&
    isNonEmptyString(candidate.id) &&
    isNonEmptyString(candidate.notebookId) &&
    typeof candidate.title === "string" &&
    candidate.title.length <= MAX_PAGE_TITLE_LENGTH &&
    Array.isArray(candidate.blocks) &&
    candidate.blocks.length <= MAX_PAGE_BLOCKS_HARD_LIMIT &&
    candidate.blocks.every(isPageBlock) &&
    candidate.blocks.every(
      (block) => block.type !== "text" || block.text.length <= MAX_PAGE_TEXT_LENGTH
    ) &&
    candidate.blocks.every(
      (block) => block.type !== "unsupported-image" || block.markdown.length <= MAX_PAGE_TEXT_LENGTH
    ) &&
    candidate.blocks.filter((block) => block.type === "photo").length <=
      MAX_PHOTO_BLOCKS_PER_PAGE &&
    isPageSource(candidate.source) &&
    isDateLike(candidate.capturedAt) &&
    isDateLike(candidate.createdAt) &&
    isDateLike(candidate.updatedAt)
  );
}

function isLegacyImportRecord(value: unknown): value is LegacyImportRecord {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LegacyImportRecord>;
  return (
    isNonEmptyString(candidate.spotId) &&
    isNonEmptyString(candidate.linkedPageId) &&
    (candidate.copiedPageId === null || isNonEmptyString(candidate.copiedPageId)) &&
    isNullableDateLike(candidate.copiedAt) &&
    (candidate.copyStatus === null ||
      candidate.copyStatus === "complete" ||
      candidate.copyStatus === "partial") &&
    typeof candidate.sourceFingerprint === "string" &&
    Array.isArray(candidate.issues) &&
    candidate.issues.every((issue) => typeof issue === "string") &&
    isDateLike(candidate.importedAt)
  );
}

function isRegionRef(value: unknown): value is NotebookRegionRef {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<NotebookRegionRef>;
  return (
    isNonEmptyString(candidate.regionId) &&
    (candidate.parentRegionId === null || isNonEmptyString(candidate.parentRegionId)) &&
    (candidate.level === "province" ||
      candidate.level === "city" ||
      candidate.level === "unknown") &&
    typeof candidate.name === "string" &&
    typeof candidate.catalogVersion === "string"
  );
}

export function isTripJournalMeta(value: unknown): value is TripJournalMeta {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<TripJournalMeta>;
  return (
    isNullableDateLike(candidate.tripDate) &&
    Array.isArray(candidate.regions) &&
    candidate.regions.every(isRegionRef) &&
    isDateLike(candidate.updatedAt)
  );
}

function isTripJournalEntry(value: unknown): value is NotebookTripJournal {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<NotebookTripJournal>;
  return isNonEmptyString(candidate.pageId) && isTripJournalMeta(candidate.meta);
}

export function isPageSourceLink(value: unknown): value is NotebookPageSourceLink {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<NotebookPageSourceLink>;
  return (
    isNonEmptyString(candidate.pageId) &&
    isNonEmptyString(candidate.messageId) &&
    isNonEmptyString(candidate.snapshotDigest) &&
    Array.isArray(candidate.blockIds) &&
    candidate.blockIds.every((id) => isNonEmptyString(id)) &&
    Array.isArray(candidate.mediaAssetIds) &&
    candidate.mediaAssetIds.every((id) => isNonEmptyString(id)) &&
    isDateLike(candidate.appendedAt) &&
    isNonEmptyString(candidate.operationId)
  );
}

export function isAppendOperationReceipt(value: unknown): value is AppendOperationReceipt {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AppendOperationReceipt>;
  const stringList = (list: unknown): list is string[] =>
    Array.isArray(list) && list.every((item) => isNonEmptyString(item));
  const optionalString = (item: unknown): boolean => item === undefined || isNonEmptyString(item);
  return (
    isNonEmptyString(candidate.operationId) &&
    isNonEmptyString(candidate.pageId) &&
    optionalString(candidate.notebookId) &&
    optionalString(candidate.resultPageId) &&
    isNonEmptyString(candidate.requestDigest) &&
    (candidate.status === "applied" || candidate.status === "purged") &&
    typeof candidate.duplicateIntent === "boolean" &&
    stringList(candidate.appendedBlockIds) &&
    stringList(candidate.appendedMediaIds) &&
    stringList(candidate.messageIds) &&
    stringList(candidate.skippedMessageIds) &&
    typeof candidate.resultRevision === "number" &&
    Number.isInteger(candidate.resultRevision) &&
    candidate.resultRevision >= 0 &&
    isDateLike(candidate.createdAt)
  );
}

/** v1 档案：无 revision / tripJournals / pageSources / appendOperations。 */
export function isNotebookArchiveV1(value: unknown): value is NotebookArchiveV1 {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<NotebookArchiveV1>;
  return (
    candidate.schemaVersion === 1 &&
    Array.isArray(candidate.notebooks) &&
    candidate.notebooks.every(isNotebook) &&
    Array.isArray(candidate.pages) &&
    candidate.pages.length <= MAX_NOTEBOOK_PAGES &&
    candidate.pages.every(isNotebookPage) &&
    Array.isArray(candidate.media) &&
    candidate.media.every(isNotebookMedia) &&
    Array.isArray(candidate.legacyImports) &&
    candidate.legacyImports.every(isLegacyImportRecord)
  );
}

/** 完整 v2 档案校验（含媒体 Blob）。 */
export function isNotebookArchive(value: unknown): value is NotebookArchive {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<NotebookArchive>;
  return (
    candidate.schemaVersion === NOTEBOOK_ARCHIVE_VERSION &&
    typeof candidate.revision === "number" &&
    Number.isInteger(candidate.revision) &&
    candidate.revision >= 0 &&
    Array.isArray(candidate.notebooks) &&
    candidate.notebooks.every(isNotebook) &&
    Array.isArray(candidate.pages) &&
    candidate.pages.length <= MAX_NOTEBOOK_PAGES &&
    candidate.pages.every(isNotebookPage) &&
    Array.isArray(candidate.media) &&
    candidate.media.every(isNotebookMedia) &&
    Array.isArray(candidate.legacyImports) &&
    candidate.legacyImports.every(isLegacyImportRecord) &&
    Array.isArray(candidate.tripJournals) &&
    candidate.tripJournals.every(isTripJournalEntry) &&
    Array.isArray(candidate.pageSources) &&
    candidate.pageSources.every(isPageSourceLink) &&
    Array.isArray(candidate.appendOperations) &&
    candidate.appendOperations.every(isAppendOperationReceipt) &&
    // P1-03：AI 提交收据可缺省（旧档案），给了就必须全部合法。
    isOptionalArray((candidate as Partial<NotebookArchive>).aiCommitReceipts, isAiCommitReceipt) &&
    // 024：删除/永久删除字段必须一起校验，否则会被静默丢弃。
    isOptionalArray(candidate.purgedPages, isPurgedPageRecord) &&
    isOptionalNullableDateLike(candidate.trashConfirmedAt) &&
    // P6：六数组可缺省（旧档案），给了就必须逐条合法（不静默过滤）。
    isOptionalArray((candidate as Partial<NotebookArchive>).trips, isTripRecord) &&
    isOptionalArray((candidate as Partial<NotebookArchive>).places, isPlaceRecord) &&
    isOptionalArray(candidate.tripPageLinks, isTripPageLinkRecord) &&
    isOptionalArray(candidate.pagePlaceLinks, isPagePlaceLinkRecord) &&
    isOptionalArray(candidate.purgedTrips, isPurgedTargetRecordShaped) &&
    isOptionalArray(candidate.purgedPlaces, isPurgedTargetRecordShaped)
  );
}

/**
 * 结构校验（不含 Blob），用于 IndexedDB 元数据与旧数据读取。
 * 同时接受 v1（缺字段按未设置解释）与 v2，未来更高版本明确拒绝。
 */
export function isNotebookArchiveMeta(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<NotebookArchive> & Partial<NotebookArchiveV1>;
  if (candidate.schemaVersion === 1) {
    return (
      Array.isArray(candidate.notebooks) &&
      candidate.notebooks.every(isNotebook) &&
      Array.isArray(candidate.pages) &&
      candidate.pages.length <= MAX_NOTEBOOK_PAGES &&
      candidate.pages.every(isNotebookPage) &&
      Array.isArray(candidate.legacyImports) &&
      candidate.legacyImports.every(isLegacyImportRecord)
    );
  }
  // 结构校验同时接受 v2（旧档案）与当前 v3；未来版本由版本关口拒绝。
  if (!isKnownArchiveVersion(candidate.schemaVersion) || candidate.schemaVersion === 1) return false;
  return (
    typeof candidate.revision === "number" &&
    Number.isInteger(candidate.revision) &&
    candidate.revision >= 0 &&
    Array.isArray(candidate.notebooks) &&
    candidate.notebooks.every(isNotebook) &&
    Array.isArray(candidate.pages) &&
    candidate.pages.length <= MAX_NOTEBOOK_PAGES &&
    candidate.pages.every(isNotebookPage) &&
    Array.isArray(candidate.legacyImports) &&
    candidate.legacyImports.every(isLegacyImportRecord) &&
    Array.isArray(candidate.tripJournals) &&
    candidate.tripJournals.every(isTripJournalEntry) &&
    Array.isArray(candidate.pageSources) &&
    candidate.pageSources.every(isPageSourceLink) &&
    Array.isArray(candidate.appendOperations) &&
    candidate.appendOperations.every(isAppendOperationReceipt) &&
    isOptionalArray((candidate as Partial<NotebookArchive>).aiCommitReceipts, isAiCommitReceipt) &&
    isOptionalArray(candidate.purgedPages, isPurgedPageRecord) &&
    isOptionalNullableDateLike(candidate.trashConfirmedAt) &&
    isOptionalArray((candidate as Partial<NotebookArchive>).trips, isTripRecord) &&
    isOptionalArray((candidate as Partial<NotebookArchive>).places, isPlaceRecord) &&
    isOptionalArray(candidate.tripPageLinks, isTripPageLinkRecord) &&
    isOptionalArray(candidate.pagePlaceLinks, isPagePlaceLinkRecord) &&
    isOptionalArray(candidate.purgedTrips, isPurgedTargetRecordShaped) &&
    isOptionalArray(candidate.purgedPlaces, isPurgedTargetRecordShaped)
  );
}

export type NotebookVersionCheck =
  | { supported: true; version: 1 | 2 | typeof NOTEBOOK_ARCHIVE_VERSION }
  | { supported: false; version: number; reason: "unsupported-version" | "malformed" };

/** 版本关口：未知的未来版本必须明确拒绝，不 normalize 成静默丢字段。 */
export function checkNotebookArchiveVersion(value: unknown): NotebookVersionCheck {
  if (!value || typeof value !== "object") {
    return { supported: false, version: Number.NaN, reason: "malformed" };
  }
  const version = (value as { schemaVersion?: unknown }).schemaVersion;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    return { supported: false, version: Number.NaN, reason: "malformed" };
  }
  if (isKnownArchiveVersion(version)) {
    return { supported: true, version: version as 1 | 2 | typeof NOTEBOOK_ARCHIVE_VERSION };
  }
  return { supported: false, version, reason: "unsupported-version" };
}

export function sortNotebooks(notebooks: Notebook[]): Notebook[] {
  return [...notebooks].sort((left, right) =>
    left.order === right.order ? left.id.localeCompare(right.id) : left.order - right.order
  );
}

/** 可见笔记本：排除归档与待恢复删除。 */
export function listVisibleNotebooks(archive: { notebooks: Notebook[] }): Notebook[] {
  return sortNotebooks(archive.notebooks).filter(
    (notebook) => !notebook.archivedAt && !notebook.deletedAt
  );
}

/** 024：篇是否在垃圾桶里（`deletedAt` 有合法值）。 */
export function isPageDeleted(page: NotebookPage): boolean {
  return typeof page.deletedAt === "string" && page.deletedAt.length > 0;
}

/**
 * 024：活动篇 = 本未删除且篇未删除。
 * 目录、地图计数/详情、追加目标都走这里，不能只看本。
 */
export function listActivePages(archive: {
  notebooks: Notebook[];
  pages: NotebookPage[];
}): NotebookPage[] {
  const deletedNotebookIds = new Set(
    archive.notebooks.filter((notebook) => notebook.deletedAt).map((notebook) => notebook.id)
  );
  return archive.pages.filter(
    (page) => !isPageDeleted(page) && !deletedNotebookIds.has(page.notebookId)
  );
}

/** 活动本（含篇过滤用的辅助集合）。 */
export function listActiveNotebooks(archive: { notebooks: Notebook[] }): Notebook[] {
  return listVisibleNotebooks(archive);
}

export function listNotebookPages(
  archive: { pages: NotebookPage[] },
  notebookId: string
): NotebookPage[] {
  return archive.pages
    .filter((page) => page.notebookId === notebookId)
    .sort((left, right) => right.capturedAt.localeCompare(left.capturedAt));
}

/** 024：某本的活动篇（用于目录与本卡片计数）。 */
export function listActiveNotebookPages(
  archive: { pages: NotebookPage[] },
  notebookId: string
): NotebookPage[] {
  return listNotebookPages(archive, notebookId).filter((page) => !isPageDeleted(page));
}

export function findMedia(
  archive: { media: NotebookMedia[] },
  mediaId: string
): NotebookMedia | undefined {
  return archive.media.find((media) => media.id === mediaId);
}

export function findLegacyImport(
  archive: { legacyImports: LegacyImportRecord[] },
  spotId: string
): LegacyImportRecord | undefined {
  return archive.legacyImports.find((record) => record.spotId === spotId);
}

export function findCopiedPage(
  archive: { pages: NotebookPage[] } & { legacyImports: LegacyImportRecord[] },
  spotId: string
): NotebookPage | undefined {
  const record = findLegacyImport(archive, spotId);
  if (!record?.copiedPageId) return undefined;
  return archive.pages.find((page) => page.id === record.copiedPageId);
}

export function nextNotebookOrder(archive: { notebooks: Notebook[] }): number {
  return archive.notebooks.reduce((max, notebook) => Math.max(max, notebook.order), 0) + 1;
}

/** 篇附属元数据；未设置的旧页返回 undefined，由界面显示“未设置”。 */
export function findTripJournal(
  archive: { tripJournals?: NotebookTripJournal[] },
  pageId: string
): TripJournalMeta | undefined {
  return archive.tripJournals?.find((entry) => entry.pageId === pageId)?.meta;
}

/** 设置/更新篇附属元数据；传 null 表示清除（不删正文）。 */
export function setTripJournalMeta<T extends { tripJournals?: NotebookTripJournal[] }>(
  archive: T,
  pageId: string,
  meta: TripJournalMeta | null
): T {
  const rest = (archive.tripJournals ?? []).filter((entry) => entry.pageId !== pageId);
  return {
    ...archive,
    tripJournals: meta ? [...rest, { pageId, meta }] : rest
  };
}

export function listPageSourceLinks(
  archive: { pageSources?: NotebookPageSourceLink[] },
  pageId: string
): NotebookPageSourceLink[] {
  return (archive.pageSources ?? []).filter((link) => link.pageId === pageId);
}

export function findAppendOperation(
  archive: { appendOperations?: AppendOperationReceipt[] },
  operationId: string
): AppendOperationReceipt | undefined {
  return archive.appendOperations?.find((receipt) => receipt.operationId === operationId);
}

/** 收据对应的逻辑篇 ID：普通追加用 pageId，“新建即写入”用 resultPageId。 */
export function receiptPageId(receipt: AppendOperationReceipt): string {
  return receipt.resultPageId ?? receipt.pageId;
}

/**
 * P3-01：追加收据台账按字节预算治理（取代旧的 500 条条数闸）。
 * 判定对象是“已有收据＋本次新增收据”的最终候选数组，计量**完整数组 JSON 的
 * UTF-8 字节数**（含数组结构开销），以运行时实测为准——任何“单条约多少字节”
 * 的估算都不是硬上限，禁止以条数乘估算值代替计量。
 * 超预算先压缩历史明细（见 governAppendOperationLog），压缩后仍超限则拒绝新操作——
 * 永远不静默丢弃/淘汰收据（丢收据 = 丢失幂等保护），也不释放本地台账容量。
 */
export const APPEND_OPERATION_LOG_BUDGET_BYTES = 8_388_608;
/** 近期保留完整明细的 applied 收据条数（K）；更旧的 applied 收据在预算压力下压缩明细。 */
export const APPEND_OPERATION_LOG_RECENT_KEEP = 200;

/** 登记一条来源关联（幂等：同 operationId + messageId 不重复登记）。 */
export function addPageSourceLinks<T extends { pageSources?: NotebookPageSourceLink[] }>(
  archive: T,
  links: NotebookPageSourceLink[]
): T {
  const existing = archive.pageSources ?? [];
  const seen = new Set(existing.map((link) => `${link.operationId}\u0001${link.messageId}`));
  const additions = links.filter((link) => !seen.has(`${link.operationId}\u0001${link.messageId}`));
  return { ...archive, pageSources: [...existing, ...additions] };
}

/** 从 1.x 游记 Markdown 中提取 journal-photo:// 引用顺序。 */
export function extractLegacyPhotoIds(contentMarkdown: string): string[] {
  const ids: string[] = [];
  const pattern = /journal-photo:\/\/([A-Za-z0-9_-]+)/g;
  let match = pattern.exec(contentMarkdown);
  while (match) {
    ids.push(match[1]);
    match = pattern.exec(contentMarkdown);
  }
  return ids;
}

/**
 * 内容指纹：判断来源是否变化，以及同 ID 内容是否不同。
 * 非加密用途，只需稳定可比较。
 */
export function fingerprintParts(parts: (string | number)[]): string {
  let hash = 2166136261;
  const input = parts.join("\u0001");
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** 笔记本内容指纹：标题、顺序与状态；用于判断同 ID 是否同内容。 */
export function notebookFingerprint(notebook: Notebook): string {
  return fingerprintParts([
    notebook.title,
    notebook.order,
    notebook.archivedAt ?? "",
    notebook.deletedAt ?? ""
  ]);
}

export function pageFingerprint(page: NotebookPage): string {
  return fingerprintParts([
    page.title,
    page.capturedAt,
    page.source.kind,
    ...page.blocks.flatMap((block) => {
      if (block.type === "text") return ["text", block.text];
      if (block.type === "unsupported-image") return ["unsupported-image", block.markdown];
      return block.width || block.height
        ? ["photo", block.mediaId, block.caption, block.width ?? "", block.height ?? ""]
        : ["photo", block.mediaId, block.caption];
    })
  ]);
}

let idCounter = 0;

function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

/** 对外暴露的稳定 ID 生成器（追加服务准备媒体资产时需要笔记本自有 ID）。 */
export function createNotebookId(prefix: string): string {
  return nextId(prefix);
}

export function createNotebook<T extends { notebooks: Notebook[] }>(
  archive: T,
  title: string,
  now: () => Date = () => new Date()
): { archive: T; notebook: Notebook } {
  const trimmed = title.trim();
  const timestamp = now().toISOString();
  const notebook: Notebook = {
    schemaVersion: NOTEBOOK_ARCHIVE_VERSION,
    id: nextId("nb"),
    title: trimmed || DEFAULT_NOTEBOOK_TITLE,
    createdAt: timestamp,
    updatedAt: timestamp,
    order: nextNotebookOrder(archive),
    archivedAt: null,
    deletedAt: null
  };
  return { archive: { ...archive, notebooks: [...archive.notebooks, notebook] }, notebook };
}

export function renameNotebook<T extends { notebooks: Notebook[] }>(
  archive: T,
  notebookId: string,
  title: string,
  now: () => Date = () => new Date()
): T {
  const trimmed = title.trim();
  if (!trimmed) throw new Error("NOTEBOOK_TITLE_REQUIRED");
  return {
    ...archive,
    notebooks: archive.notebooks.map((notebook) =>
      notebook.id === notebookId
        ? {
            ...notebook,
            title: trimmed.slice(0, MAX_NOTEBOOK_TITLE_LENGTH),
            updatedAt: now().toISOString()
          }
        : notebook
    )
  };
}

export function createPage<T extends { pages: NotebookPage[] }>(
  archive: T,
  input: {
    notebookId: string;
    title: string;
    capturedAt?: string;
    blocks?: NotebookPageBlock[];
    source?: NotebookPageSource;
  },
  now: () => Date = () => new Date()
): { archive: T; page: NotebookPage } {
  const timestamp = now().toISOString();
  const page: NotebookPage = {
    schemaVersion: NOTEBOOK_ARCHIVE_VERSION,
    id: nextId("pg"),
    notebookId: input.notebookId,
    title: input.title.trim().slice(0, MAX_PAGE_TITLE_LENGTH),
    blocks: input.blocks ?? [],
    source: input.source ?? { kind: "manual" },
    capturedAt: input.capturedAt ?? timestamp,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  return { archive: { ...archive, pages: [...archive.pages, page] }, page };
}

/**
 * 更新已保存页面：只替换目标页面的标题/正文/图片引用，不改动其他页面。
 * 移除或替换图片只是丢掉该页面的引用，不删除媒体本身（可能被其他页面共享）。
 * 找不到目标页面时抛错，避免静默产生“看似保存成功”的空操作。
 */
/**
 * 024：编辑基线 = 打开编辑时该页的页级快照。
 * 用它（而不是全局 revision）判断“我改的还是我打开的那一版”，
 * 避免别的页变动把当前编辑误判成冲突。
 */
export type PageEditBaseline = {
  pageId: string;
  /** 打开编辑时该页的 updatedAt。 */
  updatedAt: string;
  /** 打开编辑时该页的块摘要（用于发现同时间戳下的内容变化）。 */
  blocksDigest: string;
};

/** 稳定的块摘要：只用于基线比较，不做加密用途。 */
export function digestPageBlocks(page: Pick<NotebookPage, "blocks">): string {
  let hash = 2166136261;
  const text = JSON.stringify(
    page.blocks.map((block) =>
      block.type === "text"
        ? ["t", block.id, block.text]
        : block.type === "photo"
          ? block.width || block.height
            ? ["p", block.id, block.mediaId, block.caption, block.width ?? null, block.height ?? null]
            : ["p", block.id, block.mediaId, block.caption]
          : ["u", block.id, block.markdown]
    )
  );
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${text.length}:${(hash >>> 0).toString(16)}`;
}

export function pageEditBaseline(page: NotebookPage): PageEditBaseline {
  return { pageId: page.id, updatedAt: page.updatedAt, blocksDigest: digestPageBlocks(page) };
}

/** 基线不符时抛出，界面据此进入“冲突”而不是自动覆盖。 */
export class PageBaselineConflictError extends Error {
  constructor(
    readonly pageId: string,
    readonly expected: string,
    readonly actual: string
  ) {
    super("PAGE_BASELINE_CONFLICT");
    this.name = "PageBaselineConflictError";
  }
}

export function updatePage<T extends { pages: NotebookPage[] }>(
  archive: T,
  pageId: string,
  changes: { title?: string; blocks?: NotebookPageBlock[]; baseline?: PageEditBaseline },
  now: () => Date = () => new Date()
): { archive: T; page: NotebookPage } {
  const existing = archive.pages.find((page) => page.id === pageId);
  if (!existing) throw new Error("PAGE_NOT_FOUND");
  /*
   * 024：保存前核对页级基线。别的页变动不影响这里；
   * 只有“这一页”被别处改过才冲突，冲突不写、由调用方保留草稿。
   */
  if (changes.baseline) {
    const actual = `${existing.updatedAt}|${digestPageBlocks(existing)}`;
    const expected = `${changes.baseline.updatedAt}|${changes.baseline.blocksDigest}`;
    if (actual !== expected) {
      throw new PageBaselineConflictError(pageId, expected, actual);
    }
  }
  const updated: NotebookPage = {
    ...existing,
    title:
      changes.title === undefined
        ? existing.title
        : changes.title.trim().slice(0, MAX_PAGE_TITLE_LENGTH),
    blocks: changes.blocks === undefined ? existing.blocks : changes.blocks,
    updatedAt: now().toISOString()
  };
  if (!isNotebookPage(updated)) throw new Error("PAGE_INVALID");
  return {
    archive: {
      ...archive,
      pages: archive.pages.map((page) => (page.id === pageId ? updated : page))
    },
    page: updated
  };
}

/**
 * 移动笔记到另一个笔记本。
 * - 只改归属，保持 pageId、正文、媒体引用、来源关联与创建时间不变；
 * - 原子更新（不复制页面再删除原页）；
 * - 目标笔记本必须存在且未删除，否则抛错；
 * - 同一本为无操作（返回 null 表示未改动）；
 * - 关联查看页（legacy-journal）不能借移动绕过所有权边界。
 */
export function movePage<T extends { pages: NotebookPage[]; notebooks: Notebook[] }>(
  archive: T,
  pageId: string,
  targetNotebookId: string,
  now: () => Date = () => new Date()
): { archive: T; page: NotebookPage; moved: boolean } {
  const page = archive.pages.find((item) => item.id === pageId);
  if (!page) throw new Error("PAGE_NOT_FOUND");
  const target = archive.notebooks.find((notebook) => notebook.id === targetNotebookId);
  if (!target || target.deletedAt) throw new Error("NOTEBOOK_TARGET_NOT_FOUND");
  if (page.source.kind === "legacy-journal") throw new Error("PAGE_IS_LEGACY_LINK");
  if (page.notebookId === targetNotebookId) {
    return { archive, page, moved: false };
  }
  const updated: NotebookPage = {
    ...page,
    notebookId: targetNotebookId,
    updatedAt: now().toISOString()
  };
  if (!isNotebookPage(updated)) throw new Error("PAGE_INVALID");
  return {
    archive: {
      ...archive,
      pages: archive.pages.map((item) => (item.id === pageId ? updated : item))
    },
    page: updated,
    moved: true
  };
}

/**
 * 024：删除页 = 软删除（进入垃圾桶）。
 * - 只标记 `deletedAt`，保留原归属、块顺序、图片与来源信息，便于恢复；
 * - 重复删除幂等：已有删除时间就保留原值，不续期；
 * - 不物理删除媒体（可能被其他页共享），永久删除时另行核算。
 */
export function softDeletePage<T extends { pages: NotebookPage[] }>(
  archive: T,
  pageId: string,
  now: () => Date = () => new Date()
): { archive: T; page: NotebookPage; alreadyDeleted: boolean } {
  const existing = archive.pages.find((page) => page.id === pageId);
  if (!existing) throw new Error("PAGE_NOT_FOUND");
  if (isPageDeleted(existing)) {
    return { archive, page: existing, alreadyDeleted: true };
  }
  const page: NotebookPage = { ...existing, deletedAt: now().toISOString() };
  if (!isNotebookPage(page)) throw new Error("PAGE_INVALID");
  return {
    archive: { ...archive, pages: archive.pages.map((item) => (item.id === pageId ? page : item)) },
    page,
    alreadyDeleted: false
  };
}

/**
 * 024：恢复页。
 * - 原本归属仍有效（本存在且未删除）→ 回原本；
 * - 否则必须显式给一个有效目标本，否则报错（不藏在删除本下、不擅自建本）。
 */
export function restorePage<T extends { pages: NotebookPage[]; notebooks: Notebook[] }>(
  archive: T,
  pageId: string,
  targetNotebookId?: string,
  now: () => Date = () => new Date()
): { archive: T; page: NotebookPage; targetNotebookId: string } {
  const existing = archive.pages.find((page) => page.id === pageId);
  if (!existing) throw new Error("PAGE_NOT_FOUND");
  const originalNotebook = archive.notebooks.find(
    (notebook) => notebook.id === existing.notebookId
  );
  const originalValid = Boolean(originalNotebook && !originalNotebook.deletedAt);
  const target = targetNotebookId ?? (originalValid ? existing.notebookId : "");
  if (!target) throw new Error("PAGE_RESTORE_TARGET_REQUIRED");
  const targetNotebook = archive.notebooks.find((notebook) => notebook.id === target);
  if (!targetNotebook || targetNotebook.deletedAt) {
    throw new Error("PAGE_RESTORE_TARGET_REQUIRED");
  }
  const page: NotebookPage = {
    ...existing,
    notebookId: target,
    deletedAt: null,
    updatedAt: now().toISOString()
  };
  if (!isNotebookPage(page)) throw new Error("PAGE_INVALID");
  return {
    archive: { ...archive, pages: archive.pages.map((item) => (item.id === pageId ? page : item)) },
    page,
    targetNotebookId: target
  };
}

/** 024：删除本 = 只标记本；子页保持各自状态（含此前单独删除的页）。 */
export function softDeleteNotebook<T extends { notebooks: Notebook[] }>(
  archive: T,
  notebookId: string,
  now: () => Date = () => new Date()
): { archive: T; notebook: Notebook; alreadyDeleted: boolean } {
  const existing = archive.notebooks.find((notebook) => notebook.id === notebookId);
  if (!existing) throw new Error("NOTEBOOK_NOT_FOUND");
  if (existing.deletedAt) return { archive, notebook: existing, alreadyDeleted: true };
  const notebook: Notebook = { ...existing, deletedAt: now().toISOString() };
  return {
    archive: {
      ...archive,
      notebooks: archive.notebooks.map((item) => (item.id === notebookId ? notebook : item))
    },
    notebook,
    alreadyDeleted: false
  };
}

/**
 * 024：恢复本 = 清掉本的删除时间。
 * **不复活**此前单独删除的子页——它们的 `deletedAt` 原样保留。
 */
export function restoreNotebook<T extends { notebooks: Notebook[] }>(
  archive: T,
  notebookId: string,
  now: () => Date = () => new Date()
): { archive: T; notebook: Notebook } {
  const existing = archive.notebooks.find((notebook) => notebook.id === notebookId);
  if (!existing) throw new Error("NOTEBOOK_NOT_FOUND");
  const notebook: Notebook = { ...existing, deletedAt: null, updatedAt: now().toISOString() };
  return {
    archive: {
      ...archive,
      notebooks: archive.notebooks.map((item) => (item.id === notebookId ? notebook : item))
    },
    notebook
  };
}

/**
 * 是否已完成独立复制。界面用它区分“旧版关联查看”和“已独立复制”，
 * 也用于避免重复复制。
 */
export function isIndependentlyCopied(
  archive: { legacyImports: LegacyImportRecord[] },
  spotId: string
): boolean {
  const record = findLegacyImport(archive, spotId);
  return record?.copyStatus === "complete" && Boolean(record.copiedPageId);
}

/** 024：垃圾桶保留期（30 × 24 小时）。 */
export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** 合法时间戳才判定过期；无法解析的日期一律不判过期（宁可不删）。 */
function parsedTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

export function isTrashExpired(
  deletedAt: string | null | undefined,
  now: () => Date = () => new Date()
): boolean {
  const time = parsedTime(deletedAt);
  if (time === null) return false;
  return now().getTime() - time >= TRASH_RETENTION_MS;
}

export type TrashNotebookEntry = {
  kind: "notebook";
  notebook: Notebook;
  deletedAt: string;
  /** 仍归属本、且自身未删除的页数（恢复后会一起回来）。 */
  activePageCount: number;
  /** 本内此前单独删除、恢复本也不会复活的页数。 */
  separatelyDeletedPageCount: number;
  expired: boolean;
};

export type TrashPageEntry = {
  kind: "page";
  page: NotebookPage;
  deletedAt: string;
  /** 原归属本仍存在且有效时为 true。 */
  originalNotebookValid: boolean;
  expired: boolean;
};

export type TrashListing = {
  notebooks: TrashNotebookEntry[];
  pages: TrashPageEntry[];
  /** 是否存在已过期待清理项（用于决定是否显示提示/自动清理）。 */
  hasExpired: boolean;
};

/**
 * 024：垃圾桶列表。
 * - 删除本作为一个条目出现，本内页不再单独列（避免重复）；
 * - 只列“独立删除页”：页被删除且其本未被删除。
 */
export function listTrash(
  archive: {
    notebooks: Notebook[];
    pages: NotebookPage[];
  },
  now: () => Date = () => new Date()
): TrashListing {
  const notebooks: TrashNotebookEntry[] = archive.notebooks
    .filter((notebook): notebook is Notebook & { deletedAt: string } => Boolean(notebook.deletedAt))
    .map((notebook) => {
      const pages = archive.pages.filter((page) => page.notebookId === notebook.id);
      return {
        kind: "notebook" as const,
        notebook,
        deletedAt: notebook.deletedAt,
        activePageCount: pages.filter((page) => !isPageDeleted(page)).length,
        separatelyDeletedPageCount: pages.filter((page) => isPageDeleted(page)).length,
        expired: isTrashExpired(notebook.deletedAt, now)
      };
    });

  const deletedNotebookIds = new Set(notebooks.map((entry) => entry.notebook.id));
  const pages: TrashPageEntry[] = archive.pages
    .filter(
      (page): page is NotebookPage & { deletedAt: string } =>
        isPageDeleted(page) && !deletedNotebookIds.has(page.notebookId)
    )
    .map((page) => {
      const notebook = archive.notebooks.find((item) => item.id === page.notebookId);
      return {
        kind: "page" as const,
        page,
        deletedAt: page.deletedAt,
        originalNotebookValid: Boolean(notebook && !notebook.deletedAt),
        expired: isTrashExpired(page.deletedAt, now)
      };
    });

  return {
    notebooks,
    pages,
    hasExpired: [...notebooks, ...pages].some((entry) => entry.expired)
  };
}

/** 永久删除目标：由确认时的列表冻结，执行时再核对身份。 */
export type PurgeTarget =
  | { kind: "notebook"; id: string; deletedAt: string }
  | { kind: "page"; id: string; deletedAt: string };

export type PurgePlan = {
  /** 实际要永久删除的页 id。 */
  pageIds: string[];
  /** 实际要永久删除的本 id。 */
  notebookIds: string[];
  /** 候选回收媒体：本次删除页引用、且删除后无人引用。 */
  mediaIds: string[];
  /** 与冻结目标身份不一致（已被恢复/改期/不存在）的项，不参与删除。 */
  skipped: PurgeTarget[];
};

/** 页引用到的媒体 id（含手动引用与外部图片无关的 photo 块）。 */
export function pageMediaIds(page: NotebookPage): string[] {
  return page.blocks
    .filter(
      (block): block is Extract<NotebookPageBlock, { type: "photo" }> => block.type === "photo"
    )
    .map((block) => block.mediaId);
}

/**
 * 024：计算永久删除计划。
 *
 * 媒体只做**候选回收**：针对本次永久删除页引用到的媒体，检查删除后是否
 * 仍被任何剩余活动页、垃圾桶页引用；仍被引用则保留。不做全库孤儿扫描。
 */
export function purgeTargets(
  archive: {
    notebooks: Notebook[];
    pages: NotebookPage[];
    pageSources: NotebookPageSourceLink[];
  },
  targets: PurgeTarget[]
): PurgePlan {
  const skipped: PurgeTarget[] = [];
  const notebookIds: string[] = [];
  const directPageIds: string[] = [];

  for (const target of targets) {
    if (target.kind === "notebook") {
      const notebook = archive.notebooks.find((item) => item.id === target.id);
      if (!notebook || notebook.deletedAt !== target.deletedAt) {
        skipped.push(target);
        continue;
      }
      notebookIds.push(target.id);
      continue;
    }
    const page = archive.pages.find((item) => item.id === target.id);
    if (!page || page.deletedAt !== target.deletedAt) {
      skipped.push(target);
      continue;
    }
    directPageIds.push(target.id);
  }

  // 删除本会永久删除“仍归属该本”的子页；已移出/恢复到其他本的页不受影响。
  const notebookIdSet = new Set(notebookIds);
  const pageIds = new Set(directPageIds);
  for (const page of archive.pages) {
    if (notebookIdSet.has(page.notebookId)) pageIds.add(page.id);
  }

  // 候选媒体：只来自本次待删页。
  const candidateIds = new Set<string>();
  for (const page of archive.pages) {
    if (!pageIds.has(page.id)) continue;
    for (const mediaId of pageMediaIds(page)) candidateIds.add(mediaId);
  }

  // 引用核对：剩余页（含垃圾桶页与其他本）与来源关联里仍出现的一律保留。
  const stillReferenced = new Set<string>();
  for (const page of archive.pages) {
    if (pageIds.has(page.id)) continue;
    for (const mediaId of pageMediaIds(page)) stillReferenced.add(mediaId);
  }
  for (const link of archive.pageSources) {
    if (pageIds.has(link.pageId)) continue;
    for (const mediaId of link.mediaAssetIds) stillReferenced.add(mediaId);
  }

  return {
    notebookIds,
    pageIds: [...pageIds],
    mediaIds: [...candidateIds].filter((mediaId) => !stillReferenced.has(mediaId)),
    skipped
  };
}

/**
 * 收据在档案里是否仍然有效（规范化与读取共用同一判定）。
 *
 * - 永久删除终态（`purged`）的目标篇**就是被永久删掉的**，不能再要求页仍存在，
 *   否则同一 operationId 的幂等身份会在写入、重启或恢复时被静默抹掉；
 * - 活动收据挂在仍然存在的目标篇上（普通追加看 `pageId`，“新建即写入”看 `resultPageId`）。
 */
export function isRetainedAppendReceipt(
  receipt: AppendOperationReceipt,
  pageIds: ReadonlySet<string>
): boolean {
  if (receipt.status === "purged") return true;
  return (
    pageIds.has(receipt.pageId) ||
    (receipt.resultPageId !== undefined && pageIds.has(receipt.resultPageId))
  );
}

/**
 * P3-01：把 applied 收据压缩为身份台账——只清空允许退化的明细数组，
 * 幂等身份字段（operationId/requestDigest/status/pageId/resultPageId/notebookId/
 * resultRevision/createdAt/duplicateIntent）全部原样保留。
 * 压缩后的收据重放仍返回既有结果，只是明细为空（预期的回显退化，不是错误）。
 * 这是“明细退化”的唯一规则来源：purged 终态（minimalPurgedReceipt）与预算压缩共用。
 */
export function compactAppliedReceipt(receipt: AppendOperationReceipt): AppendOperationReceipt {
  return {
    ...receipt,
    appendedBlockIds: [],
    appendedMediaIds: [],
    messageIds: [],
    skippedMessageIds: []
  };
}

/** 台账候选数组的完整 JSON UTF-8 字节数（含数组结构开销）。 */
export function appendOperationLogBytes(receipts: readonly AppendOperationReceipt[]): number {
  return new TextEncoder().encode(JSON.stringify(receipts)).length;
}

/**
 * P3-01：追加收据台账容量治理（纯函数，不修改传入数组或任何收据）。
 *
 * 预算判定对象是“已有收据＋本次新增收据”的最终候选数组。超预算时按**稳定历史
 * 顺序**压缩最旧的 applied 收据：
 * - 排序键：`createdAt` 升序，同时间按 `operationId` 升序；两键都相同时保持数组
 *   原顺序（稳定排序）。operationId 在台账内唯一，因此压缩/保留的选择与输入数组
 *   顺序无关，结果完全确定。
 * - 保留集合最多 `recentFull`（K）条完整明细：`incoming`（本次新收据）**占一个名额**，
 *   其余最多 K-1 条给最新的历史 applied 收据；即使本次收据的 createdAt 早于全部历史
 *   （时钟回拨），保留集合总数也不超过 K。
 * - `purged` 终态沿用既有规则，本函数不改动它们；压缩只清空明细数组
 *   （compactAppliedReceipt），幂等身份字段全部保留。
 * - 压缩后仍超预算返回 null，由调用方在**同一事务内**明确拒绝（拒绝时不写任何数据）。
 */
export function governAppendOperationLog(
  candidate: readonly AppendOperationReceipt[],
  incoming: AppendOperationReceipt,
  budgetBytes: number = APPEND_OPERATION_LOG_BUDGET_BYTES,
  recentFull: number = APPEND_OPERATION_LOG_RECENT_KEEP
): AppendOperationReceipt[] | null {
  if (appendOperationLogBytes(candidate) <= budgetBytes) return [...candidate];
  const appliedOldestFirst = candidate
    .map((receipt, index) => ({ receipt, index }))
    .filter((entry) => entry.receipt.status === "applied")
    .sort(
      (left, right) =>
        left.receipt.createdAt.localeCompare(right.receipt.createdAt) ||
        left.receipt.operationId.localeCompare(right.receipt.operationId) ||
        left.index - right.index
    );
  /*
   * 完整明细保留名额共 recentFull（K）条：本次新收据**占其中一个名额**，
   * 其余最多 K-1 条给最新的历史 applied 收据——保留集合总数不超过 K
   *（即使本次收据的 createdAt 早于全部历史，也不会扩成 K+1）。
   */
  const historyApplied = appliedOldestFirst.filter(
    (entry) => entry.receipt.operationId !== incoming.operationId
  );
  const keepFull = new Set(
    historyApplied
      .slice(Math.max(0, historyApplied.length - Math.max(0, recentFull - 1)))
      .map((entry) => entry.receipt.operationId)
  );
  keepFull.add(incoming.operationId);
  const governed = candidate.map((receipt) =>
    receipt.status === "applied" && !keepFull.has(receipt.operationId)
      ? compactAppliedReceipt(receipt)
      : receipt
  );
  return appendOperationLogBytes(governed) <= budgetBytes ? governed : null;
}

/**
 * 024：永久删除后的最小幂等终态收据。
 *
 * 与预算压缩（compactAppliedReceipt）共用同一条“明细退化”规则，只把状态改为
 * `purged`：身份字段全部保留、明细数组清空，重放返回“目标已永久删除”。
 * 规范化与永久删除共用本函数，避免同一规则写两份。
 */
export function minimalPurgedReceipt(receipt: AppendOperationReceipt): AppendOperationReceipt {
  return { ...compactAppliedReceipt(receipt), status: "purged" };
}

/**
 * 024：把永久删除计划落到档案上。
 *
 * - 页与本从档案移除；
 * - 追加收据降级为最小终态（`status: "purged"`，去掉块/媒体/消息明细），
 *   使同一 operationId 重放能返回“目标已永久删除”，而不是复活页面；
 * - 只保留 `purgedPages` 的 id 与时间，不保留正文与图片信息；
 * - 与该篇相关的来源关联、出行元数据一并移除（它们只服务于活动篇）。
 */
export function applyPurge<T extends Omit<NotebookArchive, "media">>(
  archive: T,
  plan: PurgePlan,
  now: () => Date = () => new Date()
): T {
  const pageIdSet = new Set(plan.pageIds);
  const notebookIdSet = new Set(plan.notebookIds);
  const purgedAt = now().toISOString();
  /*
   * P6：永久删除篇（含删本导致的级联）必须**同一变更内**清掉 P6 关系，
   * 否则会留下指向已永久删除篇的悬挂引用。复用 `purgePageInSlice`（已测的纯函数），
   * 篇自身的墓碑仍由既有 `purgedPages` 负责，不写第二套。
   */
  const tripSlice = [...pageIdSet].reduce(
    (current, pageId) => purgePageInSlice(current, pageId),
    readTripSlice(archive)
  );

  const purgedPages = [
    ...archive.purgedPages.filter((record) => !pageIdSet.has(record.pageId)),
    ...[...pageIdSet].map((pageId) => ({ pageId, purgedAt }))
  ];

  const appendOperations = archive.appendOperations.map((receipt) => {
    const targetsPurged =
      pageIdSet.has(receipt.pageId) ||
      (receipt.resultPageId !== undefined && pageIdSet.has(receipt.resultPageId));
    if (!targetsPurged) return receipt;
    return minimalPurgedReceipt(receipt);
  });

  return {
    ...archive,
    notebooks: archive.notebooks.filter((notebook) => !notebookIdSet.has(notebook.id)),
    pages: archive.pages.filter((page) => !pageIdSet.has(page.id)),
    tripJournals: archive.tripJournals.filter((entry) => !pageIdSet.has(entry.pageId)),
    pageSources: archive.pageSources.filter((link) => !pageIdSet.has(link.pageId)),
    legacyImports: archive.legacyImports
      .map((record) => {
        const linkedPurged = pageIdSet.has(record.linkedPageId);
        const copiedPurged = record.copiedPageId ? pageIdSet.has(record.copiedPageId) : false;
        if (!linkedPurged && !copiedPurged) return record;
        return {
          ...record,
          linkedPageId: linkedPurged ? "" : record.linkedPageId,
          copiedPageId: copiedPurged ? null : record.copiedPageId,
          copyStatus: copiedPurged ? null : record.copyStatus
        };
      })
      .filter((record) => record.linkedPageId !== ""),
    appendOperations,
    purgedPages,
    ...tripSlice
  };
}

/** 是否已被永久删除（幂等终态查询）。 */
export function isPagePurged(
  archive: { purgedPages: PurgedPageRecord[] },
  pageId: string
): boolean {
  return archive.purgedPages.some((record) => record.pageId === pageId);
}
