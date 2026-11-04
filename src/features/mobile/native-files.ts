import { MediaContentConflictError } from "@/features/notebook/notebook-repository";
import { ACTOR_WHERE, actorValues, type NativeActor, type NativeDatabase } from "./native-database";
import { detectGlobalBridge, digestBytes, randomToken } from "./native-host";

export const NATIVE_FILE_ROOT = "xingji-mobile-v1/";
export const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;
export type NativeFileInfo = { path: string; size: number; modifiedAt: number };
export type PromotedFile = { path: string; size: number; sha256: string };
export interface NativeFilePort {
  writeTemporary(path: string, bytes: Uint8Array): Promise<void>;
  read(path: string): Promise<Uint8Array>;
  stat(path: string): Promise<NativeFileInfo | null>;
  list(prefix: string): Promise<NativeFileInfo[]>;
  remove(path: string): Promise<void>;
  promoteFileExclusive(input: { temporaryPath: string; finalPath: string; expectedSize: number; expectedSha256: string }): Promise<PromotedFile>;
}
export type PreparedNativeFile = Readonly<{
  actor: NativeActor; operationId: string | null; mediaId: string; path: string;
  sha256: string; size: number; type: string; createdAt: number;
}>;
export class NativeOriginalMissingError extends Error {
  constructor(readonly mediaId: string) { super(`NATIVE_ORIGINAL_MISSING:${mediaId}`); this.name = "NativeOriginalMissingError"; }
}

export function assertNativeFilePath(path: string): void {
  if (!path.startsWith(NATIVE_FILE_ROOT) || path.length > 600 || !/^xingji-mobile-v1\/[a-f0-9]{64}\/[a-f0-9]{32}\/([a-f0-9]{32}\.staging|[a-f0-9]{64}\.original)$/.test(path)) {
    throw new Error("NATIVE_FILE_PATH_INVALID");
  }
}
function assertDigest(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("NATIVE_DIGEST_INVALID");
}
/** File signatures keep a mislabeled payload out of the original-media store. HEIC stays unsupported. */
export function validateNativeMedia(bytes: Uint8Array, type: string): void {
  const starts = (...signature: number[]) => signature.every((b, i) => bytes[i] === b);
  const ascii = (start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length));
  const valid = type === "image/png" ? starts(137, 80, 78, 71, 13, 10, 26, 10)
    : type === "image/jpeg" ? starts(255, 216, 255)
    : type === "image/gif" ? ["GIF87a", "GIF89a"].includes(ascii(0, 6))
    : type === "image/webp" ? ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP"
    : type === "image/avif" ? ascii(4, 4) === "ftyp" && ["avif", "avis"].includes(ascii(8, 4))
    : false;
  if (!valid) throw new Error("NATIVE_MEDIA_TYPE_MISMATCH");
}

export class NativeFiles {
  private readonly activeOperations = new Set<string>();
  private readonly objectUrls = new Map<string, string>();
  constructor(
    readonly database: NativeDatabase,
    readonly port: NativeFilePort,
    private readonly digest: (bytes: Uint8Array) => Promise<string> = (bytes) => digestBytes(bytes, detectGlobalBridge()),
    private readonly random: () => Promise<string> = () => randomToken(16, detectGlobalBridge()),
    private readonly now: () => number = Date.now
  ) {}
  async namespace(actor: NativeActor): Promise<string> {
    actorValues(actor);
    const digest = await this.digest(new TextEncoder().encode(JSON.stringify([actor.serverId, actor.userId, actor.datasetId])));
    assertDigest(digest);
    return `${NATIVE_FILE_ROOT}${digest}/`;
  }

