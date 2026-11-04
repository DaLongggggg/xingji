import { CUSTOM_INSTRUCTIONS_LIMIT } from "@/features/ai/custom-instructions";
import { currentSettingsRevision } from "@/server/ai/model-settings-manager";
import { resolveSettingsPaths, SettingsStoreError, writeSettingsDocument } from "@/server/ai/model-settings-store";
import { configLockPath, withConfigLock } from "@/server/ai/model-config";
import { requireBetaAccess, sessionJson } from "@/server/ai/session-http";
import { scopedEnvForModelConfig } from "@/server/ai/user-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const view = () => {
  const current = currentSettingsRevision(scopedEnvForModelConfig());
  return { revision: current.revision, text: current.document.customInstructions ?? "" };
};
const failure = (detail: string, status = 503) => sessionJson({ ok: false, detail }, status);
const storageFailure = (error: unknown) => failure(error instanceof Error && error.message.includes("AI_CONFIG_BUSY")
  ? "设置正在保存，请稍后重试。" : error instanceof SettingsStoreError
    ? "设置暂时无法读取或保存；原有配置保持不变。" : "自定义指令暂时无法保存，请重试。",
  error instanceof Error && error.message.includes("AI_CONFIG_BUSY") ? 409 : 503);

export async function GET(request: Request): Promise<Response> {
  const denied = requireBetaAccess(request);
  if (denied) return denied;
  try { return sessionJson(view(), 200); } catch (error) { return storageFailure(error); }
}
export async function PUT(request: Request): Promise<Response> {
  const denied = requireBetaAccess(request);
  if (denied) return denied;
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) return failure("请提交有效的自定义指令。", 400);
  // Bound the stream before parsing; JSON escapes may need six bytes per input character.
  const reader = request.body?.getReader();
  if (!reader) return failure("缺少设置内容。", 400);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let raw = "", bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > CUSTOM_INSTRUCTIONS_LIMIT * 6 + 1024) { await reader.cancel(); return failure("指令过长。", 413); }
      raw += decoder.decode(chunk.value, { stream: true });
    }
    raw += decoder.decode();
  } catch { return failure("设置内容无效。", 400); }
  let body: { baseRevision: string; text: string };
  try {
    body = JSON.parse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !["baseRevision", "text"].includes(key)) ||
      typeof body.baseRevision !== "string" || !body.baseRevision || typeof body.text !== "string" || body.text.length > CUSTOM_INSTRUCTIONS_LIMIT) return failure("指令或设置版本无效。", 400);
  } catch { return failure("设置内容无效。", 400); }
  const paths = resolveSettingsPaths(scopedEnvForModelConfig());
  try {
    return await withConfigLock(configLockPath(paths.document), async () => {
      const current = currentSettingsRevision(scopedEnvForModelConfig(), paths);
      if (current.revision !== body.baseRevision) return failure("设置已在别处更新。请重新读取后再保存。", 409);
      writeSettingsDocument({ ...current.document, revision: current.document.revision + 1, customInstructions: body.text }, paths);
      return sessionJson(view(), 200);
    });
  } catch (error) { return storageFailure(error); }
}
