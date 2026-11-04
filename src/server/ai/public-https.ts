/** Anonymous public HTTPS reads. DNS is checked on each hop and pinned for the connection. */
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";

export type PublicHttpsAddress = { address: string; family: number };
export type PublicHttpsResult = { status: number; headers: Record<string, string | undefined>; bytes: Uint8Array; truncated?: true };
export type PublicHttpsDeps = {
  resolve?: (hostname: string) => Promise<PublicHttpsAddress[]>;
  transport?: (url: URL, options: PublicHttpsAddress & { signal: AbortSignal; maxBytes: number; accept?: string; allowPrefix?: boolean }) => Promise<PublicHttpsResult>;
};
export class PublicHttpsError extends Error {
  constructor(readonly code: "invalid" | "limit" | "network" | "cancelled", detail: string) {
    super(detail); this.name = "PublicHttpsError";
  }
}

async function whileActive<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new PublicHttpsError("cancelled", "下载超时或已取消，请检查网络后重试。");
  return new Promise((resolve, reject) => {
    const abort = () => reject(new PublicHttpsError("cancelled", "下载超时或已取消，请检查网络后重试。"));
    signal.addEventListener("abort", abort, { once: true });
    task.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

const PRIVATE = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
] as const)
  PRIVATE.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["2001::", 32],
  ["2001:db8::", 32],
  ["2002::", 16]
] as const)
  PRIVATE.addSubnet(address, prefix, "ipv6");
const GLOBAL_V6 = new BlockList();
GLOBAL_V6.addSubnet("2000::", 3, "ipv6");

export function isPublicHttpsAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4
    ? !PRIVATE.check(address, "ipv4")
    : family === 6 && GLOBAL_V6.check(address, "ipv6") && !PRIVATE.check(address, "ipv6");
}

export function validatePublicHttpsUrl(input: string): URL {
  if (input.length > 2048 || /[\x00-\x20\x7f]/.test(input))
    throw new PublicHttpsError("invalid", "链接无效，请输入完整 HTTPS 地址。");
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new PublicHttpsError("invalid", "链接无效，请输入完整 HTTPS 地址。");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    url.protocol !== "https:" ||
    (url.port && url.port !== "443") ||
    url.username ||
    url.password ||
    url.hash ||
    host.endsWith(".") ||
    !host.includes(".") ||
    /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|example)$/.test(host) ||
    (isIP(host) && !isPublicHttpsAddress(host))
  )
    throw new PublicHttpsError(
      "invalid",
      "只支持公开 HTTPS 链接和标准端口，不允许本机、内网、带凭据或片段的地址。"
    );
  return url;
}

function requestPinned(
  url: URL,
  options: PublicHttpsAddress & { signal: AbortSignal; maxBytes: number; accept?: string; allowPrefix?: boolean }
): Promise<PublicHttpsResult> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        agent: false,
        family: options.family,
        signal: options.signal,
        // Retain original hostname for Host / TLS verification; only the socket address is fixed.
        lookup: (_host, _options, callback) => callback(null, options.address, options.family),
        headers: {
          "user-agent": "Xingji-Public-Reader",
          accept:
            options.accept ?? "text/html, text/plain;q=0.9"
        }
      },
      (response) => {
        const status = response.statusCode ?? 502;
        const headers = {
          location: response.headers.location,
          "content-type": response.headers["content-type"]
        };
        if (status !== 200) {
          resolve({ status, headers, bytes: new Uint8Array() });
          response.destroy();
          return;
        }
        const declared = Number(response.headers["content-length"]);
        if (!options.allowPrefix && Number.isFinite(declared) && declared > options.maxBytes) {
          reject(new PublicHttpsError("limit", "下载文件超过允许大小。"));
          request.destroy();
          return;
        }
        const chunks: Uint8Array[] = [];
        let size = 0;
        const finish = (truncated?: true) => {
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
          resolve({ status, headers, bytes, ...(truncated ? { truncated } : {}) });
        };
        response.on("data", (chunk: Buffer) => {
          if (options.allowPrefix && size + chunk.length >= options.maxBytes) {
            const prefix = chunk.subarray(0, Math.max(0, options.maxBytes - size));
            chunks.push(prefix); size += prefix.length;
            finish(true); response.destroy(); request.destroy(); return;
          }
          size += chunk.length;
          if (size > options.maxBytes) {
            reject(new PublicHttpsError("limit", "下载文件超过允许大小。"));
            request.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => finish());
        response.on("error", reject);
        response.on("aborted", () =>
          reject(new PublicHttpsError("network", "下载连接中断，请重试。"))
        );
      }
    );
    request.setTimeout(10_000, () => request.destroy(new PublicHttpsError("cancelled", "下载超时或已取消，请检查网络后重试。")));
    request.on("error", reject);
    request.end();
  });
}

/** No cookies, authorization, scripts, automatic redirects or unbounded response bodies. */
export async function readPublicHttpsUrl(input: string, options: {
  signal: AbortSignal; maxBytes: number; accept?: string; onRequest?: () => void;
  /** Opt in only for metadata previews. Skill packages must retain strict complete reads. */
  allowPrefix?: boolean;
}, deps: PublicHttpsDeps = {}): Promise<PublicHttpsResult & { url: URL }> {
  let url = validatePublicHttpsUrl(input);
  let remaining = options.maxBytes;
  const resolve = deps.resolve ?? ((hostname: string) => lookup(hostname, { all: true, verbatim: true }));
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (options.signal.aborted) throw new PublicHttpsError("cancelled", "下载超时或已取消，请检查网络后重试。");
    options.onRequest?.();
    const addresses = await whileActive(resolve(url.hostname), options.signal);
    if (!addresses.length || addresses.some(item => !isPublicHttpsAddress(item.address)))
      throw new PublicHttpsError("invalid", "链接解析到内网、保留或不可信地址，已拒绝下载。");
    if (options.signal.aborted) throw new PublicHttpsError("cancelled", "下载超时或已取消，请检查网络后重试。");
    const address = addresses.find(item => item.family === 4) ?? addresses[0];
    let result = await whileActive((deps.transport ?? requestPinned)(url, {
      ...address, signal: options.signal, maxBytes: remaining, accept: options.accept, allowPrefix: options.allowPrefix
    }), options.signal);
    if (options.allowPrefix && result.status === 200 && result.bytes.length > remaining)
      result = { ...result, bytes: result.bytes.subarray(0, remaining), truncated: true };
    remaining -= result.bytes.length;
    if (remaining < 0) throw new PublicHttpsError("limit", "下载内容超过总预算。");
    if ([301, 302, 303, 307, 308].includes(result.status)) {
      if (!result.headers.location || redirects === 3) throw new PublicHttpsError("network", "重定向过多或缺少目标链接。");
      url = validatePublicHttpsUrl(new URL(result.headers.location, url).href);
      continue;
    }
    return { ...result, url };
  }
  throw new PublicHttpsError("network", "下载失败。");
}