  /**
   * G1：统一暂存命名契约——普通写入与恢复暂存同名规则：`<32位十六进制>.staging`
   * （mediaId 的稳定摘要前 32 位）。公共路径校验、端口 writeTemporary 规则与
   * 原生发布端 controlledFile 对同一形状放行；同一 operationId 下不同 mediaId
   * 不互相覆盖，同 mediaId 重试可安全覆盖（stageForRestore 先清残留）。
   */
  private async stagingNameFor(mediaId: string): Promise<string> {
    const idDigest = await this.digest(new TextEncoder().encode(`staging:${mediaId}`));
    assertDigest(idDigest);
    return `${idDigest.slice(0, 32)}.staging`;
  }
  async prepare(actorInput: NativeActor, media: { id: string; type: string; size: number; blob: Blob }): Promise<PreparedNativeFile> {
    const actor = Object.freeze({ ...actorInput });
    actorValues(actor);
    if (!media.id || media.id.length > 200 || media.size !== media.blob.size || media.type !== media.blob.type || media.size > 50_000_000 || media.size <= 0) throw new Error("NATIVE_MEDIA_INVALID");
    const bytes = new Uint8Array(await media.blob.arrayBuffer());
    validateNativeMedia(bytes, media.type);
    const sha256 = await this.digest(bytes);
    assertDigest(sha256);
    const createdAt = this.now();
    const existing = await this.database.transaction(async (db) => {
      await db.assertActor(actor);
      return (await db.query(`SELECT path,sha256,size,type,created_at FROM mobile_media WHERE ${ACTOR_WHERE} AND media_id=?`, [...actorValues(actor), media.id]))[0];
    });
    if (existing) {
      if (existing.sha256 !== sha256 || existing.size !== media.size) throw new MediaContentConflictError(media.id);
      const path = String(existing.path);
      await this.readVerified(path, media.id, sha256, media.size);
      return Object.freeze({ actor, operationId: null, mediaId: media.id, path, sha256, size: media.size, type: media.type, createdAt: Number(existing.created_at) });
    }
    const operationId = await this.random();
    if (!/^[a-f0-9]{32}$/.test(operationId)) throw new Error("NATIVE_OPERATION_ID_INVALID");
    const prefix = `${await this.namespace(actor)}${operationId}/`;
    const temporaryPath = `${prefix}${await this.stagingNameFor(media.id)}`;
    const path = `${prefix}${sha256}.original`;
    this.activeOperations.add(path);
    try {
      // Persist intent before any file write. Failure after this point is recoverable as an inflight operation.
      await this.database.transaction(async (db) => {
        await db.assertActor(actor);
        await db.run("INSERT INTO mobile_inflight(server_id,user_id,dataset_id,operation_id,media_id,temporary_path,final_path,sha256,size,type,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)", [...actorValues(actor), operationId, media.id, temporaryPath, path, sha256, media.size, media.type, createdAt]);
      });
      await this.port.writeTemporary(temporaryPath, bytes);
      const staged = await this.port.read(temporaryPath);
      validateNativeMedia(staged, media.type);
      if (staged.length !== media.size || await this.digest(staged) !== sha256) throw new Error("NATIVE_STAGING_DIGEST_MISMATCH");
      const promoted = await this.port.promoteFileExclusive({ temporaryPath, finalPath: path, expectedSize: media.size, expectedSha256: sha256 });
      if (promoted.path !== path || promoted.sha256 !== sha256 || promoted.size !== media.size) throw new Error("NATIVE_PROMOTION_RESULT_INVALID");
      return Object.freeze({ actor, operationId, mediaId: media.id, path, sha256, size: media.size, type: media.type, createdAt });
    } catch (error) {
      this.activeOperations.delete(path);
      throw error;
    }
  }
  /** Call after the combined SQL operation settles; unresolved prepared files remain protected in this process. */
  releasePrepared(prepared: readonly PreparedNativeFile[]): void {
    for (const file of prepared) if (file.operationId) this.activeOperations.delete(file.path);
  }
  /** Must be called inside the same database transaction as its business records and receipt. */
  async commitPrepared(db: NativeDatabase, actor: NativeActor, prepared: readonly PreparedNativeFile[]): Promise<void> {
    await db.assertActor(actor);
    for (const file of prepared) {
      assertNativeFilePath(file.path);
      if (JSON.stringify(actorValues(file.actor)) !== JSON.stringify(actorValues(actor))) throw new Error("NATIVE_FILE_OWNER_MISMATCH");
      const current = (await db.query(`SELECT path,sha256,size FROM mobile_media WHERE ${ACTOR_WHERE} AND media_id=?`, [...actorValues(actor), file.mediaId]))[0];
      if (current && (current.sha256 !== file.sha256 || current.size !== file.size)) throw new MediaContentConflictError(file.mediaId);
      if (file.operationId) {
        const intent = (await db.query(`SELECT final_path,sha256,size,media_id,type FROM mobile_inflight WHERE ${ACTOR_WHERE} AND operation_id=?`, [...actorValues(actor), file.operationId]))[0];
        if (!intent || intent.final_path !== file.path || intent.sha256 !== file.sha256 || intent.size !== file.size || intent.media_id !== file.mediaId || intent.type !== file.type) throw new Error("NATIVE_PREPARED_FILE_INVALID");
      } else if (!current || current.path !== file.path) throw new Error("NATIVE_PREPARED_FILE_INVALID");
      // Stat is bounded and local; missing originals never produce a committed business reference.
      const info = await this.port.stat(file.path);
      if (!info || info.size !== file.size) throw new NativeOriginalMissingError(file.mediaId);
      if (!current) await db.run("INSERT INTO mobile_media(server_id,user_id,dataset_id,media_id,path,sha256,size,type,created_at) VALUES(?,?,?,?,?,?,?,?,?)", [...actorValues(actor), file.mediaId, file.path, file.sha256, file.size, file.type, file.createdAt]);
      if (file.operationId) await db.run(`DELETE FROM mobile_inflight WHERE ${ACTOR_WHERE} AND operation_id=?`, [...actorValues(actor), file.operationId]);
    }
  }
  async readVerified(path: string, mediaId: string, sha256: string, size: number): Promise<Uint8Array> {
    assertNativeFilePath(path);
    const info = await this.port.stat(path);
    if (!info) throw new NativeOriginalMissingError(mediaId);
    const bytes = await this.port.read(path);
    if (info.size !== size || bytes.length !== size || await this.digest(bytes) !== sha256) throw new Error(`NATIVE_ORIGINAL_CORRUPT:${mediaId}`);
    return bytes;
  }
  /**
   * R1/P1-1 恢复专用：暂存不查账号指针（目标空、指针在最终事务才切）；返回
   * 暂存路径+核对值，promoteStaged 在最终事务与业务/指针共同提交。
   */
  async stageForRestore(actorInput: NativeActor, media: { id: string; type: string; size: number; blob: Blob }): Promise<{ actor: NativeActor; mediaId: string; type: string; sha256: string; size: number; stagedPath: string; finalPath: string }> {
    const actor = Object.freeze({ ...actorInput });
    actorValues(actor);
    if (!media.id || media.size !== media.blob.size || media.type !== media.blob.type || media.size <= 0) throw new Error("NATIVE_MEDIA_INVALID");
    const bytes = new Uint8Array(await media.blob.arrayBuffer());
    validateNativeMedia(bytes, media.type);
    const sha256 = await this.digest(bytes);
    assertDigest(sha256);
    const operationId = await this.random();
    if (!/^[a-f0-9]{32}$/.test(operationId)) throw new Error("NATIVE_OPERATION_ID_INVALID");
    const prefix = `${await this.namespace(actor)}${operationId}/`;
    // 暂存名走统一契约（hex.staging）；同包重试前清掉本前缀下的残留暂存
    // （目标库为空、指针未切，覆盖自己的残留不影响任何已发布原件）。
    const stagedPath = `${prefix}${await this.stagingNameFor(media.id)}`;
    const finalPath = `${prefix}${sha256}.original`;
    await this.port.remove(stagedPath).catch(() => undefined);
    await this.port.writeTemporary(stagedPath, bytes);
    return { actor, mediaId: media.id, type: media.type, sha256, size: media.size, stagedPath, finalPath };
  }

