/**
 * 拉取某个端点可用模型：`POST /api/ai/settings/models/discover`。
 *
 * 边界（与其它本机管理端点同一套）：
 * - **仅本机同源**：Host 必须是回环地址，带 Origin/Referer 时必须同源；无认证生产环境关闭；
 * - 只接受一个受控请求体：`{kind, baseUrl, apiProtocol?, providerId?, apiKey?}`，未知字段一律拒绝；
 * - 凭据优先级：本次输入的密钥 > 已保存提供方的凭据（从加密文档按 ID 解析）；
 *   两者都不回显、不记录，只在服务端出站请求头里出现；
 * - 出站只有一次 `GET .../models`，时间/字节/条数上限都在 `model-discovery` 里；
 * - **不写任何配置**：拉到什么只回给这一次请求，用不用由用户在同一页自己勾。
 */
import { requireBetaAccess } from "@/server/ai/session-http";
import { loadEffectiveDocument } from "@/server/ai/model-settings-manager";
import { isBetaScopeActive, scopedEnvForModelConfig } from "@/server/ai/user-scope";
import {
  assertDiscoverableBaseUrl,
  assertDiscoveryApiKey,
  DISCOVERY_ERROR_DETAIL,
  discoverModels,
  ModelDiscoveryError,
  type DiscoveryProtocol
} from "@/server/ai/model-discovery";
import { isChatApiProtocol } from "@/features/ai/model-settings-contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 16 * 1024;
const ALLOWED_FIELDS = new Set(["kind", "baseUrl", "apiProtocol", "imagesPath", "providerId", "apiKey"]);

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

const FAILURE_STATUS: Record<string, number> = {
  AI_DISCOVERY_INVALID: 400,
  AI_DISCOVERY_UNSUPPORTED: 400,
  // 供应商密钥不可用属于配置错误；401 只保留给 requireBetaAccess 的应用会话失败。
  AI_DISCOVERY_UNAUTHORIZED: 422,
  AI_DISCOVERY_TIMEOUT: 504,
  AI_DISCOVERY_FAILED: 502
};

function failure(code: string, detail?: string): Response {
  return json(
    { ok: false, code, detail: detail ?? DISCOVERY_ERROR_DETAIL[code as keyof typeof DISCOVERY_ERROR_DETAIL] ?? "拉取模型列表失败。" },
    FAILURE_STATUS[code] ?? 502
  );
}

/**
 * 已保存提供方的凭据：按**提供方 ID** 从权威文档（或旧环境声明）解析。
 * 运行时模型配置的 ID 是模型 ID，不是提供方 ID；不能拿它来查。
 * 找不到或没有可用密钥 → 让用户先填密钥，而不是拿空字符串去出站。
 */
function storedApiKey(kind: "chat" | "image", providerId: string): string | undefined {
  try {
    // T2a：按当前用户 scope 的文档解析；beta 下 env 引用零继承，不探测全局进程环境。
    const env = scopedEnvForModelConfig();
    const { document } = loadEffectiveDocument(env);
    const provider = document.providers.find((item) => item.id === providerId && item.kind === kind);
    if (!provider) return undefined;
    if (provider.credential?.value) return provider.credential.value;
    if (provider.apiKeyEnv && !isBetaScopeActive()) return env[provider.apiKeyEnv];
    return undefined;
  } catch {
    return undefined;
  }
}

export async function POST(request: Request): Promise<Response> {
  // requireBetaAccess 返回的是 Response（401/403/503）或 undefined——原样透传。
  const blocked = requireBetaAccess(request);
  if (blocked) return blocked;

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) return failure("AI_DISCOVERY_INVALID");

  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return failure("AI_DISCOVERY_INVALID");
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return failure("AI_DISCOVERY_INVALID");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return failure("AI_DISCOVERY_INVALID");
  const body = payload as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (body[key] === undefined) continue;
    if (!ALLOWED_FIELDS.has(key)) return failure("AI_DISCOVERY_INVALID");
  }

  const kind = body.kind;
  if (kind !== "chat" && kind !== "image") return failure("AI_DISCOVERY_INVALID");

  let protocol: DiscoveryProtocol;
  let imagesPath: string | undefined;
  if (kind === "image") {
    // 制图目前只有 OpenAI images 一种协议：与本项目的图片 Provider 同一口径。
    if (body.apiProtocol !== undefined) return failure("AI_DISCOVERY_INVALID");
    if (body.imagesPath !== undefined && (typeof body.imagesPath !== "string" || !body.imagesPath.startsWith("/"))) {
      return failure("AI_DISCOVERY_INVALID");
    }
    imagesPath = typeof body.imagesPath === "string" ? body.imagesPath : undefined;
    protocol = "openai-images";
  } else {
    if (body.imagesPath !== undefined) return failure("AI_DISCOVERY_INVALID");
    if (!isChatApiProtocol(body.apiProtocol)) return failure("AI_DISCOVERY_INVALID");
    protocol = body.apiProtocol;
  }

  let baseUrl: string;
  try {
    baseUrl = assertDiscoverableBaseUrl(body.baseUrl);
  } catch (error) {
    return failure(error instanceof ModelDiscoveryError ? error.code : "AI_DISCOVERY_INVALID");
  }

  let typedKey: string | undefined;
  try {
    typedKey = assertDiscoveryApiKey(body.apiKey);
  } catch (error) {
    return failure(error instanceof ModelDiscoveryError ? error.code : "AI_DISCOVERY_INVALID");
  }

  const providerId = typeof body.providerId === "string" && body.providerId.trim().length > 0 ? body.providerId.trim() : undefined;
  const apiKey = typedKey ?? (providerId ? storedApiKey(kind, providerId) : undefined);
  if (!apiKey) return failure("AI_DISCOVERY_UNAUTHORIZED");

  try {
    const result = await discoverModels({
      baseUrl,
      protocol,
      apiKey,
      ...(imagesPath ? { imagesPath } : {}),
      signal: request.signal ?? undefined
    });
    return json({ ok: true, models: result.models, truncated: result.truncated }, 200);
  } catch (error) {
    if (error instanceof ModelDiscoveryError) {
      // 详情只用于服务端诊断：这里回到浏览器的是稳定码 + 固定文案。
      return failure(error.code);
    }
    return failure("AI_DISCOVERY_FAILED");
  }
}
