/**
 * 二进制摘要工具（014-A）。优先使用 Web Crypto 的 SHA-256；
 * 在没有 `crypto.subtle` 的受限环境回退到明确的非加密摘要，并标记算法，
 * 以便结构校验不会因为静默降级而误报“校验通过”。
 */

export type DigestAlgorithm = "SHA-256" | "FNV-1a-64";

export async function digestBlob(
  blob: Blob
): Promise<{ algorithm: DigestAlgorithm; digest: string }> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const hashed = await subtle.digest("SHA-256", bytes);
    return { algorithm: "SHA-256", digest: toHex(new Uint8Array(hashed)) };
  }
  return { algorithm: "FNV-1a-64", digest: fnv1a64(bytes) };
}

export async function digestBytes(
  bytes: Uint8Array
): Promise<{ algorithm: DigestAlgorithm; digest: string }> {
  return digestBlob(new Blob([new Uint8Array(bytes)]));
}

export function toHex(bytes: Uint8Array): string {
  let output = "";
  for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
  return output;
}

/** 非加密回退摘要：只用于环境缺少 Web Crypto 时的完整性检查，明确标注算法。 */
export function fnv1a64(bytes: Uint8Array): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}