  /** R1/P1-1：最终事务内执行——promote 暂存并写媒体行（与业务/指针同一 COMMIT）。 */
  async commitStagedForRestore(db: NativeDatabase, staged: readonly Awaited<ReturnType<NativeFiles["stageForRestore"]>>[]): Promise<void> {
    for (const item of staged) {
      const promoted = await this.port.promoteFileExclusive({ temporaryPath: item.stagedPath, finalPath: item.finalPath, expectedSha256: item.sha256, expectedSize: item.size });
      if (promoted.sha256 !== item.sha256 || promoted.size !== item.size) throw new Error("NATIVE_PROMOTION_RESULT_INVALID");
      await db.run("INSERT OR IGNORE INTO mobile_media(server_id,user_id,dataset_id,media_id,path,sha256,size,type,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
        [...actorValues(item.actor), item.mediaId, item.finalPath, item.sha256, item.size, item.type, this.now()]);
    }
  }

  /** R1/P1-1：失败时释放暂存（不触碰任何最终原件）。 */
  discardStagedForRestore(staged: readonly Awaited<ReturnType<NativeFiles["stageForRestore"]>>[]): Promise<void[]> {
    return Promise.all(staged.map(item => this.port.remove(item.stagedPath).catch(() => undefined)));
  }

  async read(actor: NativeActor, mediaId: string): Promise<Blob | undefined> {
    const record = await this.database.transaction(async (db) => {
      await db.assertActor(actor);
      return (await db.query(`SELECT path,sha256,size,type FROM mobile_media WHERE ${ACTOR_WHERE} AND media_id=?`, [...actorValues(actor), mediaId]))[0];
    });
    if (!record) return undefined;
    const bytes = await this.readVerified(String(record.path), mediaId, String(record.sha256), Number(record.size));
    return new Blob([bytes.slice().buffer as ArrayBuffer], { type: String(record.type) });
  }
  async objectUrl(actor: NativeActor, mediaId: string): Promise<{ url: string; release: () => void }> {
    if (this.objectUrls.size >= 8) throw new Error("NATIVE_OBJECT_URL_LIMIT");
    const blob = await this.read(actor, mediaId);
    if (!blob) throw new NativeOriginalMissingError(mediaId);
    if (this.objectUrls.size >= 8) throw new Error("NATIVE_OBJECT_URL_LIMIT");
    const url = URL.createObjectURL(blob);
    this.objectUrls.set(url, JSON.stringify(actorValues(actor)));
    return { url, release: () => { URL.revokeObjectURL(url); this.objectUrls.delete(url); } };
  }
  releaseObjectUrls(actor: NativeActor): void {
    const key = JSON.stringify(actorValues(actor));
    for (const [url, owner] of this.objectUrls) if (owner === key) { URL.revokeObjectURL(url); this.objectUrls.delete(url); }
  }
  /**
   * F7：显式清空后的命名空间清理——该数据集的全部 SQL 引用已在轮换事务中删除，
   * 剩余文件均为不可达原件，无宽限期直接清除（与普通孤儿保留策略区分）。
   * 失败抛出，由调用方保留清理记录供重开恢复。
   */
  async sweepNamespace(namespace: string): Promise<number> {
    if (!/^xingji-mobile-v1\/[a-f0-9]{64}\/$/.test(namespace)) throw new Error("NATIVE_FILE_PATH_INVALID");
    const files = await this.port.list(namespace);
    let removed = 0;
    for (const file of files) {
      assertNativeFilePath(file.path);
      if (!file.path.startsWith(namespace)) throw new Error("NATIVE_FILE_OWNER_MISMATCH");
      await this.port.remove(file.path);
      removed += 1;
    }
    return removed;
  }

