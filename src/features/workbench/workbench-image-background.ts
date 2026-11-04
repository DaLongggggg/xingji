import * as ort from "onnxruntime-web/wasm";
/** The documented U²-Net preprocessing and fused first output; only a 320px saliency mask is inferred. */
export async function backgroundMask(bitmap: ImageBitmap, model: ArrayBuffer): Promise<OffscreenCanvas> {
  ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = { wasm: new URL("onnxruntime-web/ort-wasm-simd-threaded.wasm", import.meta.url).href };
  const session = await ort.InferenceSession.create(model, { executionProviders: ["wasm"] });
  try {
    const canvas = new OffscreenCanvas(320, 320), ctx = canvas.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0, 320, 320);
    const rgba = ctx.getImageData(0, 0, 320, 320).data, input = new Float32Array(3 * 320 * 320);
    let max = 1;
    for (let i = 0; i < rgba.length; i++) if (i % 4 !== 3) max = Math.max(max, rgba[i]);
    const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
    for (let pixel = 0; pixel < 320 * 320; pixel++) for (let channel = 0; channel < 3; channel++)
      input[channel * 320 * 320 + pixel] = (rgba[pixel * 4 + channel] / max - mean[channel]) / std[channel];
    const output = await session.run({ [session.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, 320, 320]) });
    const mask = output[session.outputNames[0]].data as Float32Array;
    if (mask.length !== 320 * 320) throw new Error("抠图模型返回尺寸无效。");
    let min = Infinity, maxValue = -Infinity;
    for (const value of mask) { if (!Number.isFinite(value)) throw new Error("抠图模型结果无效。"); min = Math.min(min, value); maxValue = Math.max(maxValue, value); }
    if (maxValue - min < 1e-6) throw new Error("未识别到清晰主体，未保存结果。");
    const data = ctx.createImageData(320, 320);
    for (let pixel = 0; pixel < mask.length; pixel++) { data.data[pixel * 4] = data.data[pixel * 4 + 1] = data.data[pixel * 4 + 2] = 255; data.data[pixel * 4 + 3] = Math.round((mask[pixel] - min) / (maxValue - min) * 255); }
    ctx.putImageData(data, 0, 0); return canvas;
  } finally { await session.release(); }
}
