import {
  EMPTY_ARCHIVE_CORE,
  type ArchiveCore,
  type NotebookRepository
} from "./notebook-repository";
import {
  fingerprintParts,
  LEGACY_NOTEBOOK_TITLE,
  NOTEBOOK_ARCHIVE_VERSION,
  NOTEBOOK_STORAGE_KEY,
  type LegacyImportRecord,
  type Notebook,
  type NotebookMedia,
  type NotebookPage,
  type NotebookPageBlock
} from "./notebook-model";

export type MigrationReport = {
  status: "migrated" | "skipped-non-empty" | "skipped-empty" | "failed";
  notebooks: number;
  pages: number;
  media: number;
  /** 原始 localStorage 键是否保持未改动。始终为 true。 */
  sourcePreserved: true;
  issues: string[];
};

type LegacyPhoto = { id: string; name: string; type: string; size: number; dataUrl: string };

type LegacyBlock =
  { id: string; type: "text"; text: string } | { id: string; type: "photo"; photo: LegacyPhoto };

type LegacyPage = {
  id: string;
  notebookId: string;
  title: string;
  blocks: LegacyBlock[];
  source: { kind: string; spotId?: string };
  capturedAt: string;
  createdAt: string;
  updatedAt: string;
};

type LegacyArchiveFile = {
  schemaVersion?: number;
  notebooks?: unknown[];
  pages?: LegacyPage[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isLegacyPhoto(value: unknown): value is LegacyPhoto {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.type === "string" &&
    typeof value.size === "number" &&
    typeof value.dataUrl === "string" &&
    value.dataUrl.startsWith("data:")
  );
}

function isLegacyPage(value: unknown): value is LegacyPage {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.notebookId === "string" &&
    typeof value.title === "string" &&
    Array.isArray(value.blocks) &&
    isRecord(value.source)
  );
}

