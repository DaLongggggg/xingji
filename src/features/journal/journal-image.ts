export const MAX_JOURNAL_PHOTOS = 3;
export const MAX_JOURNAL_PHOTO_BYTES = 1024 * 1024;
export const MAX_JOURNAL_TOTAL_PHOTO_BYTES = 2 * 1024 * 1024;

const SUPPORTED_PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export type JournalPhoto = {
  id: string;
  name: string;
  type: string;
  size: number;
  dataUrl: string;
};

export type JournalImageErrorCode =
  | "JOURNAL_PHOTO_COUNT_EXCEEDED"
  | "JOURNAL_PHOTO_TYPE_UNSUPPORTED"
  | "JOURNAL_PHOTO_TOO_LARGE"
  | "JOURNAL_PHOTO_TOTAL_TOO_LARGE"
  | "JOURNAL_PHOTO_READ_FAILED";

export class JournalImageError extends Error {
  constructor(readonly code: JournalImageErrorCode) {
    super(code);
    this.name = "JournalImageError";
  }
}

export function isSupportedJournalPhotoType(type: string): boolean {
  return SUPPORTED_PHOTO_TYPES.has(type);
}

/**
 * 单张/批次上限。默认值保持 1.x 游记的既有口径（3 张 / 1 MiB / 2 MiB）；
 * 记录入口与笔记本显式传入当前容量上限，
 * 避免同一文件在一处通过、在另一处被隐藏的旧限制拒绝。
 */
export type JournalPhotoLimits = {
  maxPhotos: number;
  maxPhotoBytes: number;
  maxTotalBytes: number;
};

export const JOURNAL_PHOTO_LIMITS: JournalPhotoLimits = {
  maxPhotos: MAX_JOURNAL_PHOTOS,
  maxPhotoBytes: MAX_JOURNAL_PHOTO_BYTES,
  maxTotalBytes: MAX_JOURNAL_TOTAL_PHOTO_BYTES
};

export function validateJournalPhoto(
  file: File,
  currentPhotos: JournalPhoto[],
  limits: JournalPhotoLimits = JOURNAL_PHOTO_LIMITS
): void {
  if (currentPhotos.length >= limits.maxPhotos) {
    throw new JournalImageError("JOURNAL_PHOTO_COUNT_EXCEEDED");
  }
  if (!isSupportedJournalPhotoType(file.type)) {
    throw new JournalImageError("JOURNAL_PHOTO_TYPE_UNSUPPORTED");
  }
  if (file.size > limits.maxPhotoBytes) {
    throw new JournalImageError("JOURNAL_PHOTO_TOO_LARGE");
  }
  const totalSize = currentPhotos.reduce((total, photo) => total + photo.size, file.size);
  if (totalSize > limits.maxTotalBytes) {
    throw new JournalImageError("JOURNAL_PHOTO_TOTAL_TOO_LARGE");
  }
}

export function readJournalPhoto(file: File, id: string): Promise<JournalPhoto> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new JournalImageError("JOURNAL_PHOTO_READ_FAILED"));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new JournalImageError("JOURNAL_PHOTO_READ_FAILED"));
        return;
      }
      resolve({ id, name: file.name, type: file.type, size: file.size, dataUrl: reader.result });
    };
    reader.readAsDataURL(file);
  });
}
