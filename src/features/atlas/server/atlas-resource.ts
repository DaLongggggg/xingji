import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import {
  type AtlasPackageManifest,
  listAllowedPackageIds
} from "@/features/atlas/atlas-package-manifest";

/**
 * 地图资源白名单读取（仅服务端）。
 *
 * 约束：
 * - 只服务清单登记过的**固定标识**（全国包与各省城市分片），不接受路径、URL 或目录名；
 * - 生产环境必须显式提供数据包目录，未配置时不读取开发素材；
 * - 拒绝路径穿越、绝对路径与符号链接逸出；
 * - 错误信息不回显绝对路径；
 * - 不读取项目其他文件或私人媒体。
 */

export const ATLAS_PACKAGE_DIR = path.join(".local", "atlas");
export const MAX_ATLAS_RESPONSE_BYTES = 10 * 1024 * 1024;

export class AtlasResourceError extends Error {
  constructor(
    readonly code:
      "NOT_ALLOWED" | "NOT_FOUND" | "TOO_LARGE" | "MISSING_MANIFEST" | "INVALID_MANIFEST",
    message: string,
    readonly status: 400 | 404 | 413 | 500 = 404
  ) {
    super(message);
    this.name = "AtlasResourceError";
  }
}

/** 标识必须是无路径分隔符的普通文件名，且只含安全字符。 */
export function isSafePackageId(id: string): boolean {
  if (!id || id.length > 128) return false;
  if (id.startsWith(".")) return false;
  if (id.includes("/") || id.includes("\\")) return false;
  if (id.includes("\u0000")) return false;
  return /^[A-Za-z0-9._-]+$/.test(id);
}

export function resolveAtlasPackageDirectory(
  env: { NODE_ENV?: string; XINGJI_ATLAS_DIR?: string } = process.env,
  cwd: string = process.cwd()
): string | null {
  const configured = env.XINGJI_ATLAS_DIR?.trim();
  if (configured) return path.isAbsolute(configured) ? configured : null;
  return env.NODE_ENV === "production" ? null : path.join(cwd, ATLAS_PACKAGE_DIR);
}

/** 读取并校验清单；清单本身不在客户端 bundle 中。 */
export function readAtlasManifest(
  cwd: string = process.cwd(),
  options: { directory?: string } = {}
): AtlasPackageManifest {
  const directory = options.directory ?? path.join(cwd, ATLAS_PACKAGE_DIR);
  let raw: string;
  try {
    const manifestPath = resolvePackageFile(directory, "manifest.json");
    if (statSync(manifestPath).size > MAX_ATLAS_RESPONSE_BYTES) {
      throw new AtlasResourceError("TOO_LARGE", "地图数据包清单超过单响应上限。", 413);
    }
    raw = readFileSync(manifestPath, "utf8");
  } catch (error) {
    if (error instanceof AtlasResourceError && error.code !== "NOT_FOUND") throw error;
    throw new AtlasResourceError(
      "MISSING_MANIFEST",
      "地图数据包尚未准备；开发环境可运行 node scripts/atlas/prepare-atlas.mjs --download，生产环境请配置已核准的数据包目录。",
      500
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AtlasResourceError("INVALID_MANIFEST", "地图数据包清单无法解析。", 500);
  }
  const manifest = parsed as AtlasPackageManifest;
  const validFile = (file: unknown) => typeof file === "string" && isSafePackageId(file) && file.endsWith(".json");
  if (
    !validFile(manifest?.national?.packageFile) ||
    !Array.isArray(manifest.cityChunks) ||
    !manifest.cityChunks.every((chunk) => validFile(chunk?.file)) ||
    (manifest.countyPackages !== undefined &&
      (!Array.isArray(manifest.countyPackages) || !manifest.countyPackages.every((item) => validFile(item?.file))))
  ) {
    throw new AtlasResourceError("INVALID_MANIFEST", "地图数据包清单结构不完整。", 500);
  }
  return manifest;
}

export type AtlasResourceResult = { id: string; text: string; bytes: number };

function resolvePackageFile(directory: string, id: string): string {
  let root: string;
  let resolved: string;
  try {
    root = realpathSync(directory);
    resolved = realpathSync(path.join(root, id));
  } catch {
    throw new AtlasResourceError("NOT_FOUND", "资源不存在。", 404);
  }
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new AtlasResourceError("NOT_ALLOWED", "资源越界。", 404);
  }
  return resolved;
}

/**
 * 读取白名单内的一个资源。
 * `id` 必须是清单登记的文件名；其余一律拒绝（不提示可用值，避免探测）。
 */
export function readAtlasResource(
  id: string,
  options: { cwd?: string; directory?: string; manifest?: AtlasPackageManifest } = {}
): AtlasResourceResult {
  const cwd = options.cwd ?? process.cwd();
  if (!isSafePackageId(id)) {
    throw new AtlasResourceError("NOT_ALLOWED", "资源标识不合法。", 400);
  }
  const manifest = options.manifest ?? readAtlasManifest(cwd, options);
  const allowed = listAllowedPackageIds(manifest);
  if (!allowed.includes(id)) {
    throw new AtlasResourceError("NOT_ALLOWED", "资源不在白名单内。", 404);
  }
  const resolved = resolvePackageFile(options.directory ?? path.join(cwd, ATLAS_PACKAGE_DIR), id);
  // 读入前检查体积，避免超大文件先分配内存；读后仍检查实际字节数。
  if (statSync(resolved).size > MAX_ATLAS_RESPONSE_BYTES) {
    throw new AtlasResourceError("TOO_LARGE", "资源超过单响应上限。", 413);
  }
  const text = readFileSync(resolved, "utf8");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_ATLAS_RESPONSE_BYTES) throw new AtlasResourceError("TOO_LARGE", "资源超过单响应上限。", 413);
  return { id, text, bytes };
}
