import { requireBetaAccess } from "@/server/ai/session-http";
import { configLockPath, isGatewayRouteEnabled, readAiPermissions, withConfigLock } from "@/server/ai/model-config";
import { currentSettingsRevision } from "@/server/ai/model-settings-manager";
import { resolveSettingsPaths, writeSettingsDocument } from "@/server/ai/model-settings-store";
import { scopedEnvForModelConfig } from "@/server/ai/user-scope";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
function view() {
  const current = currentSettingsRevision(scopedEnvForModelConfig() as NodeJS.ProcessEnv, resolveSettingsPaths());
  return { ok: true, revision: current.revision, permissions: readAiPermissions(), available: isGatewayRouteEnabled(), imagesAvailable: process.env.XINGJI_AI_IMAGE_ENABLED !== "0" };
}
export async function GET(request: Request) {
  // requireBetaAccess 返回的是 Response（401/403/503）或 undefined——原样透传。
  const denied = requireBetaAccess(request);
  if (denied) return denied;
  try { return json(view()); } catch { return json({ ok: false, detail: "无法读取隐私设置，请重试。" }, 503); }
}
export async function PUT(request: Request) {
  const denied = requireBetaAccess(request);
  if (denied) return denied;
  if (!request.headers.get("content-type")?.includes("application/json")) return json({ ok: false, detail: "请求格式无效。" }, 400);
  const reader = request.body?.getReader();
  if (!reader) return json({ ok: false, detail: "请求内容为空。" }, 400);
  let raw = "", bytes = 0;
  const decoder = new TextDecoder();
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 2048) { await reader.cancel(); return json({ ok: false, detail: "请求内容过长。" }, 413); }
      raw += decoder.decode(chunk.value, { stream: true });
    }
    raw += decoder.decode();
  } finally { reader.releaseLock(); }
  let body;
  try { body = JSON.parse(raw); } catch { return json({ ok: false, detail: "请求格式无效。" }, 400); }
  if (!body || Array.isArray(body) || Object.keys(body).some(k => !["revision", "permissions"].includes(k)) || typeof body.revision !== "string" || !body.permissions || Array.isArray(body.permissions) || Object.keys(body.permissions).length !== 2 || typeof body.permissions.ai !== "boolean" || typeof body.permissions.images !== "boolean") return json({ ok: false, detail: "设置格式无效。" }, 400);
  const paths = resolveSettingsPaths();
  try {
    return await withConfigLock(configLockPath(paths.document), async () => {
      const current = currentSettingsRevision(scopedEnvForModelConfig() as NodeJS.ProcessEnv, paths);
      if (current.revision !== body.revision) return json({ ok: false, detail: "设置已在别处修改，请重新读取后再试。" }, 409);
      const previous = readAiPermissions();
      if ((!previous.ai && body.permissions.ai && !isGatewayRouteEnabled()) || (!previous.images && body.permissions.images && process.env.XINGJI_AI_IMAGE_ENABLED === "0")) return json({ ok: false, detail: "当前服务不允许开启此功能。" }, 403);
      writeSettingsDocument({ ...current.document, revision: current.document.revision + 1, permissions: body.permissions }, paths);
      return json(view());
    });
  } catch { return json({ ok: false, detail: "设置未能保存，请重新读取后再试。" }, 503); }
}
