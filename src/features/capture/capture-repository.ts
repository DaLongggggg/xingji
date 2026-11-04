import {
  CAPTURE_DB_NAME,
  CAPTURE_DB_VERSION,
  CAPTURE_STORE,
  EMPTY_CAPTURE_ARCHIVE,
  isBlobLike,
  isCaptureMedia,
  isCaptureMessage,
  updateCaptureMessage,
  type CaptureArchive,
  type CaptureMedia,
  type CaptureMessage,
  type CaptureUpdateResult
} from "./capture-model";

export type StoredCaptureMediaRecord = Omit<CaptureMedia, "blob"> & { blobData: ArrayBuffer };

/** 记录仓库：结构化消息与媒体二进制分开，UI 不直接操作 IndexedDB。 */
export type CaptureUpdateInput = {
  messageId: string;
  text: string;
  mediaIds: string[];
  /** 并发基线：与持久化中的 updatedAt 不一致即冲突，不覆盖。 */
  expectedUpdatedAt: string;
};

export interface CaptureRepository {
  loadArchive(): Promise<CaptureArchive>;
  saveArchive(archive: CaptureArchive): Promise<void>;
  /**
   * 020-C：原地更新一条已有记录（保留 messageId）。
   * 在**同一事务内**读最新状态并校验 `expectedUpdatedAt`，冲突时不写入。
   */
  updateMessage(input: CaptureUpdateInput): Promise<CaptureUpdateResult>;
  loadMedia(): Promise<CaptureMedia[]>;
  loadMediaBlob(mediaId: string): Promise<Blob | undefined>;
  /** F5：metadataOnly 启动的元数据视图（原生仓储提供；IDB 仓储可不实现）。 */
  loadMediaMetadata?(): Promise<(Omit<CaptureMedia, "blob">)[]>;
  saveMedia(media: CaptureMedia[]): Promise<void>;
  clear(): Promise<void>;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("CAPTURE_REQUEST_FAILED"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("CAPTURE_TX_FAILED"));
    transaction.onabort = () => reject(transaction.error ?? new Error("CAPTURE_TX_ABORTED"));
  });
}

const MESSAGE_STORE = "messages";
const MEDIA_STORE = "media";

/** 库名段清洗：账号标识只保留安全字符（与 notebook/ai 仓储同一规则）。 */
function sanitizeDbSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64) || "unknown";
}

function openDatabase(factory: IDBFactory, dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(dbName, CAPTURE_DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(MESSAGE_STORE)) {
        database.createObjectStore(MESSAGE_STORE, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(MEDIA_STORE)) {
        database.createObjectStore(MEDIA_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("CAPTURE_OPEN_FAILED"));
  });
}

async function toStoredMedia(media: CaptureMedia): Promise<StoredCaptureMediaRecord> {
  const { blob, ...rest } = media;
  return { ...rest, blobData: await blob.arrayBuffer() };
}

function toBlob(value: unknown, fallbackType: string): Blob | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (isBlobLike(value)) {
    const typed = value as Blob;
    return new Blob([typed], { type: typed.type || fallbackType });
  }
  if (typeof (value as ArrayBuffer).byteLength === "number") {
    return new Blob([new Uint8Array(value as ArrayBuffer)], { type: fallbackType });
  }
  return undefined;
}

function fromStoredMedia(record: unknown): CaptureMedia | undefined {
  if (!record || typeof record !== "object") return undefined;
  const candidate = record as Partial<StoredCaptureMediaRecord> & { blob?: unknown };
  const blob = toBlob(candidate.blobData ?? candidate.blob, candidate.type ?? "");
  if (!blob) return undefined;
  const {
    blobData,
    blob: legacyBlob,
    ...rest
  } = candidate as StoredCaptureMediaRecord & {
    blob?: unknown;
  };
  void blobData;
  void legacyBlob;
  const media = { ...(rest as Omit<CaptureMedia, "blob">), blob } as CaptureMedia;
  return isCaptureMedia(media) ? media : undefined;
}

