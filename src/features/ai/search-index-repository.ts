import { CHUNK_VERSION, SEARCH_LIMITS, validateVectors, type SearchChunk } from "./search-chunks";
export type SearchIndexPage = {
  pageId: string;
  sourceDigest: string;
  space: string;
  chunkVersion: number;
  chunks: SearchChunk[];
  vectors: number[][];
};
export const SEARCH_DB_NAME = "xingji-search";
const epochKey = "\u0000epoch";
type Epoch = { pageId: typeof epochKey; value: number };
function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("索引事务已取消。"));
    tx.onerror = () => reject(tx.error);
  });
}
export function validateIndexPage(row: SearchIndexPage) {
  if (
    !row ||
    typeof row.pageId !== "string" ||
    !row.pageId ||
    row.pageId.startsWith("\u0000") ||
    typeof row.sourceDigest !== "string" ||
    !row.sourceDigest ||
    typeof row.space !== "string" ||
    !row.space ||
    row.chunkVersion !== CHUNK_VERSION ||
    !Array.isArray(row.chunks) ||
    !row.chunks.length ||
    row.chunks.length > SEARCH_LIMITS.chunksPerPage
  )
    throw new Error("索引记录无效。");
  let chars = 0;
  for (const c of row.chunks) {
    if (
      !c ||
      !(c.blockId === null || typeof c.blockId === "string") ||
      !Number.isInteger(c.start) ||
      c.start < 0 ||
      !Number.isInteger(c.end) ||
      c.end <= c.start ||
      typeof c.text !== "string" ||
      c.text.length !== c.end - c.start ||
      c.text.length > SEARCH_LIMITS.chunkChars
    )
      throw new Error("索引分块无效。");
    chars += c.text.length;
  }
  if (chars > SEARCH_LIMITS.inputChars) throw new Error("索引输入超限。");
  validateVectors(row.vectors, row.chunks.length);
}
/** A generation lives in the same store/transaction as page records: clearing invalidates in-flight writers, including other tabs. */
export function createSearchIndexRepository(factory?: IDBFactory) {
  let database: Promise<IDBDatabase> | undefined;
  function open() {
    return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = (factory ?? globalThis.indexedDB).open(SEARCH_DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore("pages", { keyPath: "pageId" });
      req.onerror = () => {
        database = undefined;
        reject(req.error);
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          db.close();
          database = undefined;
        };
        resolve(db);
      };
    }));
  }
  async function transact<T>(
    mode: IDBTransactionMode,
    fn: (s: IDBObjectStore) => Promise<T>
  ): Promise<T> {
    const db = await open(),
      tx = db.transaction("pages", mode),
      completed = done(tx);
    // Install completion listeners before any request; handle abort rejection on every branch.
    void completed.catch(() => {});
    try {
      const result = await fn(tx.objectStore("pages"));
      await completed;
      return result;
    } catch (e) {
      try {
        tx.abort();
      } catch {}
      await completed.catch(() => {});
      throw e;
    }
  }
  return {
    async snapshot() {
      return transact("readonly", async (s) => {
        const rows = (await request(s.getAll())) as (SearchIndexPage | Epoch)[];
        const epoch = rows.find((r) => r.pageId === epochKey) as Epoch | undefined;
        const pages = rows.filter((r) => r.pageId !== epochKey) as SearchIndexPage[];
        pages.forEach(validateIndexPage);
        return { epoch: epoch?.value ?? 0, pages };
      });
    },
    async put(row: SearchIndexPage, expectedEpoch: number, signal?: AbortSignal) {
      validateIndexPage(row);
      return transact("readwrite", async (s) => {
        const rows = (await request(s.getAll())) as (SearchIndexPage | Epoch)[];
        const epoch = (rows.find((r) => r.pageId === epochKey) as Epoch | undefined)?.value ?? 0;
        if (signal?.aborted || epoch !== expectedEpoch)
          throw new Error("索引已清除或操作已取消，请重新建立。");
        const next = [...rows.filter((r) => r.pageId !== row.pageId && r.pageId !== epochKey), row];
        if (
          next.length > SEARCH_LIMITS.pages ||
          new TextEncoder().encode(JSON.stringify(next)).length > SEARCH_LIMITS.indexBytes
        )
          throw new Error("索引容量已满，请明确清除后重建。");
        await request(s.put(row));
      });
    },
    async clear() {
      return transact("readwrite", async (s) => {
        const old = (await request(s.get(epochKey))) as Epoch | undefined;
        await request(s.clear());
        await request(s.put({ pageId: epochKey, value: (old?.value ?? 0) + 1 }));
      });
    },
    async close() {
      if (database) (await database).close();
      database = undefined;
    }
  };
}
export type SearchIndexRepository = ReturnType<typeof createSearchIndexRepository>;
