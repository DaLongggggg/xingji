/**
 * T10 备份核心（三轮返修 B1/B2/B3 + 前轮已确认修复的保持）。
 *
 * 导出（B2）：同一事务快照并在事务内**逐件**读取-核对原件；zip 成员逐件流式写入
 *（fflate Zip 逐件回调），不整批驻留后同步压缩。
 * 恢复（B1/B2/B3）：
 * - 流式有界解压：**分块 push** 输入；每成员启动前按 zip 声明（originalSize）核验
 *   条目数与声明总量预算；输出数据到达时累计实际解压量并即时终止（未请求成员只
 *   计数不物化）；收齐目标成员后**继续校验整包**（成员数/路径/重复/未声明/截断），
 *   不因提前收齐而忽略后续失败。
 * - 领域/引用完整性（B1）：按真实存储结构解析 message 行（`{chatSessionId,message}`
 *   外层），校验 `message.attachments` fileRef 归属/摘要形状；随记 archive 的
 *   schemaVersion/messages/mediaIds、笔记本版本白名单、links、收据↔session 写入前
 *   全部闭环；非法包在业务写入前拒绝且 dataset 不变。
 * - 指针只在最终事务共同提交（保持 adc16d1）。
 * 测试预算可注入（limits 参数）用于小样本断言。
 */
import { strFromU8, strToU8, Unzip, UnzipInflate, Zip, ZipDeflate, type FlateError } from "fflate";
import { isCaptureMessage } from "@/features/capture/capture-model";
import { assertSupportedArchiveVersion } from "@/features/notebook/notebook-repository";
import type { NativeActor, NativeDatabase } from "./native-database";
import type { NativeFiles, PreparedNativeFile } from "./native-files";

export const NATIVE_BACKUP_FORMAT = "xingji-mobile-backup";
export const NATIVE_BACKUP_VERSION = 1;
export const NATIVE_BACKUP_LIMITS = { entries: 5000, archiveBytes: 512 * 1024 * 1024, decompressedBytes: 768 * 1024 * 1024 } as const;

/** B2：可注入限额（测试用小预算证明截停，不跑失控 OOM）。 */
export type BackupLimits = typeof NATIVE_BACKUP_LIMITS;

export type NativeBackupManifest = {
  format: typeof NATIVE_BACKUP_FORMAT;
  version: typeof NATIVE_BACKUP_VERSION;
  serverId: string;
  userId: string;
  datasetId: string;
  createdAt: string;
  archives: Array<{ kind: "notebook" | "capture"; revision: number; json: string }>;
  records: Array<{ kind: string; record_id: string; json: string }>;
  inbox: Array<{ task_id: string; digest: string; chat_session_id: string; applied_at: string; acked_at: string | null }>;
  media: Array<{ mediaId: string; path: string; zipName: string; sha256: string; size: number; type: string; created_at: number; links: Array<{ kind: string; json: string }> }>;
};

export class NativeBackupError extends Error {
  /** H1：拒绝时已实际解压/物化的字节数（回归断言输出边界，而非仅错误码）。 */
  readonly observedBytes?: number;
  constructor(readonly code: string, observedBytes?: number) { super(code); this.name = "NativeBackupError"; this.observedBytes = observedBytes; }
}

function zipSafeName(path: string): string {
  if (!/^xingji-mobile-v1\/[a-f0-9]{64}\/[a-f0-9]{32}\/[a-f0-9]{64}\.original$/.test(path)) throw new NativeBackupError("BACKUP_PATH_INVALID");
  return path.replace(/\//g, "__");
}
function zipNameToPath(name: string): string {
  const path = name.replace(/__/g, "/");
  zipSafeName(path);
  return path;
}

function safeParse(value: string): unknown {
  if (value === "undefined" || value === "null" || value === "") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed === null || parsed === undefined ? null : parsed;
  } catch { return null; }
}

/** B1/G4b：按真实存储结构校验 message 行（native-workbench-store 写入 `{chatSessionId,message}`）。
 * fileRef 的一致性升级：账号（server/user/dataset）与 manifest 账号一致，摘要/大小/类型
 * 与对应媒体行完全一致（不只是形状）——被消费者读取的引用位置即 message.attachments。 */
function validateMessageRow(
  json: string,
  ctx: { manifest: NativeBackupManifest; mediaById: Map<string, { sha256: string; size: number; type: string }> }
): { ok: true } | { ok: false; code: string } {
  const row = safeParse(json) as { chatSessionId?: unknown; message?: unknown } | null;
  const sessionIds = new Set(ctx.manifest.records.filter(item => item.kind === "session").map(item => item.record_id));
  if (!row || typeof row.chatSessionId !== "string" || !sessionIds.has(row.chatSessionId)) return { ok: false, code: "BACKUP_REFERENCE_BROKEN" };
  const message = row.message as { role?: unknown; id?: unknown; attachments?: unknown } | null | undefined;
  if (!message || typeof message !== "object" || typeof message.id !== "string" || (message.role !== "user" && message.role !== "assistant")) {
    return { ok: false, code: "BACKUP_CONTENT_INVALID" };
  }
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  for (const attachment of attachments as { fileRef?: { serverId?: unknown; userId?: unknown; datasetId?: unknown; mediaId?: unknown; sha256?: unknown; size?: unknown; type?: unknown } }[]) {
    const ref = attachment?.fileRef;
    if (!ref || typeof ref.mediaId !== "string" || !ctx.mediaById.has(ref.mediaId)) return { ok: false, code: "BACKUP_REFERENCE_BROKEN" };
    if (
      ref.serverId !== ctx.manifest.serverId || ref.userId !== ctx.manifest.userId || ref.datasetId !== ctx.manifest.datasetId ||
      typeof ref.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(ref.sha256) || typeof ref.size !== "number" || !Number.isSafeInteger(ref.size) || ref.size < 0 || typeof ref.type !== "string"
    ) {
      return { ok: false, code: "BACKUP_CONTENT_INVALID" };
    }
    const media = ctx.mediaById.get(ref.mediaId)!;
    if (ref.sha256 !== media.sha256 || ref.size !== media.size || ref.type !== media.type) return { ok: false, code: "BACKUP_CONTENT_INVALID" };
  }
  return { ok: true };
}

