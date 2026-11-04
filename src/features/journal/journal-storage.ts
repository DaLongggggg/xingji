import {
  isSupportedJournalPhotoType,
  MAX_JOURNAL_PHOTO_BYTES,
  MAX_JOURNAL_PHOTOS,
  MAX_JOURNAL_TOTAL_PHOTO_BYTES,
  type JournalPhoto
} from "./journal-image";

export {
  isSupportedJournalPhotoType,
  MAX_JOURNAL_PHOTO_BYTES,
  MAX_JOURNAL_PHOTOS,
  MAX_JOURNAL_TOTAL_PHOTO_BYTES,
  type JournalPhoto
} from "./journal-image";

export const JOURNAL_STORAGE_KEY = "xingji:journals:v2";
export const LEGACY_JOURNAL_STORAGE_KEY = "xingji:journals:v1";
export const MAX_JOURNAL_MARKDOWN_LENGTH = 10_000;
export const JOURNAL_PHOTO_SOURCE_PREFIX = "journal-photo://";

export type JournalRating = 1 | 2 | 3 | 4 | 5;

export type SpotJournal = {
  schemaVersion: 2;
  spotId: string;
  visited: boolean;
  visitedAt: string;
  rating: JournalRating | null;
  contentMarkdown: string;
  photos: JournalPhoto[];
  updatedAt: string;
};

type LegacySpotJournal = {
  schemaVersion: 1;
  spotId: string;
  visited: boolean;
  visitedAt: string;
  rating: JournalRating | null;
  note: string;
  photos: JournalPhoto[];
  updatedAt: string;
};

type SharedJournalFields = Pick<
  SpotJournal,
  "spotId" | "visited" | "visitedAt" | "rating" | "photos" | "updatedAt"
>;

export type JournalStorage = Pick<Storage, "getItem" | "setItem">;

export function createEmptyJournal(spotId: string): SpotJournal {
  return {
    schemaVersion: 2,
    spotId,
    visited: false,
    visitedAt: "",
    rating: null,
    contentMarkdown: "",
    photos: [],
    updatedAt: ""
  };
}

export function createJournalPhotoSource(photoId: string): string {
  return `${JOURNAL_PHOTO_SOURCE_PREFIX}${photoId}`;
}

export function retainReferencedPhotos(
  contentMarkdown: string,
  photos: JournalPhoto[]
): JournalPhoto[] {
  return photos.filter((photo) => contentMarkdown.includes(createJournalPhotoSource(photo.id)));
}

function isRating(value: unknown): value is JournalRating | null {
  return value === null || value === 1 || value === 2 || value === 3 || value === 4 || value === 5;
}

function isJournalPhoto(value: unknown): value is JournalPhoto {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<JournalPhoto>;
  return (
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    typeof candidate.name === "string" &&
    typeof candidate.type === "string" &&
    isSupportedJournalPhotoType(candidate.type) &&
    typeof candidate.size === "number" &&
    Number.isInteger(candidate.size) &&
    candidate.size >= 0 &&
    candidate.size <= MAX_JOURNAL_PHOTO_BYTES &&
    typeof candidate.dataUrl === "string" &&
    candidate.dataUrl.startsWith(`data:${candidate.type};base64,`)
  );
}

function hasValidSharedFields(value: unknown): value is SharedJournalFields {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SharedJournalFields>;
  return (
    typeof candidate.spotId === "string" &&
    candidate.spotId.length > 0 &&
    typeof candidate.visited === "boolean" &&
    typeof candidate.visitedAt === "string" &&
    isRating(candidate.rating) &&
    Array.isArray(candidate.photos) &&
    candidate.photos.length <= MAX_JOURNAL_PHOTOS &&
    candidate.photos.every(isJournalPhoto) &&
    candidate.photos.reduce((total, photo) => total + photo.size, 0) <=
      MAX_JOURNAL_TOTAL_PHOTO_BYTES &&
    typeof candidate.updatedAt === "string"
  );
}

function isSpotJournal(value: unknown): value is SpotJournal {
  if (!hasValidSharedFields(value)) return false;
  const candidate = value as Partial<SpotJournal>;
  return (
    candidate.schemaVersion === 2 &&
    typeof candidate.contentMarkdown === "string" &&
    candidate.contentMarkdown.length <= MAX_JOURNAL_MARKDOWN_LENGTH
  );
}