export function createIndexedDbCaptureRepository(
  factory?: IDBFactory,
  now: () => Date = () => new Date(),
  /** T2a：按 serverId/userId 派生库名；缺省沿用旧单用户库名（既有测试/旧路径）。 */
  namespace?: { serverId: string; userId: string }
): CaptureRepository {
  const dbName = namespace
    ? `${CAPTURE_DB_NAME}--s-${sanitizeDbSegment(namespace.serverId)}-u-${sanitizeDbSegment(namespace.userId)}`
    : CAPTURE_DB_NAME;
  let databasePromise: Promise<IDBDatabase> | undefined;

  function getDatabase(): Promise<IDBDatabase> {
    const resolved = factory ?? (typeof indexedDB === "undefined" ? undefined : indexedDB);
    if (!resolved) return Promise.reject(new Error("INDEXEDDB_UNAVAILABLE"));
    databasePromise ??= openDatabase(resolved, dbName);
    return databasePromise;
  }

  return {
    async loadArchive() {
      const database = await getDatabase();
      const transaction = database.transaction(MESSAGE_STORE, "readonly");
      const messages = await requestToPromise<unknown[]>(
        transaction.objectStore(MESSAGE_STORE).getAll()
      );
      await transactionDone(transaction);
      return {
        schemaVersion: 1,
        messages: messages.filter(isCaptureMessage)
      } satisfies CaptureArchive;
    },

    async saveArchive(archive) {
      const database = await getDatabase();
      const transaction = database.transaction(MESSAGE_STORE, "readwrite");
      const store = transaction.objectStore(MESSAGE_STORE);
      const existing = await requestToPromise<CaptureMessage[]>(store.getAll());
      const nextIds = new Set(archive.messages.map((message) => message.id));
      await Promise.all(archive.messages.map((message) => requestToPromise(store.put(message))));
      await Promise.all(
        existing
          .filter((message) => !nextIds.has(message.id))
          .map((message) => requestToPromise(store.delete(message.id)))
      );
      await transactionDone(transaction);
    },

    async updateMessage(input) {
      const database = await getDatabase();
      const transaction = database.transaction(MESSAGE_STORE, "readwrite");
      const store = transaction.objectStore(MESSAGE_STORE);
      const currentMessages = await requestToPromise<unknown[]>(store.getAll());
      const archive: CaptureArchive = {
        schemaVersion: 1,
        messages: currentMessages.filter(isCaptureMessage)
      };
      const result = updateCaptureMessage(archive, input.messageId, {
        text: input.text,
        mediaIds: input.mediaIds
      }, input.expectedUpdatedAt);
      if (result.status === "updated") {
        await requestToPromise(store.put(result.message));
      }
      await transactionDone(transaction);
      return result;
    },

    async loadMedia() {
      const database = await getDatabase();
      const transaction = database.transaction(MEDIA_STORE, "readonly");
      const records = await requestToPromise<unknown[]>(
        transaction.objectStore(MEDIA_STORE).getAll()
      );
      await transactionDone(transaction);
      return records.map(fromStoredMedia).filter((item): item is CaptureMedia => Boolean(item));
    },

    async loadMediaBlob(mediaId) {
      const database = await getDatabase();
      const transaction = database.transaction(MEDIA_STORE, "readonly");
      const record = await requestToPromise<unknown>(
        transaction.objectStore(MEDIA_STORE).get(mediaId)
      );
      await transactionDone(transaction);
      return fromStoredMedia(record)?.blob;
    },

    async saveMedia(media) {
      const database = await getDatabase();
      const records = await Promise.all(media.map(toStoredMedia));
      const transaction = database.transaction(MEDIA_STORE, "readwrite");
      const store = transaction.objectStore(MEDIA_STORE);
      await Promise.all(records.map((record) => requestToPromise(store.put(record))));
      await transactionDone(transaction);
    },

    async clear() {
      const database = await getDatabase();
      const transaction = database.transaction([MESSAGE_STORE, MEDIA_STORE], "readwrite");
      await Promise.all([
        requestToPromise(transaction.objectStore(MESSAGE_STORE).clear()),
        requestToPromise(transaction.objectStore(MEDIA_STORE).clear())
      ]);
      await transactionDone(transaction);
    }
  };
}

export function createMemoryCaptureRepository(): CaptureRepository & {
  readonly store: { archive: CaptureArchive; media: CaptureMedia[] };
} {
  const store: { archive: CaptureArchive; media: CaptureMedia[] } = {
    archive: { ...EMPTY_CAPTURE_ARCHIVE },
    media: []
  };
  return {
    store,
    async loadArchive() {
      return { schemaVersion: 1, messages: [...store.archive.messages] };
    },
    async saveArchive(archive) {
      store.archive = { schemaVersion: 1, messages: [...archive.messages] };
    },
    async updateMessage(input) {
      const result = updateCaptureMessage(
        { schemaVersion: 1, messages: [...store.archive.messages] },
        input.messageId,
        { text: input.text, mediaIds: input.mediaIds },
        input.expectedUpdatedAt
      );
      if (result.status === "updated") {
        store.archive = { schemaVersion: 1, messages: [...result.archive.messages] };
      }
      return result;
    },
    async loadMedia() {
      return [...store.media];
    },
    async loadMediaBlob(mediaId) {
      return store.media.find((item) => item.id === mediaId)?.blob;
    },
    async saveMedia(media) {
      const byId = new Map(store.media.map((item) => [item.id, item] as const));
      media.forEach((item) => byId.set(item.id, item));
      store.media = [...byId.values()];
    },
    async clear() {
      store.archive = { ...EMPTY_CAPTURE_ARCHIVE };
      store.media = [];
    }
  };
}

export { CAPTURE_STORE };
