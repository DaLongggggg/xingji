import {
  createJournalPhotoSource,
  loadAllJournals,
  type SpotJournal
} from "@/features/journal/journal-storage";
import { loadTrips } from "@/features/storage/trip-storage";
import type { TripDraft } from "@/server/shared/types";
import {
  createPage,
  extractLegacyPhotoIds,
  fingerprintParts,
  findLegacyImport,
  LEGACY_NOTEBOOK_TITLE,
  MAX_PAGE_TEXT_LENGTH,
  MAX_MEDIA_BYTES,
  NOTEBOOK_ARCHIVE_VERSION,
  type LegacyImportRecord,
  type NotebookMedia,
  type NotebookPage,
  type NotebookPageBlock
} from "./notebook-model";
import type { ArchiveCore } from "./notebook-repository";

export { LEGACY_NOTEBOOK_TITLE };

export type LegacyJournalCandidate = {
  spotId: string;
  visited: boolean;
  visitedAt: string;
  rating: number | null;
  updatedAt: string;
  contentMarkdown: string;
  photoIds: string[];
  photoCount: number;
  /** 已有关联页（旧版关联查看）。 */
  linked: boolean;
  /** 已独立复制且完整。 */
  copied: boolean;
  /** 上次复制遗留的问题，非空表示可重试。 */
  copyIssues: string[];
  /** 来源内容与上次复制时不一致。 */
  sourceChanged: boolean;
};

export type LegacyTripCandidate = {
  id: string;
  name: string;
  dayCount: number;
  updatedAt: string;
};

export type LegacyInspection = {
  journals: LegacyJournalCandidate[];
  trips: LegacyTripCandidate[];
};

export type LegacyLinkResult = {
  archive: ArchiveCore;
  linkedPageIds: string[];
  linkedCount: number;
  skippedAlreadyLinked: number;
};

export type LegacyCopyResult = {
  archive: ArchiveCore;
  /** 新增媒体；调用方负责写入 media store。 */
  media: NotebookMedia[];
  copied: boolean;
  /** complete=正文与全部图片都已独立复制；partial=有缺失，可重试。 */
  status: "complete" | "partial" | "skipped" | "failed";
  copiedPageId: string | null;
  copiedMediaCount: number;
  issues: string[];
};

type ReadOnlyStorage = Pick<Storage, "getItem">;

function hasJournalContent(journal: SpotJournal): boolean {
  return journal.contentMarkdown.trim().length > 0 || journal.photos.length > 0;
}

export function legacySourceFingerprint(journal: SpotJournal): string {
  return fingerprintParts([
    journal.contentMarkdown,
    journal.visited ? 1 : 0,
    journal.visitedAt,
    journal.rating ?? 0,
    ...journal.photos.map((photo) => `${photo.id}:${photo.size}:${photo.type}`)
  ]);
}

/**
 * 只读检查 1.x 浏览器数据（游记 xingji:journals:v1/v2、行程 xingji:trips:v1）。
 * 只调用 getItem，不写入、不删除、不清空任何旧数据。
 */