function isLegacySpotJournal(value: unknown): value is LegacySpotJournal {
  if (!hasValidSharedFields(value)) return false;
  const candidate = value as Partial<LegacySpotJournal>;
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.note === "string" &&
    candidate.note.length <= 2_000
  );
}

function escapeMarkdownAltText(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("]", "\\]");
}

export function migrateLegacyJournal(journal: LegacySpotJournal): SpotJournal {
  const parts: string[] = [];
  if (journal.note.trim()) parts.push(journal.note);
  parts.push(
    ...journal.photos.map(
      (photo) => `![${escapeMarkdownAltText(photo.name)}](${createJournalPhotoSource(photo.id)})`
    )
  );

  return {
    schemaVersion: 2,
    spotId: journal.spotId,
    visited: journal.visited,
    visitedAt: journal.visitedAt,
    rating: journal.rating,
    contentMarkdown: parts.join("\n\n"),
    photos: journal.photos,
    updatedAt: journal.updatedAt
  };
}

function parseJournalMap<T>(
  rawValue: string | null,
  validate: (value: unknown) => value is T
): Record<string, T> | null {
  if (!rawValue) return null;

  try {
    const parsed: unknown = JSON.parse(rawValue);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    const journals: Record<string, T> = {};
    for (const [spotId, value] of Object.entries(parsed)) {
      if (validate(value) && (value as { spotId: string }).spotId === spotId) {
        journals[spotId] = value;
      }
    }
    return journals;
  } catch {
    return {};
  }
}

function loadJournalMap(storage: Pick<Storage, "getItem">): Record<string, SpotJournal> {
  const currentMap = parseJournalMap(storage.getItem(JOURNAL_STORAGE_KEY), isSpotJournal);
  if (currentMap !== null) return currentMap;

  const legacyMap = parseJournalMap(
    storage.getItem(LEGACY_JOURNAL_STORAGE_KEY),
    isLegacySpotJournal
  );
  if (!legacyMap) return {};

  return Object.fromEntries(
    Object.entries(legacyMap).map(([spotId, journal]) => [spotId, migrateLegacyJournal(journal)])
  );
}

export function loadJournal(
  spotId: string,
  storage: Pick<Storage, "getItem"> = localStorage
): SpotJournal {
  return loadJournalMap(storage)[spotId] ?? createEmptyJournal(spotId);
}

/**
 * 只读读取全部已保存游记，供 2.0 兼容入口枚举旧数据使用。
 * 只调用 getItem，不写入、不迁移、不删除任何键，旧数据保持原样。
 */
export function loadAllJournals(storage: Pick<Storage, "getItem">): Record<string, SpotJournal> {
  return loadJournalMap(storage);
}

function assertJournal(journal: SpotJournal): void {
  if (!isSpotJournal(journal)) {
    throw new Error("JOURNAL_INVALID");
  }
}

export function saveJournal(
  journal: SpotJournal,
  storage: JournalStorage = localStorage,
  now: () => Date = () => new Date()
): SpotJournal {
  const contentMarkdown = journal.contentMarkdown.trim();
  const savedJournal = {
    ...journal,
    contentMarkdown,
    photos: retainReferencedPhotos(contentMarkdown, journal.photos),
    updatedAt: now().toISOString()
  } satisfies SpotJournal;
  assertJournal(savedJournal);
  const journals = loadJournalMap(storage);
  journals[savedJournal.spotId] = savedJournal;

  try {
    storage.setItem(JOURNAL_STORAGE_KEY, JSON.stringify(journals));
  } catch {
    throw new Error("JOURNAL_STORAGE_FAILED");
  }

  return savedJournal;
}

export function removeJournal(spotId: string, storage: JournalStorage = localStorage): SpotJournal {
  const journals = loadJournalMap(storage);
  delete journals[spotId];

  try {
    storage.setItem(JOURNAL_STORAGE_KEY, JSON.stringify(journals));
  } catch {
    throw new Error("JOURNAL_STORAGE_FAILED");
  }

  return createEmptyJournal(spotId);
}