  /** Only this captured actor's paths, after 24h and while holding the SQL queue against new references. */
  async sweepOrphans(actor: NativeActor): Promise<number> {
    const prefix = await this.namespace(actor);
    const candidates = await this.port.list(prefix);
    return this.database.transaction(async (db) => {
      const media = await db.query(`SELECT path FROM mobile_media WHERE ${ACTOR_WHERE}`, actorValues(actor));
      const inflight = await db.query(`SELECT operation_id,temporary_path,final_path,created_at FROM mobile_inflight WHERE ${ACTOR_WHERE}`, actorValues(actor));
      const protectedPaths = new Set(media.map((row) => String(row.path)));
      for (const row of inflight) {
        const age = this.now() - Number(row.created_at);
        if (this.activeOperations.has(String(row.final_path)) || !Number.isFinite(age) || age < ORPHAN_GRACE_MS) {
          protectedPaths.add(String(row.temporary_path)); protectedPaths.add(String(row.final_path));
        }
      }
      let removed = 0;
      for (const file of candidates) {
        assertNativeFilePath(file.path);
        if (!file.path.startsWith(prefix)) throw new Error("NATIVE_FILE_OWNER_MISMATCH");
        const age = this.now() - file.modifiedAt;
        if (protectedPaths.has(file.path) || !Number.isFinite(age) || age < ORPHAN_GRACE_MS) continue;
        await this.port.remove(file.path); removed += 1;
      }
      for (const row of inflight) {
        const age = this.now() - Number(row.created_at);
        if (!this.activeOperations.has(String(row.final_path)) && Number.isFinite(age) && age >= ORPHAN_GRACE_MS) {
          await db.run(`DELETE FROM mobile_inflight WHERE ${ACTOR_WHERE} AND operation_id=?`, [...actorValues(actor), String(row.operation_id)]);
        }
      }
      return removed;
    });
  }
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}
export async function createNativeFilePort(): Promise<NativeFilePort> {
  const { Capacitor } = await import("@capacitor/core");
  if (!Capacitor.isNativePlatform()) throw new Error("NATIVE_FILES_REQUIRED");
  const { Filesystem, Directory } = await import("@capacitor/filesystem");
  const raw = (globalThis as { Capacitor?: { Plugins?: { XingjiHost?: { promoteFileExclusive?: (input: unknown) => Promise<PromotedFile> } } } }).Capacitor?.Plugins?.XingjiHost;
  if (typeof raw?.promoteFileExclusive !== "function") throw new Error("NATIVE_EXCLUSIVE_FILE_BRIDGE_REQUIRED");
  const stat = async (path: string): Promise<NativeFileInfo | null> => {
    assertNativeFilePath(path);
    try {
      const info = await Filesystem.stat({ directory: Directory.Data, path });
      if (info.type !== "file") throw new Error("NATIVE_FILE_NOT_REGULAR");
      return { path, size: info.size, modifiedAt: info.mtime };
    } catch (error) {
      if (["OS-PLUG-FILE-0008", "NOT_FOUND"].includes(String((error as { code?: string }).code))) return null;
      throw error;
    }
  };
  return {
    async writeTemporary(path, bytes) {
      assertNativeFilePath(path);
      if (!/\/[a-f0-9]{32}\.staging$/.test(path)) throw new Error("NATIVE_TEMPORARY_PATH_INVALID");
      if (await stat(path)) throw new Error("NATIVE_TEMPORARY_EXISTS");
      await Filesystem.writeFile({ directory: Directory.Data, path, data: base64(bytes), recursive: true });
    },
    async read(path) {
      assertNativeFilePath(path);
      const { data } = await Filesystem.readFile({ directory: Directory.Data, path });
      if (typeof data !== "string") return new Uint8Array(await data.arrayBuffer());
      return Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
    },
    stat,
    async list(prefix) {
      if (!/^xingji-mobile-v1\/[a-f0-9]{64}\/$/.test(prefix)) throw new Error("NATIVE_FILE_PATH_INVALID");
      const files: NativeFileInfo[] = [];
      const visit = async (path: string) => {
        let entries;
        try { entries = (await Filesystem.readdir({ directory: Directory.Data, path })).files; }
        catch (error) {
          if (["OS-PLUG-FILE-0008", "NOT_FOUND"].includes(String((error as { code?: string }).code))) return;
          throw error;
        }
        for (const entry of entries) {
          const child = `${path.replace(/\/$/, "")}/${entry.name}`;
          if (entry.type === "directory" && /^[a-f0-9]{32}$/.test(entry.name) && path === prefix) await visit(child);
          else if (entry.type === "file") { assertNativeFilePath(child); files.push({ path: child, size: entry.size, modifiedAt: entry.mtime }); }
          else throw new Error("NATIVE_FILE_DIRECTORY_UNEXPECTED");
        }
      };
      await visit(prefix);
      return files;
    },
    async remove(path) { assertNativeFilePath(path); await Filesystem.deleteFile({ directory: Directory.Data, path }); },
    async promoteFileExclusive(input) { assertNativeFilePath(input.temporaryPath); assertNativeFilePath(input.finalPath); return raw.promoteFileExclusive!(input); }
  };
}