export function inspectLegacyData(
  archive: ArchiveCore,
  storage: ReadOnlyStorage
): LegacyInspection {
  const journals = Object.values(loadAllJournals(storage))
    .filter(hasJournalContent)
    .map<LegacyJournalCandidate>((journal) => {
      const record = findLegacyImport(archive, journal.spotId);
      const fingerprint = legacySourceFingerprint(journal);
      return {
        spotId: journal.spotId,
        visited: journal.visited,
        visitedAt: journal.visitedAt,
        rating: journal.rating,
        updatedAt: journal.updatedAt,
        contentMarkdown: journal.contentMarkdown,
        photoIds: journal.photos.map((photo) => photo.id),
        photoCount: journal.photos.length,
        linked: Boolean(record),
        copied: Boolean(record?.copiedPageId) && record?.copyStatus === "complete",
        copyIssues: record?.issues ?? [],
        sourceChanged: Boolean(record?.copiedPageId) && record?.sourceFingerprint !== fingerprint
      };
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  const trips = loadTrips(storage).map<LegacyTripCandidate>((trip: TripDraft) => ({
    id: trip.id,
    name: trip.name,
    dayCount: Array.isArray(trip.itineraryDays) ? trip.itineraryDays.length : 0,
    updatedAt: typeof trip.updatedAt === "string" ? trip.updatedAt : ""
  }));

  return { journals, trips };
}

export function legacyPhotoSource(photoId: string): string {
  return createJournalPhotoSource(photoId);
}

function findTargetNotebook(
  archive: ArchiveCore,
  now: () => Date
): {
  archive: ArchiveCore;
  notebookId: string;
} {
  const existing = archive.notebooks.find(
    (notebook) => notebook.title === LEGACY_NOTEBOOK_TITLE && !notebook.deletedAt
  );
  if (existing) return { archive, notebookId: existing.id };
  // 惰性创建目标笔记本，避免“只是查看”时产生空笔记本。
  const timestamp = now().toISOString();
  const notebook = {
    schemaVersion: NOTEBOOK_ARCHIVE_VERSION as typeof NOTEBOOK_ARCHIVE_VERSION,
    id: `nb-legacy-${Date.parse(timestamp) || 0}-${archive.notebooks.length + 1}`,
    title: LEGACY_NOTEBOOK_TITLE,
    createdAt: timestamp,
    updatedAt: timestamp,
    order: archive.notebooks.reduce((max, item) => Math.max(max, item.order), 0) + 1,
    archivedAt: null,
    deletedAt: null
  };
  return {
    archive: { ...archive, notebooks: [...archive.notebooks, notebook] },
    notebookId: notebook.id
  };
}

/**
 * 建立“旧版关联查看”：只新增引用页与来源映射，不复制正文与图片。
 * 已有关联记录时跳过，重复调用不产生重复记录。
 */
export function linkLegacyJournals(
  archive: ArchiveCore,
  candidates: LegacyJournalCandidate[],
  now: () => Date = () => new Date()
): LegacyLinkResult {
  let next = archive;
  const linkedPageIds: string[] = [];
  let skipped = 0;

  for (const candidate of candidates) {
    if (findLegacyImport(next, candidate.spotId)) {
      skipped += 1;
      continue;
    }
    const target = findTargetNotebook(next, now);
    const text = candidate.contentMarkdown.trim().slice(0, MAX_PAGE_TEXT_LENGTH);
    const created = createPage(
      target.archive,
      {
        notebookId: target.notebookId,
        title: candidate.visitedAt ? `${candidate.visitedAt} 的游记` : "1.x 游记",
        capturedAt: candidate.visitedAt || candidate.updatedAt || now().toISOString(),
        blocks: text ? [{ id: `blk-link-${candidate.spotId}`, type: "text", text }] : [],
        source: { kind: "legacy-journal", spotId: candidate.spotId }
      },
      now
    );
    const record: LegacyImportRecord = {
      spotId: candidate.spotId,
      linkedPageId: created.page.id,
      copiedPageId: null,
      copiedAt: null,
      copyStatus: null,
      sourceFingerprint: "",
      issues: [],
      importedAt: now().toISOString()
    };
    next = { ...created.archive, legacyImports: [...created.archive.legacyImports, record] };
    linkedPageIds.push(created.page.id);
  }

  return {
    archive: next,
    linkedPageIds,
    linkedCount: linkedPageIds.length,
    skippedAlreadyLinked: skipped
  };
}

export type LegacyCopyInput = {
  spotId: string;
  /** 来源游记；undefined 表示来源已不存在。 */
  journal: SpotJournal | undefined;
  /** true 表示用户明确要求再复制一份。 */
  force?: boolean;
};

function buildCopyBlocks(
  journal: SpotJournal,
  mediaByPhotoId: Map<string, NotebookMedia>,
  issues: string[]
): NotebookPageBlock[] {
  const referenced = extractLegacyPhotoIds(journal.contentMarkdown);
  const ordered = referenced.length > 0 ? referenced : journal.photos.map((photo) => photo.id);
  const blocks: NotebookPageBlock[] = [];
  const text = journal.contentMarkdown.trim().slice(0, MAX_PAGE_TEXT_LENGTH);

  if (text) blocks.push({ id: `blk-copy-${journal.spotId}`, type: "text", text });

  for (const photoId of ordered) {
    const media = mediaByPhotoId.get(photoId);
    if (!media) {
      issues.push(`图片 ${photoId} 在旧游记中缺失或无法读取，本次未复制该图片。`);
      continue;
    }
    blocks.push({
      id: `blk-copy-photo-${photoId}`,
      type: "photo",
      mediaId: media.id,
      caption: media.name
    });
  }
  return blocks;
}

function decodeDataUrl(dataUrl: string, type: string): Blob | undefined {
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex < 0) return undefined;
  const header = dataUrl.slice(0, commaIndex);
  const payload = dataUrl.slice(commaIndex + 1);
  try {
    if (!header.includes(";base64")) {
      return new Blob([decodeURIComponent(payload)], { type });
    }
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new Blob([bytes], { type });
  } catch {
    return undefined;
  }
}

/**
 * 把关联的旧游记**独立复制**为笔记：复制正文与媒体 Blob，复制后不再依赖旧游记存储。
 * - 来源缺失或媒体不可读时不标记为完整成功，保留来源与可重试状态；
 * - 来源指纹已变化且未显式要求再复制时，不覆盖用户已有笔记；
 * - 已完整复制且来源未变时重复调用不重复创建页面。
 */
export function copyLegacyJournal(
  archive: ArchiveCore,
  candidate: LegacyJournalCandidate,
  input: LegacyCopyInput,
  now: () => Date = () => new Date()
): LegacyCopyResult {
  const existingRecord = findLegacyImport(archive, candidate.spotId);
  const journal = input.journal;
  const media: NotebookMedia[] = [];

  if (!journal) {
    return {
      archive,
      media,
      copied: false,
      status: "failed",
      copiedPageId: null,
      copiedMediaCount: 0,
      issues: ["旧游记来源已不存在，未复制任何内容。旧游记数据未被修改。"]
    };
  }

  if (existingRecord?.copiedPageId && existingRecord.copyStatus === "complete" && !input.force) {
    if (legacySourceFingerprint(journal) === existingRecord.sourceFingerprint) {
      return {
        archive,
        media,
        copied: false,
        status: "skipped",
        copiedPageId: existingRecord.copiedPageId,
        copiedMediaCount: 0,
        issues: []
      };
    }
    return {
      archive,
      media,
      copied: false,
      status: "failed",
      copiedPageId: existingRecord.copiedPageId,
      copiedMediaCount: 0,
      issues: ["来源游记在上次复制后已变化。为避免覆盖你已编辑的笔记本，未自动复制；请确认后重试。"]
    };
  }

  const timestamp = now().toISOString();
  const issues: string[] = [];
  const mediaByPhotoId = new Map<string, NotebookMedia>();

  for (const photo of journal.photos) {
    if (!photo.dataUrl.startsWith("data:")) {
      issues.push(`图片 ${photo.id} 的数据格式无法识别，本次未复制。`);
      continue;
    }
    if (photo.size > MAX_MEDIA_BYTES) {
      issues.push(`图片 ${photo.name} 超过单张上限，本次未复制。`);
      continue;
    }
    const blob = decodeDataUrl(photo.dataUrl, photo.type);
    if (!blob) {
      issues.push(`图片 ${photo.name} 解码失败，本次未复制。`);
      continue;
    }
    const item: NotebookMedia = {
      id: `md-copy-${candidate.spotId}-${photo.id}`,
      name: photo.name,
      type: photo.type,
      size: photo.size,
      createdAt: timestamp,
      blob,
      origin: { kind: "legacy-journal-photo", spotId: candidate.spotId, photoId: photo.id }
    };
    mediaByPhotoId.set(photo.id, item);
    media.push(item);
  }

  const blocks = buildCopyBlocks(journal, mediaByPhotoId, issues);
  const copiedPhotoCount = blocks.filter((block) => block.type === "photo").length;
  const status: "complete" | "partial" = issues.length > 0 ? "partial" : "complete";
  const target = findTargetNotebook(archive, now);
  const created = createPage(
    target.archive,
    {
      notebookId: target.notebookId,
      title: journal.visitedAt ? `${journal.visitedAt} 的游记（已复制）` : "1.x 游记（已复制）",
      capturedAt: journal.visitedAt || journal.updatedAt || timestamp,
      blocks,
      source: { kind: "copied-legacy-journal", spotId: candidate.spotId, copiedAt: timestamp }
    },
    now
  );

  let next = created.archive;
  if (existingRecord) {
    next = {
      ...next,
      legacyImports: next.legacyImports.map((record) =>
        record.spotId === candidate.spotId
          ? {
              ...record,
              copiedPageId: created.page.id,
              copiedAt: timestamp,
              copyStatus: status,
              sourceFingerprint: legacySourceFingerprint(journal),
              issues
            }
          : record
      )
    };
  } else {
    const record: LegacyImportRecord = {
      spotId: candidate.spotId,
      // 没有关联页时以复制页作为来源映射锚点，保持映射稳定。
      linkedPageId: created.page.id,
      copiedPageId: created.page.id,
      copiedAt: timestamp,
      copyStatus: status,
      sourceFingerprint: legacySourceFingerprint(journal),
      issues,
      importedAt: timestamp
    };
    next = { ...next, legacyImports: [...next.legacyImports, record] };
  }

  return {
    archive: next,
    media,
    copied: true,
    status,
    copiedPageId: created.page.id,
    copiedMediaCount: copiedPhotoCount,
    issues
  };
}

export function findLinkedPage(archive: ArchiveCore, spotId: string): NotebookPage | undefined {
  const record = findLegacyImport(archive, spotId);
  if (!record) return undefined;
  return archive.pages.find((page) => page.id === record.linkedPageId);
}