/** B1/G2/G4：领域与引用闭环——真实存储结构（capture 消息走现有领域校验、
 * 笔记本版本复用现有兼容规则、message 外层、links、收据）。 */
function validateDomain(manifest: NativeBackupManifest): { ok: true } | { ok: false; code: string } {
  const mediaIds = new Set(manifest.media.map(item => item.mediaId));
  const mediaById = new Map(manifest.media.map(item => [item.mediaId, { sha256: item.sha256, size: item.size, type: item.type }]));
  const sessionIds = new Set<string>();
  for (const row of manifest.records) if (row.kind === "session") sessionIds.add(row.record_id);
  const seenRecords = new Set<string>();
  for (const row of manifest.records) {
    if (!row.kind || !row.record_id || seenRecords.has(`${row.kind}/${row.record_id}`)) return { ok: false, code: "BACKUP_CONTENT_INVALID" };
    seenRecords.add(`${row.kind}/${row.record_id}`);
    if (row.kind === "message") {
      const check = validateMessageRow(row.json, { manifest, mediaById });
      if (!check.ok) return check;
    }
  }
  for (const receipt of manifest.inbox) {
    if (!sessionIds.has(receipt.chat_session_id)) return { ok: false, code: "BACKUP_REFERENCE_BROKEN" };
  }
  for (const media of manifest.media) {
    if (media.zipName !== zipSafeName(media.path)) return { ok: false, code: "BACKUP_PATH_INVALID" };
    for (const link of media.links) {
      if (link.kind.startsWith("session:") && !sessionIds.has(link.kind.slice("session:".length))) return { ok: false, code: "BACKUP_REFERENCE_BROKEN" };
    }
  }
  for (const archive of manifest.archives) {
    const parsed = safeParse(archive.json) as { schemaVersion?: unknown; messages?: unknown } | null;
    if (!parsed) return { ok: false, code: "BACKUP_CONTENT_INVALID" };
    if (archive.kind === "capture") {
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.messages)) return { ok: false, code: "BACKUP_CONTENT_INVALID" };
      // G4：损坏的随记消息走现有领域校验（isCaptureMessage——真实仓储写入/读取的同一规则）。
      for (const message of parsed.messages) {
        if (!isCaptureMessage(message)) return { ok: false, code: "BACKUP_CONTENT_INVALID" };
        for (const mediaId of message.mediaIds) {
          if (!mediaIds.has(mediaId)) return { ok: false, code: "BACKUP_REFERENCE_BROKEN" };
        }
      }
    } else if (archive.kind === "notebook") {
      // G2：复用现有版本兼容规则（assertSupportedArchiveVersion：1/2/当前 3 可恢复，
      // undefined 视为 1，未知/未来版本明确拒绝——与真实仓储读取同一关口）。
      try { assertSupportedArchiveVersion(parsed); }
      catch { return { ok: false, code: "BACKUP_CONTENT_INVALID" }; }
    }
  }
  return { ok: true };
}

/**
 * 导出（B2）：事务内快照+逐件读取核对；ZIP 成员逐件流式压缩（不整批驻留）。
 */