function isStoredNotebook(value: unknown): value is Notebook {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.order === "number" &&
    (value.archivedAt === null || typeof value.archivedAt === "string") &&
    (value.deletedAt === null || typeof value.deletedAt === "string") &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
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

export type LegacyLocalStorageSnapshot = {
  archive: ArchiveCore;
  media: NotebookMedia[];
  issues: string[];
};

/**
 * 只读解析 v1 localStorage 笔记本档案（Data URL 版），不写入也不删除该键。
 * 图片解码失败时保留页面与文字，并把问题记入 issues，不谎报成功。
 */
export function readLegacyLocalStorageArchive(
  storage: Pick<Storage, "getItem">,
  now: () => Date = () => new Date()
): LegacyLocalStorageSnapshot | null {
  const raw = storage.getItem(NOTEBOOK_STORAGE_KEY);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const file = parsed as LegacyArchiveFile;
  const notebooks = (file.notebooks ?? []).filter(isStoredNotebook);
  const legacyPages = (file.pages ?? []).filter(isLegacyPage);
  if (notebooks.length === 0 && legacyPages.length === 0) return null;

  const timestamp = now().toISOString();
  const issues: string[] = [];
  const media: NotebookMedia[] = [];
  const pages: NotebookPage[] = [];
  const legacyImports: LegacyImportRecord[] = [];

  for (const legacyPage of legacyPages) {
    const blocks: NotebookPageBlock[] = [];
    const spotId = legacyPage.source.spotId;
    for (const block of legacyPage.blocks) {
      if (block.type === "text") {
        blocks.push({ id: block.id, type: "text", text: block.text });
        continue;
      }
      if (!isLegacyPhoto(block.photo)) {
        issues.push(`页面「${legacyPage.title}」有一个无法识别的图片块，已跳过。`);
        continue;
      }
      const blob = decodeDataUrl(block.photo.dataUrl, block.photo.type);
      if (!blob) {
        issues.push(
          `页面「${legacyPage.title}」的图片 ${block.photo.name} 解码失败，未迁移该图片。`
        );
        continue;
      }
      const mediaId = `md-migrated-${block.photo.id}`;
      const existing = media.find((item) => item.id === mediaId);
      if (!existing) {
        media.push({
          id: mediaId,
          name: block.photo.name,
          type: block.photo.type,
          size: block.photo.size,
          createdAt: legacyPage.createdAt || timestamp,
          blob,
          origin: { kind: "local-upload" }
        });
      }
      blocks.push({
        id: block.id,
        type: "photo",
        mediaId,
        caption: block.photo.name
      });
    }

    const isLegacySource = legacyPage.source.kind === "legacy-journal" && Boolean(spotId);
    const page: NotebookPage = {
      schemaVersion: NOTEBOOK_ARCHIVE_VERSION,
      id: legacyPage.id,
      notebookId: legacyPage.notebookId,
      title: legacyPage.title,
      blocks,
      source: isLegacySource && spotId ? { kind: "legacy-journal", spotId } : { kind: "manual" },
      capturedAt: legacyPage.capturedAt || timestamp,
      createdAt: legacyPage.createdAt || timestamp,
      updatedAt: legacyPage.updatedAt || timestamp
    };
    pages.push(page);

    if (isLegacySource && spotId) {
      const text = blocks
        .filter((item): item is { id: string; type: "text"; text: string } => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      legacyImports.push({
        spotId,
        linkedPageId: page.id,
        copiedPageId: null,
        copiedAt: null,
        copyStatus: null,
        sourceFingerprint: fingerprintParts([text, blocks.length]),
        issues: [],
        importedAt: legacyPage.createdAt || timestamp
      });
    }
  }

  return {
    archive: {
      schemaVersion: NOTEBOOK_ARCHIVE_VERSION,
      revision: 0,
      notebooks,
      pages,
      legacyImports,
      tripJournals: [],
      pageSources: [],
      appendOperations: [],
      // 024/P1-03 新增字段：迁移结果同样按缺省值填齐，避免调用方读取时缺键。
      aiCommitReceipts: [],
      purgedPages: [],
      trashConfirmedAt: null,
      trips: [],
      places: [],
      tripPageLinks: [],
      pagePlaceLinks: [],
      purgedTrips: [],
      purgedPlaces: []
    },
    media,
    issues
  };
}

/**
 * 把既有 localStorage 笔记本迁移到独立仓库。
 * - 目标仓库已有内容时跳过（幂等），不产生重复；
 * - localStorage 原键在迁移成功后也不删除、不修改；
 * - 迁移失败时不写入任何数据并保留来源。
 */
export async function migrateLegacyLocalStorage(
  repository: NotebookRepository,
  storage: Pick<Storage, "getItem">,
  now: () => Date = () => new Date()
): Promise<MigrationReport> {
  const empty = (status: MigrationReport["status"], issues: string[] = []): MigrationReport => ({
    status,
    notebooks: 0,
    pages: 0,
    media: 0,
    sourcePreserved: true,
    issues
  });

  const snapshot = readLegacyLocalStorageArchive(storage, now);
  if (!snapshot) return empty("skipped-empty");

  const existing = await repository.loadArchive();
  if (existing.notebooks.length > 0 || existing.pages.length > 0) {
    return empty("skipped-non-empty");
  }

  const existingMedia = await repository.loadMedia();
  if (existingMedia.length > 0) return empty("skipped-non-empty");

  const archive: ArchiveCore = {
    ...EMPTY_ARCHIVE_CORE,
    notebooks: snapshot.archive.notebooks,
    pages: snapshot.archive.pages,
    legacyImports: snapshot.archive.legacyImports
  };

  try {
    await repository.saveMedia(snapshot.media);
    await repository.saveArchive(archive);
  } catch (error) {
    return empty("failed", [
      error instanceof Error ? error.message : "迁移写入失败，来源数据保持原样。"
    ]);
  }

  return {
    status: "migrated",
    notebooks: archive.notebooks.length,
    pages: archive.pages.length,
    media: snapshot.media.length,
    sourcePreserved: true,
    issues: snapshot.issues
  };
}

export { LEGACY_NOTEBOOK_TITLE };
