import { detectGlobalBridge, digestBytes } from "@/features/mobile/native-host";
import type { LocalImageEdit } from "./workbench-image-edit-contract";
import type { ImageTransformResult } from "./workbench-image-transform";

// U²-Netp (Apache-2.0), pinned original rembg weights shipped as a same-origin runtime asset.
const MODEL = "/models/u2netp-309c8469.onnx";
const MODEL_BYTES = 4_574_861, SHA = "309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8";
/** Model integrity uses the same native digest port as files when the App runs over LAN HTTP. */
async function modelBytes(signal: AbortSignal): Promise<ArrayBuffer> {
  const cache = typeof caches !== "undefined" ? await caches.open("xingji-public-u2netp-v1").catch(() => undefined) : undefined;
  signal.throwIfAborted();
  let response = await cache?.match(MODEL);
  if (!response) {
    try { response = await fetch(MODEL, { credentials: "omit", referrerPolicy: "no-referrer", signal }); }
    catch { signal.throwIfAborted(); throw new Error("抠图模型下载失败，请检查网络后重试。原图未上传。"); }
  }
  if (!response.ok || Number(response.headers.get("content-length")) > MODEL_BYTES || !response.body)
    throw new Error("抠图模型下载失败，请检查网络后重试。");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > MODEL_BYTES) throw new Error("抠图模型文件超出固定大小。");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); signal.removeEventListener("abort", abort); }
  if (size !== MODEL_BYTES) throw new Error("抠图模型文件不完整。");
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  if (await digestBytes(bytes, detectGlobalBridge()) !== SHA) { await cache?.delete(MODEL); throw new Error("抠图模型校验失败，未处理原图。"); }
  signal.throwIfAborted();
  await cache?.put(MODEL, new Response(bytes)).catch(() => undefined);
  return bytes.buffer;
}

/** A short-lived local Worker owns each operation; closing/switching the viewer does not cancel its frozen target. */
export function editImageFile(blob: Blob, operation: LocalImageEdit, signal?: AbortSignal): Promise<ImageTransformResult> {
  signal?.throwIfAborted();
  if (typeof Worker === "undefined") return Promise.reject(new Error("当前环境无法本地处理图片，请使用支持Worker的浏览器。"));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./workbench-image-edit.worker.ts", import.meta.url), { type: "module" });
    const download = new AbortController();
    let ended = false;
    const finish = () => { ended = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); download.abort(); worker.terminate(); };
    const abort = () => { finish(); reject(new DOMException("本地图片编辑已取消", "AbortError")); };
    const timer = setTimeout(() => { finish(); reject(new Error("本地图片处理超时，未保存结果。")); }, 180_000);
    signal?.addEventListener("abort", abort, { once: true });
    worker.onmessage = event => { finish(); if (event.data.error) reject(new Error(event.data.error)); else resolve(event.data.result); };
    worker.onerror = event => { event.preventDefault(); finish(); reject(new Error("本地图片处理失败，未保存结果。")); };
    void (async () => {
      const model = operation.kind === "remove-background" ? await modelBytes(download.signal) : undefined;
      if (ended) return;
      try { worker.postMessage({ blob, operation, ...(model ? { model } : {}) }, model ? [model] : []); }
      catch { throw new Error("无法读取当前原件，未处理图片。"); }
    })().catch(error => { if (!ended) { finish(); reject(error); } });
  });
}