export async function createNativeBackup(
  database: NativeDatabase,
  files: NativeFiles,
  actor: NativeActor,
  deps: { digest(bytes: Uint8Array): Promise<string>; now?(): Date }
): Promise<Uint8Array> {
  const values = [actor.serverId, actor.userId, actor.datasetId];
  const where = "server_id=? AND user_id=? AND dataset_id=?";
  const manifest: NativeBackupManifest = {
    format: NATIVE_BACKUP_FORMAT, version: NATIVE_BACKUP_VERSION,
    serverId: actor.serverId, userId: actor.userId, datasetId: actor.datasetId,
    createdAt: (deps.now ?? (() => new Date()))().toISOString(),
    archives: [], records: [], inbox: [], media: []
  };
  let totalDecompressed = 0;
  await database.transaction(async db => {
    await db.assertActor(actor);   // 保持：stale actor 拒绝（P1-2）
    const archives = await db.query(`SELECT kind,revision,json FROM mobile_archives WHERE ${where}`, values);
    const records = await db.query(`SELECT kind,record_id,json FROM mobile_records WHERE ${where}`, values);
    const inbox = await db.query(`SELECT task_id,digest,chat_session_id,applied_at,acked_at FROM tasks_inbox WHERE ${where}`, values);
    const media = await db.query(`SELECT media_id,path,sha256,size,type,created_at FROM mobile_media WHERE ${where}`, values);
    const links = await db.query(`SELECT media_id,kind,json FROM mobile_media_links WHERE ${where}`, values);
    manifest.archives = archives.map(row => ({ kind: String(row.kind) as "notebook" | "capture", revision: Number(row.revision), json: String(row.json) }));
    manifest.records = records.map(row => ({ kind: String(row.kind), record_id: String(row.record_id), json: String(row.json) }));
    manifest.inbox = inbox.map(row => ({ task_id: String(row.task_id), digest: String(row.digest), chat_session_id: String(row.chat_session_id), applied_at: String(row.applied_at), acked_at: row.acked_at === null ? null : String(row.acked_at) }));
    const linksByMedia = new Map<string, Array<{ kind: string; json: string }>>();
    for (const link of links) {
      const id = String(link.media_id);
      const list = linksByMedia.get(id) ?? [];
      list.push({ kind: String(link.kind), json: String(link.json) });
      linksByMedia.set(id, list);
    }
    const entries = manifest.archives.length + manifest.records.length + manifest.inbox.length + media.length;
    if (entries > NATIVE_BACKUP_LIMITS.entries) throw new NativeBackupError("BACKUP_TOO_MANY_ENTRIES");
    for (const row of media) {
      const path = String(row.path);
      const bytes = await files.port.read(path);      // 事务内：引用保护期间逐件读取
      if (bytes.byteLength !== Number(row.size)) throw new NativeBackupError("BACKUP_SIZE_MISMATCH");
      if (await deps.digest(bytes) !== String(row.sha256)) throw new NativeBackupError("BACKUP_DIGEST_MISMATCH");
      totalDecompressed += bytes.byteLength;
      if (totalDecompressed > NATIVE_BACKUP_LIMITS.decompressedBytes) throw new NativeBackupError("BACKUP_DECOMPRESSED_TOO_LARGE");
      const zipName = zipSafeName(path);
      manifest.media.push({
        mediaId: String(row.media_id), path, zipName, sha256: String(row.sha256), size: Number(row.size), type: String(row.type), created_at: Number(row.created_at),
        links: linksByMedia.get(String(row.media_id)) ?? []
      });
    }
  });
  // B2：Zip 流式逐件压缩——每件一个 ZipDeflate（同步 push，数据进入压缩流后原件引用即可
  // 释放）；resolve 挂 Zip 顶层 final（fflate 的 per-file ondata 不携带 final 信号）。
  const archiveBytes = await new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let totalArchive = 0;
    let overflow = false;
    const absorb = (chunkLike: Uint8Array | FlateError | null): boolean => {
      if (chunkLike instanceof Uint8Array) {
        chunks.push(chunkLike);
        totalArchive += chunkLike.byteLength;
        if (totalArchive > NATIVE_BACKUP_LIMITS.archiveBytes) { overflow = true; return false; }
      }
      return true;
    };
    const zip = new Zip((err: FlateError | null, data: Uint8Array | null, final: boolean) => {
      if (err || !absorb(data)) { if (!overflow) overflow = true; return; }
      if (final) {
        if (overflow) reject(new NativeBackupError("BACKUP_TOO_LARGE"));
        else resolve(Buffer.concat(chunks));
      }
    });
    const addFile = (name: string, bytes: Uint8Array): void => {
      const deflate = new ZipDeflate(name, { level: 6 });
      deflate.ondata = (err: FlateError | null, chunk: Uint8Array | null) => {
        if (err || !absorb(chunk)) overflow = true;
      };
      zip.add(deflate);
      // 单件内部也分块喂（有界输入）。
      for (let offset = 0; offset < bytes.byteLength; offset += 256 * 1024) {
        deflate.push(bytes.subarray(offset, Math.min(offset + 256 * 1024, bytes.byteLength)), offset + 256 * 1024 >= bytes.byteLength);
      }
    };
    void (async () => {
      try {
        for (const media of manifest.media) {
          if (overflow) break;
          const bytes = await files.port.read(media.path);   // 逐件重读（导出快照已核对）
          addFile(media.zipName, bytes);
        }
        if (!overflow) addFile("manifest.json", strToU8(JSON.stringify(manifest)));
        zip.end();
      } catch (error) { reject(error instanceof NativeBackupError ? error : new NativeBackupError("BACKUP_TOO_LARGE")); }
    })();
  });
  return archiveBytes;
}

/**
 * B2/B3/G4：流式有界解压与**整包**校验。
 * - 分块 push 输入（有界输入缓冲）；
 * - 成员启动前：条目计数 + zip 声明（originalSize）核验（未请求成员也计数与核验声明）；
 * - G4c：不解码的成员（超限后的成员/宇宙外的未声明成员/未请求成员）只挂空 ondata
 *   而**不 start()**——fflate 对未 start 的成员只跳过字节不驱动 inflate（实验验证：
 *   push 不抛错、ondata 永不触发），拒绝路径不再以「空回调＋start」继续解码；
 * - 数据到达（请求成员）：实际解压累计，超限**立即终止**（failed 后停止喂入剩余输入）；
 * - G4d：universe 严格成员宇宙——第二遍传入 {媒体声明} ∪ {"manifest.json"}，
 *   任何宇宙外成员（未声明/路径外）立即拒绝；重复成员拒绝；截断/缺中央目录由
 *   push 终块抛错转 BACKUP_CORRUPT；流结束才 resolve，任何后续失败都使整体拒绝。
 */
/**
 * J2：DEFLATE 三种块类型与流式边界实测（fflate 0.8.3 Inflate）：
 * - 压缩块：单次 push 内可把已喂输入膨胀成单个大输出块（喂入 ÷ 1032 只是上界）；
 * - **stored（未压缩）块：fflate 积累完整块体后一次输出**，输出尺寸 ≈ 喂入到
 *   完成该块的累计输入量——按块头声明的块长切片喂入，块体完整前的任何喂入
 *   切片都可能促成整块输出；
 * - 跨切片：块边界可以落在任意输入切分点，输出在块完成的那次 push 一次性到来。
 * 因此「输入切片÷1032」对 stored 块不成立。可靠方案：**输出截断解码**——
 * 不把整段解码交给 fflate 的内部缓冲，而是把预算声明为硬边界：ondata 到达的
 * 输出块若使累计越过预算，立即记录失败并停止后续喂入；同时在喂入侧保持
 * ÷1032 切片（压缩块上界），使**越过预算的那一次分配 ≤ 预算 + 单块输出**，
 * 而 fflate 内部的 Inflate 缓冲（p 字段）也只持有未完成块体（≤ 喂入切片）。
 * J2 补充：为彻底约束 stored 块，喂入切片下限调整为 1KiB 且上限取
 * min(÷1032, 4KiB)——任何一次 push 累计喂入 ≤ 4KiB，stored 块即使一次输出
 * 也 ≤ 4KiB + 已完成部分；预算内截停后不再喂入。
 */
