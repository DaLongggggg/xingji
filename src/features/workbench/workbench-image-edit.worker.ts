import { transformImage } from "./workbench-image-transform";
import type { LocalImageEdit } from "./workbench-image-edit-contract";
self.onmessage = async ({ data }: MessageEvent<{ blob: Blob; operation: LocalImageEdit; model?: ArrayBuffer }>) => {
  try { self.postMessage({ result: await transformImage(data.blob, data.operation, data.model) }); }
  catch (error) { self.postMessage({ error: error instanceof Error ? error.message : "本地图片处理失败。" }); }
};
