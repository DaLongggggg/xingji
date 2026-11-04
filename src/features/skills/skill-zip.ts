/** Bounded ZIP-to-text adapter. fflate owns decompression; nothing is extracted to disk. */
import { strFromU8, Unzip, UnzipInflate } from "fflate";
import {
  assertImportPath,
  decodeSkillText,
  prepareSkillFiles,
  SKILL_LIMITS,
  SkillInstallError,
  type SkillImport,
  type SkillTextFile
} from "./skill-package";

type ZipEntry = {
  name: string;
  size: number;
  compressed: number;
  method: number;
  crc: number;
  text: boolean;
};
const isText = (name: string) =>
  /\.md$/i.test(name) || /(?:^|\/)(?:LICENSE|LICENCE)(?:\.txt)?$/i.test(name);
const invalidZip = () =>
  new SkillInstallError("SKILL_INVALID", "ZIP 无效、已损坏，或使用了不支持的压缩格式。");

/** fflate's stream API does not expose central-directory link attributes or CRCs. */
function zipEntries(bytes: Uint8Array): Map<string, ZipEntry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 22 || view.getUint32(0, true) !== 0x04034b50) throw invalidZip();
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (
      view.getUint32(i, true) === 0x06054b50 &&
      i + 22 + view.getUint16(i + 20, true) === bytes.length
    ) {
      end = i;
      break;
    }
  }
  if (end < 0) throw invalidZip();
  const count = view.getUint16(end + 10, true);
  const offset = view.getUint32(end + 16, true);
  const directorySize = view.getUint32(end + 12, true);
  if (
    view.getUint16(end + 4, true) ||
    view.getUint16(end + 6, true) ||
    view.getUint16(end + 8, true) !== count ||
    count === 65535 ||
    offset === 0xffffffff ||
    offset + directorySize !== end
  )
    throw new SkillInstallError("SKILL_INVALID", "不支持分卷或 ZIP64 压缩包，请使用普通 ZIP。");
  if (count > SKILL_LIMITS.entries)
    throw new SkillInstallError("SKILL_LIMIT", "ZIP 最多包含 200 个条目。");
  const entries = new Map<string, ZipEntry>();
  const names = new Set<string>();
  let cursor = offset,
    declaredText = 0,
    declaredAll = 0,
    textCount = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50) throw invalidZip();
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const compressed = view.getUint32(cursor + 20, true);
    const size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const length =
      46 + nameLength + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true);
    const mode = (view.getUint32(cursor + 38, true) >>> 16) & 0xf000;
    const local = view.getUint32(cursor + 42, true);
    if (flags & 1) throw new SkillInstallError("SKILL_INVALID", "不支持加密 ZIP，请解密后再导入。");
    if (mode !== 0 && mode !== 0x8000 && mode !== 0x4000)
      throw new SkillInstallError("SKILL_INVALID", "ZIP 包含链接或特殊文件，已拒绝导入。");
    if (
      cursor + length > end ||
      compressed === 0xffffffff ||
      size === 0xffffffff ||
      local + 30 > offset
    )
      throw invalidZip();
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = strFromU8(nameBytes, !(flags & 0x800));
    assertImportPath(name);
    const nameKey = name.normalize("NFC").toLowerCase();
    if (names.has(nameKey)) throw new SkillInstallError("SKILL_INVALID", "ZIP 包含重复文件路径。");
    names.add(nameKey);
    // Reject mismatched local names/flags before letting a decompressor see them.
    if (
      view.getUint32(local, true) !== 0x04034b50 ||
      view.getUint16(local + 6, true) !== flags ||
      view.getUint16(local + 8, true) !== method
    )
      throw invalidZip();
    const localNameLength = view.getUint16(local + 26, true);
    const start = local + 30 + localNameLength + view.getUint16(local + 28, true);
    if (
      start + compressed > offset ||
      strFromU8(bytes.subarray(local + 30, local + 30 + localNameLength), !(flags & 0x800)) !== name
    )
      throw invalidZip();
    const systemMetadata = name
      .split("/")
      .some((part) => part === "__MACOSX" || part === ".DS_Store" || part.startsWith("._"));
    const text = !name.endsWith("/") && !systemMetadata && isText(name);
    if (text) {
      if (method !== 0 && method !== 8) throw invalidZip();
      if (size > SKILL_LIMITS.textBytes)
        throw new SkillInstallError("SKILL_LIMIT", "ZIP 中单个文本超过 256 KiB。");
      declaredText += size;
      textCount++;
    }
    declaredAll += size;
    if (
      declaredText > SKILL_LIMITS.totalBytes ||
      textCount > SKILL_LIMITS.files ||
      declaredAll > 16 * 1024 * 1024
    )
      throw new SkillInstallError(
        "SKILL_LIMIT",
        "ZIP 解压预算超限：最多 64 个文本、文本合计 2 MiB、所有文件合计 16 MiB。"
      );
    entries.set(name, {
      name,
      size,
      compressed,
      method,
      text,
      crc: view.getUint32(cursor + 16, true)
    });
    cursor += length;
  }
  if (cursor !== end) throw invalidZip();
  return entries;
}