const MAX_DEFLATE_RATIO = 1032;
const MAX_FEED_SLICE = 4 * 1024;

/** ZIP CRC-32（IEEE 反射多项式 0xEDB88320），校验用查表实现。 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function zipCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = CRC_TABLE[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readEntryStreamed(
  archive: Uint8Array,
  names: readonly string[],
  options: { limits?: BackupLimits; universe?: readonly string[]; onSeen?: (seenNames: ReadonlySet<string>) => void; onChunk?: (byteLength: number) => void } = {}
): Promise<Map<string, Uint8Array>> {
  const limits = options.limits ?? NATIVE_BACKUP_LIMITS;
  return new Promise((resolve, reject) => {
    const wanted = new Set(names);
    const allowed = options.universe ? new Set([...names, ...options.universe]) : null;
    const out = new Map<string, Uint8Array>();
    const chunksByName = new Map<string, Uint8Array[]>();
    const chunksFor = (name: string): Uint8Array[] => {
      const list = chunksByName.get(name) ?? [];
      chunksByName.set(name, list);
      return list;
    };
    let total = 0;
    let entries = 0;
    let declaredSeen = 0;
    let settled = false;
    let failed: NativeBackupError | null = null;
    const seenNames = new Set<string>();
    const fail = (error: NativeBackupError) => { if (!failed) { failed = error; } };
    const finish = () => {
      if (settled) return;
      settled = true;
      if (failed) { reject(failed); return; }
      // B3：整包校验——目标缺失/截断/重复/未声明成员。
      for (const name of wanted) if (!out.has(name)) { reject(new NativeBackupError("BACKUP_FILE_MISSING")); return; }
      options.onSeen?.(seenNames);
      resolve(out);
    };
    const skipMember = (file: { ondata: unknown }) => {
      // G4c：不解码该成员——挂空 ondata 但不 start()（未 start 的成员只跳过字节）。
      (file as { ondata: NonNullable<typeof file.ondata> }).ondata = (() => undefined) as unknown as NonNullable<typeof file.ondata>;
    };
    const unzip = new Unzip(file => {
      if (failed || file.name.endsWith("/")) { skipMember(file); return; }
      entries += 1;
      if (entries > limits.entries + 1) { fail(new NativeBackupError("BACKUP_TOO_MANY_ENTRIES")); skipMember(file); return; }
      // 成员启动前核验声明（originalSize 可得时）——J3：每个成员的声明量在
      // 本遍流内只计一次；实际解码输出由 collect 侧另行累计，二者不叠加。
      // J3：manifest.json 的声明已在第一遍支付（第二遍预算已扣除其字节），
      // 第二遍不再重复计费。
      const declared = (file as { originalSize?: number }).originalSize;
      if (declared !== undefined && !(allowed?.has(file.name) && !wanted.has(file.name))) {
        declaredSeen += declared;
        if (declaredSeen > limits.decompressedBytes) {
          fail(new NativeBackupError("BACKUP_DECOMPRESSED_TOO_LARGE", declaredSeen)); skipMember(file); return;
        }
      }
      if (seenNames.has(file.name)) { fail(new NativeBackupError("BACKUP_CONTENT_INVALID")); skipMember(file); return; }   // 重复成员
      seenNames.add(file.name);
      // G4d：宇宙外成员（未声明/非法路径）——不解码，立即整体拒绝。
      if (allowed && !allowed.has(file.name)) { fail(new NativeBackupError("BACKUP_CONTENT_INVALID")); skipMember(file); return; }
      if (!wanted.has(file.name)) {
        // 未请求成员：不物化也不解码（G4c）；条目计数与声明核验已做。
        skipMember(file);
        return;
      }
      const collect = (chunkData: Uint8Array | null, final: boolean) => {
        if (failed) return;
        if (chunkData) {
          total += chunkData.byteLength;
          // K2：单块分配观测（stored 块一次输出的上界断言用）。
          options.onChunk?.(chunkData.byteLength);
          if (total > limits.decompressedBytes) { fail(new NativeBackupError("BACKUP_DECOMPRESSED_TOO_LARGE", total)); return; }
          chunksFor(file.name).push(chunkData);
        }
        if (final) {
          const list = chunksFor(file.name);
          if (list.length) out.set(file.name, Buffer.concat(list));
        }
      };
      file.ondata = ((error: unknown, chunkData: Uint8Array, final: boolean) => {
        if (error) { const err = error as FlateError; void err; fail(new NativeBackupError("BACKUP_CORRUPT")); return; }
        collect(chunkData, final);
      }) as unknown as NonNullable<typeof file.ondata>;
      file.start();
    });
    unzip.register(UnzipInflate);
    /*
     * L1：解压输出的资源上界（三个量分开陈述；来源=fflate 0.8.3 源码 + 隔离实验，2026-10-26）。
     * fflate 流式 Inflate（Inflate.prototype.c）把当次喂入的全部待解输入膨胀进一个
     * 自 32,768 起、按 max(×2, 需要) 倍增的输出缓冲（inflt 的 cbuf，每个解码段另保证
     * +131,072 余量），ondata 发出的就是该缓冲本次的新增切片：
     * 1) 累计实际输出 ≤ 预算 + 65,536 + 一切片——每次喂入按最新剩余量重算切片
     *    （÷1032 + 4KiB 硬切片），剩余耗尽后仅以 1 字节收尾（贴边合法包的收尾
     *    flush 仍可完成），越预算后由 collect 立即终止才完全停喂
     *    （L1/J2/K2 回归在案）。
     * 2) 单次 ondata 输出：Huffman 块 ≤ (切片+1)×1032（切片 ≤ min(4KiB, ⌊剩余/1032⌋)，
     *    默认 768MiB 预算下 ≤ 4,097×1032 ≈ 4.2MiB；实验 feed=4096 单次 262,144 复核）；
     *    stored 块完成时一次 buf.set 输出整块 ≤65,535+5，与切片无关（实验复现 65,535）。
     * 3) 实际内部分配 = 倍增中的输出缓冲（可达当次输出的 ~2×）+ stored 块体在
     *    输入侧 this.p 的跨切片积累（≤65,535）——单次分配因此是上述有界值，
     *    **不是**"≤ 预算"的硬保证；更强的单次分配保证（preallocated out 的同步
     *    解码路径，分配 ≤ 剩余预算+1）已核实可行但属已批准流式实现的重做，
     *    按增量提案登记（见证据账本），本轮不接入。
     */
    try {
      const CHUNK = 256 * 1024;
      for (let offset = 0; offset < archive.byteLength; offset += CHUNK) {
        if (failed) break;
        const end = Math.min(offset + CHUNK, archive.byteLength);
        for (let inner = offset; inner < end;) {
          if (failed) break;
          // L1：每次喂入按**最新**剩余量重算切片——total 在 ondata 中增长后，
          // 旧实现仍用进入本 CHUNK 时的过期剩余量继续喂入（复核反例：单次
          // 261,096、累计 440,407 越过 331,776 上界）。剩余耗尽后仅以 1 字节
          // 喂入（贴边合法包的收尾 flush 仍可完成；任何溢出由 collect 拦截）。
          const remaining = limits.decompressedBytes - total;
          const maxFeed = remaining <= 0
            ? 1
            : Math.max(1, Math.min(MAX_FEED_SLICE, Math.floor(remaining / MAX_DEFLATE_RATIO)));
          const sliceEnd = Math.min(inner + maxFeed, end);
          unzip.push(archive.subarray(inner, sliceEnd), sliceEnd === archive.byteLength);
          inner = sliceEnd;
        }
      }
      if (!failed && archive.byteLength === 0) fail(new NativeBackupError("BACKUP_CORRUPT"));
    } catch { fail(new NativeBackupError("BACKUP_CORRUPT")); }
    const immediate = typeof setImmediate === "function" ? setImmediate : (fn: () => void) => setTimeout(fn, 0);
    immediate(() => finish());
  });
}

