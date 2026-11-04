import { z } from "zod";
import { requireBetaAccess } from "@/server/ai/session-http";
import { readSearchImageFile, SearchImageFileError } from "@/server/ai/search-image-file";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAX_BODY = 8192;
const INPUT = z.strictObject({ url: z.string().min(1).max(2048), sourceUrl: z.string().min(1).max(2048) });
const HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
function failure(code: string, detail: string, status: number) {
  return Response.json({ ok: false, code, detail }, { status, headers: HEADERS });
}

async function readInput(request: Request): Promise<unknown> {
  if (Number(request.headers.get("content-length")) > MAX_BODY) throw new SearchImageFileError("limit");
  const reader = request.body?.getReader();
  if (!reader) throw new SearchImageFileError("invalid");
  const abort = () => { void reader.cancel().catch(() => {}); };
  request.signal.addEventListener("abort", abort, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0, text = "";
  try {
    for (;;) {
      request.signal.throwIfAborted();
      const { value, done } = await reader.read();
      request.signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY) { await reader.cancel(); throw new SearchImageFileError("limit"); }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { request.signal.removeEventListener("abort", abort); reader.releaseLock(); }
}

/** File viewing/downloading stays available when AI execution is disabled. */
export async function POST(request: Request): Promise<Response> {
  const denied = requireBetaAccess(request);
  if (denied) return denied;
  if (request.signal.aborted) return failure("cancelled", "图片文件读取已取消。", 499);
  try {
    if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
      throw new SearchImageFileError("invalid");
    const input = INPUT.safeParse(await readInput(request));
    if (!input.success) throw new SearchImageFileError("invalid");
    const file = await readSearchImageFile(input.data, request.signal);
    return new Response(new Uint8Array(file.bytes), { headers: { ...HEADERS, "content-type": file.mime,
      "content-length": String(file.bytes.length) } });
  } catch (error) {
    const safe = request.signal.aborted ? new SearchImageFileError("cancelled")
      : error instanceof SearchImageFileError ? error : new SearchImageFileError("invalid");
    return failure(safe.code, safe.message, safe.code === "limit" ? 413 : safe.code === "cancelled" ? 499
      : safe.code === "timeout" ? 504 : safe.code === "unavailable" ? 502 : 400);
  }
}