const CRC_TABLE = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

export function prepareSkillZip(bytes: Uint8Array): SkillImport {
  if (bytes.byteLength > SKILL_LIMITS.uploadBytes)
    throw new SkillInstallError("SKILL_LIMIT", "ZIP 文件不能超过 4 MiB。");
  let streamFailure: SkillInstallError | undefined;
  try {
    const entries = zipEntries(bytes);
    const files: SkillTextFile[] = [];
    const visited = new Set<string>();
    let total = 0;
    const unzip = new Unzip((file) => {
      const entry = entries.get(file.name);
      if (
        !entry ||
        visited.has(file.name) ||
        entry.method !== file.compression ||
        (file.originalSize !== undefined && file.originalSize !== entry.size) ||
        (file.size !== undefined && file.size !== entry.compressed)
      )
        throw invalidZip();
      visited.add(file.name);
      if (!entry.text) return;
      let size = 0;
      const chunks: Uint8Array[] = [];
      file.ondata = (error, chunk, final) => {
        if (streamFailure) throw streamFailure;
        if (error) throw invalidZip();
        size += chunk.length;
        total += chunk.length;
        if (
          size > Math.min(entry.size, SKILL_LIMITS.textBytes) ||
          total > SKILL_LIMITS.totalBytes
        ) {
          streamFailure = new SkillInstallError(
            "SKILL_LIMIT",
            "ZIP 实际解压内容超过声明大小或文本预算，已停止导入。"
          );
          file.terminate();
          throw streamFailure;
        }
        chunks.push(chunk);
        if (final) {
          if (size !== entry.size) throw invalidZip();
          const content = new Uint8Array(size);
          let cursor = 0;
          for (const part of chunks) {
            content.set(part, cursor);
            cursor += part.length;
          }
          if (crc32(content) !== entry.crc) throw invalidZip();
          files.push({ path: file.name, content: decodeSkillText(content) });
        }
      };
      file.start();
    });
    unzip.register(UnzipInflate);
    // Small compressed chunks also bound allocation when a size declaration is forged.
    for (let offset = 0; offset < bytes.length; offset += 1024)
      unzip.push(bytes.subarray(offset, offset + 1024), offset + 1024 >= bytes.length);
    if (
      visited.size !== entries.size ||
      files.length !== [...entries.values()].filter((entry) => entry.text).length
    )
      throw invalidZip();
    const result = prepareSkillFiles(files);
    const ignored = [...entries.values()].filter(
      (entry) => !entry.text && !entry.name.endsWith("/")
    ).length;
    if (ignored)
      result.warnings.unshift(
        `未安装 ${ignored} 个脚本、媒体或其他非文本文件；Skill 中的命令不会自动执行。`
      );
    return result;
  } catch (error) {
    if (streamFailure) throw streamFailure;
    if (error instanceof SkillInstallError) throw error;
    throw invalidZip();
  }
}