export type NativeBackupRestoreOutcome =
  | { status: "restored"; rows: number; files: number; datasetId: string }
  | { status: "rejected"; code: string; observedDecompressedBytes?: number };

/**
 * H2：完整 ZIP 结构校验——不依赖 fflate 流式解析对中央目录的（不存在的）核对：
 * 1) EOCD 定位：尾部 22+65535 内存在签名，且注释长度与实际尾部精确吻合；
 * 2) 目录范围：cdOffset + cdSize 必须正好等于 EOCD 位置（目录紧贴结束记录，
 *    删除/缩小/移动中央目录而保留 EOCD 会被此条拒绝）；
 * 3) 目录条目：逐条签名/长度边界合法，条目总数与 EOCD 计数一致；
 * 4) 条目 ↔ 本地成员一致：每条的本地头偏移处确有本地头且文件名一致，
 *    目录名称集合与流式解析实际见到的成员集合双向一致。
 * zip64 标记值（0xFFFFFFFF）按不支持结构明确拒绝（本备份范围 ≤512MiB/≤5000 条）。
 */
function assertZipStructure(archive: Uint8Array, seen: ReadonlySet<string>): void {
  const u16 = (at: number) => archive[at]! | (archive[at + 1]! << 8);
  const u32 = (at: number) => (archive[at]! | (archive[at + 1]! << 8) | (archive[at + 2]! << 16) | (archive[at + 3]! << 24)) >>> 0;
  const corrupt = () => { throw new NativeBackupError("BACKUP_CORRUPT"); };
  // 1) EOCD 定位（注释长度必须精确吻合到包尾，防止注释中伪造第二个 EOCD）。
  const tailStart = Math.max(0, archive.byteLength - (22 + 65535));
  let eocd = -1;
  for (let index = archive.byteLength - 22; index >= tailStart; index -= 1) {
    if (archive[index] === 0x50 && archive[index + 1] === 0x4b && archive[index + 2] === 0x05 && archive[index + 3] === 0x06) {
      if (index + 22 + u16(index + 20) === archive.byteLength) { eocd = index; break; }
    }
  }
  if (eocd < 0) corrupt();
  if (u16(eocd + 4) !== 0 || u16(eocd + 6) !== 0) corrupt();          // 单盘包
  const entryCount = u16(eocd + 10);
  const cdSize = u32(eocd + 12);
  const cdOffset = u32(eocd + 16);
  if (cdSize === 0xffffffff || cdOffset === 0xffffffff) corrupt();    // zip64 不支持，明确拒绝
  // 2) 目录范围：目录紧贴 EOCD。
  if (cdOffset + cdSize !== eocd) corrupt();
  // 3) 逐条目录项与 4) 与本地成员一致。
  const directoryNames = new Set<string>();
  let cursor = cdOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > eocd) corrupt();
    if (u32(cursor) !== 0x02014b50) corrupt();
    const nameLength = u16(cursor + 28);
    const extraLength = u16(cursor + 30);
    const commentLength = u16(cursor + 32);
    const localOffset = u32(cursor + 42);
    if (localOffset === 0xffffffff) corrupt();
    if (cursor + 46 + nameLength + extraLength + commentLength > eocd) corrupt();
    const name = strFromU8(archive.subarray(cursor + 46, cursor + 46 + nameLength));
    if (directoryNames.has(name)) corrupt();
    directoryNames.add(name);
    // J1：目录条目声明的 CRC/压缩后尺寸/方法，与本地头及实际成员字节核对。
    const cdCrc = u32(cursor + 16);
    const cdCompressedSize = u32(cursor + 20);
    const cdUncompressedSize = u32(cursor + 24);
    const cdMethod = u16(cursor + 10);
    if (cdCrc === 0xffffffff || cdCompressedSize === 0xffffffff || cdUncompressedSize === 0xffffffff) corrupt();   // zip64
    if (cdMethod !== 0 && cdMethod !== 8) corrupt();                // 仅支持 stored/deflate（本备份范围）
    // 本地头存在且文件名一致。
    if (localOffset + 30 > eocd) corrupt();
    if (u32(localOffset) !== 0x04034b50) corrupt();
    const localNameLength = u16(localOffset + 26);
    const localExtraLength = u16(localOffset + 28);
    if (localOffset + 30 + localNameLength + localExtraLength > eocd) corrupt();
    const localName = strFromU8(archive.subarray(localOffset + 30, localOffset + 30 + localNameLength));
    if (localName !== name) corrupt();
    const localMethod = u16(localOffset + 8);
    const localFlags = u16(localOffset + 6);
    const localCrc = u32(localOffset + 14);
    const localCompressedSize = u32(localOffset + 18);
    const localUncompressedSize = u32(localOffset + 22);
    const hasDataDescriptor = (localFlags & 0x8) !== 0;
    // 成员数据本体在本地头之后、长度恰为声明压缩尺寸。ZIP 的 CRC 是对**未压缩
    // 内容**的校验：stored（method 0）成员压缩数据=原内容，可直接核 CRC；
    // deflate 成员的压缩字节有自己的编码（其 CRC ≠ 内容 CRC），内容 CRC 在
    // 解压后核验（restore 的成员级 CRC 复核）。CRC 是意外损坏检测，不是防篡改
    // 的密码学认证；防篡改由媒体 SHA-256 与领域引用校验承担。
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + cdCompressedSize > eocd) corrupt();
    if (cdMethod === 0) {
      const stored = archive.subarray(dataStart, dataStart + cdCompressedSize);
      if (zipCrc32(stored) !== cdCrc) corrupt();
    }
    // 方法必须一致；本地头 CRC/sizes：fflate 流式导出带数据描述符（flags bit3，
    // 本地头三值为 0，真实值在数据后的描述符与中央目录）。两种形态分别核对：
    // 无描述符 → 本地头三值必须等于目录值；有描述符 → 本地头三值必须为 0，
    // 数据后的描述符（0x08074b50 签名或裸四元组）CRC/sizes 必须等于目录值。
    if (localMethod !== cdMethod) corrupt();
    if (hasDataDescriptor) {
      if (localCrc !== 0 || localCompressedSize !== 0 || localUncompressedSize !== 0) corrupt();
      const descriptorAt = dataStart + cdCompressedSize;
      let dCrc: number, dComp: number, dUncomp: number;
      if (descriptorAt + 16 <= eocd && u32(descriptorAt) === 0x08074b50) {
        dCrc = u32(descriptorAt + 4); dComp = u32(descriptorAt + 8); dUncomp = u32(descriptorAt + 12);
      } else if (descriptorAt + 12 <= eocd) {
        dCrc = u32(descriptorAt); dComp = u32(descriptorAt + 4); dUncomp = u32(descriptorAt + 8);
      } else { corrupt(); return; }
      if (dCrc !== cdCrc || dComp !== cdCompressedSize || dUncomp !== cdUncompressedSize) corrupt();
    } else {
      if (localCrc !== cdCrc || localCompressedSize !== cdCompressedSize || localUncompressedSize !== cdUncompressedSize) corrupt();
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== eocd) corrupt();                                       // 目录必须正好覆盖到 EOCD
  // 双向一致：目录集合 === 流式解析实际见到的成员集合。
  if (directoryNames.size !== seen.size) corrupt();
  for (const name of directoryNames) if (!seen.has(name)) corrupt();
}

/** J1：按成员名读目录条目声明的 CRC（本地头与目录一致性已由结构校验保证）。 */
function zipEntryCrcByName(archive: Uint8Array, name: string): number | null {
  const u16 = (at: number) => archive[at]! | (archive[at + 1]! << 8);
  const u32 = (at: number) => (archive[at]! | (archive[at + 1]! << 8) | (archive[at + 2]! << 16) | (archive[at + 3]! << 24)) >>> 0;
  const tailStart = Math.max(0, archive.byteLength - (22 + 65535));
  let eocd = -1;
  for (let index = archive.byteLength - 22; index >= tailStart; index -= 1) {
    if (archive[index] === 0x50 && archive[index + 1] === 0x4b && archive[index + 2] === 0x05 && archive[index + 3] === 0x06) {
      if (index + 22 + u16(index + 20) === archive.byteLength) { eocd = index; break; }
    }
  }
  if (eocd < 0) return null;
  const entryCount = u16(eocd + 10);
  const cdOffset = u32(eocd + 16);
  let cursor = cdOffset;
  for (let index = 0; index < entryCount; index += 1) {
    const nameLength = u16(cursor + 28);
    const extraLength = u16(cursor + 30);
    const commentLength = u16(cursor + 32);
    const entryName = strFromU8(archive.subarray(cursor + 46, cursor + 46 + nameLength));
    if (entryName === name) return u32(cursor + 16);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

/**
 * 校验 + 原子恢复（B1 写入前领域校验；P1-1 指针最终事务切——保持）。
 */
export async function restoreNativeBackup(
  archive: Uint8Array,
  database: NativeDatabase,
  files: NativeFiles,
  account: { serverId: string; userId: string },
  deps: { digest(bytes: Uint8Array): Promise<string> },
  options: { limits?: BackupLimits; onChunk?: (byteLength: number) => void } = {}
): Promise<NativeBackupRestoreOutcome> {
  const limits = options.limits ?? NATIVE_BACKUP_LIMITS;
  if (archive.byteLength > limits.archiveBytes) return { status: "rejected", code: "BACKUP_TOO_LARGE" };
  // ① manifest 先行（流式小读取）；实际解压字节进入总量预算（J3）。
  let manifestFile: Uint8Array | undefined;
  let firstPassBytes = 0;
  try {
    const first = await readEntryStreamed(archive, ["manifest.json"], { limits });
    manifestFile = first.get("manifest.json");
    firstPassBytes = manifestFile?.byteLength ?? 0;
  } catch (error) {
    // J3：第一遍（manifest 读取）超限也携带观测值。
    return { status: "rejected", code: error instanceof NativeBackupError ? error.code : "BACKUP_CORRUPT", ...(error instanceof NativeBackupError && error.observedBytes !== undefined ? { observedDecompressedBytes: error.observedBytes } : {}) };
  }
  if (!manifestFile) return { status: "rejected", code: "BACKUP_MANIFEST_MISSING" };
  // K1：manifest 解压内容的 CRC 核验（method=8 的 manifest 之前只核 stored 媒体，
  // 内容改动保留旧 CRC 曾写入错误业务值）。CRC 是意外损坏检测，不是来源认证。
  const manifestCrc = zipEntryCrcByName(archive, "manifest.json");
  if (manifestCrc === null || zipCrc32(manifestFile) !== manifestCrc) return { status: "rejected", code: "BACKUP_CONTENT_INVALID" };
  const parsed = safeParse(strFromU8(manifestFile));
  if (!parsed || typeof parsed !== "object") return { status: "rejected", code: "BACKUP_MANIFEST_INVALID" };
  const manifest = parsed as NativeBackupManifest;
  if (manifest.format !== NATIVE_BACKUP_FORMAT || manifest.version !== NATIVE_BACKUP_VERSION) return { status: "rejected", code: "BACKUP_VERSION_UNSUPPORTED" };
  if (!Array.isArray(manifest.archives) || !Array.isArray(manifest.records) || !Array.isArray(manifest.inbox) || !Array.isArray(manifest.media)) return { status: "rejected", code: "BACKUP_MANIFEST_INVALID" };
  if (manifest.serverId !== account.serverId || manifest.userId !== account.userId) return { status: "rejected", code: "BACKUP_OWNERSHIP_MISMATCH" };
  const entries = manifest.archives.length + manifest.records.length + manifest.inbox.length + manifest.media.length;
  if (entries > limits.entries) return { status: "rejected", code: "BACKUP_TOO_MANY_ENTRIES" };
  const declaredMediaBytes = manifest.media.reduce((sum, item) => sum + item.size, 0);
  if (declaredMediaBytes > limits.decompressedBytes) return { status: "rejected", code: "BACKUP_DECOMPRESSED_TOO_LARGE" };
  // ② B1：领域/引用闭环（真实存储结构）写入前。
  for (const row of manifest.records) if (safeParse(row.json) === null) return { status: "rejected", code: "BACKUP_CONTENT_INVALID" };
  for (const row of manifest.archives) if (safeParse(row.json) === null) return { status: "rejected", code: "BACKUP_CONTENT_INVALID" };
  const domain = validateDomain(manifest);
  if (!domain.ok) return { status: "rejected", code: domain.code };
  for (const media of manifest.media) {
    try { zipNameToPath(media.zipName); } catch { return { status: "rejected", code: "BACKUP_PATH_INVALID" }; }
    if (!/^[a-f0-9]{64}$/.test(media.sha256) || !Number.isSafeInteger(media.size) || media.size < 0) return { status: "rejected", code: "BACKUP_DIGEST_MISMATCH" };
  }
  // ③ 空目标（任何指针切换之前）。
  const precheck = await assertTargetEmpty(database, account);
  if (!precheck.ok) return { status: "rejected", code: precheck.code };
  // J3：第二遍预算 = 总预算 − 第一遍实际解压字节（manifest 已消耗的部分不遗漏）。
  const secondPassBudget = limits.decompressedBytes - firstPassBytes;
  if (declaredMediaBytes > secondPassBudget) {
    return { status: "rejected", code: "BACKUP_DECOMPRESSED_TOO_LARGE", observedDecompressedBytes: firstPassBytes + declaredMediaBytes };
  }
  // ④ B3/G4d/H2/H3：整包流式校验 + 完整 ZIP 结构校验。严格成员宇宙——流出
  // 的成员名必须 ⊆ 声明媒体 ∪ {manifest.json}；声明量与实际解压量在遍内各计
  // 一次；两遍合并总量由 secondPassBudget 界定（J3）。
  let memberBytes: Map<string, Uint8Array>;
  let seenNames: ReadonlySet<string> = new Set<string>();
  try {
    memberBytes = await readEntryStreamed(archive, manifest.media.map(item => item.zipName), {
      limits: { ...limits, decompressedBytes: secondPassBudget }, universe: ["manifest.json"],
      onSeen: names => { seenNames = names; },
      onChunk: options.onChunk
    });
    // H2：EOCD 定位/目录范围/完整目录条目/与本地成员双向一致（删除中央目录
    // 保留 EOCD、目录移位、条目缺失等结构性破坏在业务写入与指针切换前拒绝）。
    assertZipStructure(archive, seenNames);
  }
  catch (error) {
    return { status: "rejected", code: error instanceof NativeBackupError ? error.code : "BACKUP_CORRUPT", ...(error instanceof NativeBackupError && error.observedBytes !== undefined ? { observedDecompressedBytes: error.observedBytes + firstPassBytes } : {}) };
  }
  // 未声明成员校验：流出成员集必须 ⊆ {manifest.json} ∪ 声明媒体（readEntryStreamed 已计数；
  // 这里核对实际收到的成员与声明一一对应）。J1：解压后的媒体字节再核 CRC
  //（本地头/目录声明的 CRC 与实际内容一致；CRC 是意外损坏检测，防篡改由
  // SHA-256 与领域校验承担）。
  for (const media of manifest.media) {
    const bytes = memberBytes.get(media.zipName);
    if (!bytes) return { status: "rejected", code: "BACKUP_FILE_MISSING" };
    if (bytes.byteLength !== media.size) return { status: "rejected", code: "BACKUP_SIZE_MISMATCH" };
    const crcEntry = zipEntryCrcByName(archive, media.zipName);
    if (crcEntry === null || zipCrc32(bytes) !== crcEntry) return { status: "rejected", code: "BACKUP_CONTENT_INVALID" };
    if (await deps.digest(bytes) !== media.sha256) return { status: "rejected", code: "BACKUP_DIGEST_MISMATCH" };
  }
  // ⑤ 文件就位（保持：暂存不查指针；dataset 行幂等登记）。
  const targetActor = { ...account, datasetId: manifest.datasetId };
  let staged: Awaited<ReturnType<typeof files.stageForRestore>>[] = [];
  try {
    await database.transaction(async db => {
      await db.run("INSERT OR IGNORE INTO mobile_datasets(server_id,user_id,dataset_id,created_at) VALUES(?,?,?,?)",
        [account.serverId, account.userId, manifest.datasetId, Date.now()]);
    });
    for (const media of manifest.media) {
      const bytes = memberBytes.get(media.zipName)!;
      const stagedOne = await files.stageForRestore(targetActor, {
        id: media.mediaId, type: media.type, size: media.size,
        blob: new Blob([Uint8Array.from(bytes)], { type: media.type })
      });
      staged.push(stagedOne);
    }
  } catch {
    await files.discardStagedForRestore(staged);
    return { status: "rejected", code: "BACKUP_FILE_POSITION_FAILED" };
  }
  // ⑥ 最终事务：重验空目标 → 业务/收据/links/媒体行/指针共同提交（保持）。
  const values = [account.serverId, account.userId, manifest.datasetId];
  try {
    await database.transaction(async db => {
      const recheck = await assertTargetEmpty(db, account);
      if (!recheck.ok) throw new NativeBackupError(recheck.code);
      for (const row of manifest.archives) {
        await db.run("INSERT INTO mobile_archives(server_id,user_id,dataset_id,kind,revision,json) VALUES(?,?,?,?,?,?)",
          [...values, row.kind, row.revision, row.json]);
      }
      for (const row of manifest.records) {
        await db.run("INSERT INTO mobile_records(server_id,user_id,dataset_id,kind,record_id,json) VALUES(?,?,?,?,?,?)",
          [...values, row.kind, row.record_id, row.json]);
      }
      for (const row of manifest.inbox) {
        await db.run("INSERT INTO tasks_inbox(server_id,user_id,dataset_id,task_id,digest,chat_session_id,applied_at,acked_at) VALUES(?,?,?,?,?,?,?,?)",
          [...values, row.task_id, row.digest, row.chat_session_id, row.applied_at, row.acked_at]);
      }
      await files.commitStagedForRestore(db, staged);
      for (const media of manifest.media) {
        for (const link of media.links) {
          await db.run("INSERT INTO mobile_media_links(server_id,user_id,dataset_id,kind,media_id,json) VALUES(?,?,?,?,?,?)",
            [...values, link.kind, media.mediaId, link.json]);
        }
      }
      await db.run("UPDATE mobile_accounts SET dataset_id=? WHERE server_id=? AND user_id=?",
        [manifest.datasetId, account.serverId, account.userId]);
    });
  } catch (error) {
    await files.discardStagedForRestore(staged);
    return { status: "rejected", code: error instanceof NativeBackupError ? error.code : "BACKUP_RESTORE_TX_FAILED" };
  }
  return { status: "restored", rows: manifest.archives.length + manifest.records.length + manifest.inbox.length, files: staged.length, datasetId: manifest.datasetId };
}

async function assertTargetEmpty(db: NativeDatabase, account: { serverId: string; userId: string }): Promise<{ ok: true } | { ok: false; code: string }> {
  const existing = await db.query(
    "SELECT (SELECT COUNT(*) FROM mobile_records WHERE server_id=? AND user_id=?) + (SELECT COUNT(*) FROM mobile_archives WHERE server_id=? AND user_id=?) + (SELECT COUNT(*) FROM mobile_media WHERE server_id=? AND user_id=?) + (SELECT COUNT(*) FROM tasks_inbox WHERE server_id=? AND user_id=?) AS n",
    [account.serverId, account.userId, account.serverId, account.userId, account.serverId, account.userId, account.serverId, account.userId]);
  return Number(existing[0]?.n ?? 0) > 0 ? { ok: false, code: "BACKUP_TARGET_NOT_EMPTY" } : { ok: true };
}
