/**
 * 本机自助模型配置管理端点：`/api/ai/settings/models`。
 *
 * 边界（任务书 §5）：
 * - **仅本机同源**：要求 Host 是回环地址，并在带 Origin/Referer 时要求同源；
 *   跨站写入、非 JSON、超大正文一律拒绝。单靠 Host 可被伪造，因此部署说明只承诺
 *   “绑定 127.0.0.1 的本机单用户单进程”，不宣称可经公网反代开放；
 * - 无认证生产环境沿用既有判定：管理端点与模型代理一样关闭；
 * - 管理视图可以给出用户可编辑的模型 ID/API 地址，但**永不返回密钥值或密钥环境变量名**；
 * - 所有写入走**同一条权威文档**与同一把锁：整批校验、全成功或零写入；
 * - 响应 `no-store`；错误只给稳定码与固定文案，不记录原始 payload。
 */
import {
  applyProviderOperations,
  buildSettingsView,
  currentSettingsRevision,
  parseProviderOperations,
  SETTINGS_SCHEMA_VERSION,
  SettingsValidationError
} from "@/server/ai/model-settings-manager";
import {
  resolveSettingsPaths,
  SettingsStoreError,
  settingsErrorDetail,
  writeSettingsDocument
} from "@/server/ai/model-settings-store";
import {
  configLockPath,
  isAiExecutionEnabled,
  withConfigLock
} from "@/server/ai/model-config";
import { requireBetaAccess } from "@/server/ai/session-http";
import { scopedEnvForModelConfig } from "@/server/ai/user-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 管理请求体上限：两页声明不该有正文级体量。 */
const MAX_BODY_BYTES = 128 * 1024;

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers
    }
  });
}

/** 错误码 → 状态码：请求内容问题 4xx，服务端不可写/损坏 503。 */
const FAILURE_STATUS: Record<string, number> = {
  AI_SETTINGS_INVALID: 400,
  AI_SETTINGS_TOO_LARGE: 413,
  AI_SETTINGS_FORBIDDEN: 403,
  AI_SETTINGS_PRECONDITION_REQUIRED: 428,
  AI_SETTINGS_CONFLICT: 409,
  AI_SETTINGS_BUSY: 409,
  AI_SETTINGS_READONLY: 503,
  AI_SETTINGS_DOC_UNREADABLE: 503,
  AI_SETTINGS_DOC_CORRUPT: 503,
  AI_SETTINGS_KEY_MISSING: 503,
  AI_SETTINGS_DECRYPT_FAILED: 503
};

function failure(code: string, status = FAILURE_STATUS[code] ?? 503): Response {
  return json({ ok: false, code, detail: settingsErrorDetail(code) }, status);
}

/**
 * 管理端点的统一前置检查：本机、同源、网关开关。
 * 判定与 Memory/会话管理端点共用 `requireBetaAccess`，不各写一套 Host/同源规则。
 */
function guard(request: Request): Response | undefined {
  // requireBetaAccess 返回的是 Response（401/403/503）或 undefined——原样透传，
  // 不能与旧 localAdminGuard 的字符串码比较（那会让未认证请求穿透门闸）。
  return requireBetaAccess(request);
}

/** 读取当前文档与管理视图；存储损坏时给出稳定码而不是抛异常。 */
function readView(): { view: ReturnType<typeof buildSettingsView> } | { error: Response } {
  // T2a：文档、凭据呈现与执行开关全部按当前用户 scope 派生，不读全局进程环境。
  const env = scopedEnvForModelConfig() as NodeJS.ProcessEnv;
  const paths = resolveSettingsPaths(env);
  try {
    const { document } = currentSettingsRevision(env, paths);
    // `writable` 表达“当前部署允许写入”：本机单进程、管理授权通过、存储可读；与执行开关独立。
    const view = buildSettingsView(document, env, { writable: true });
    return { view: { ...view, executionEnabled: isAiExecutionEnabled() } };
  } catch (error) {
    if (error instanceof SettingsStoreError) return { error: failure(error.code) };
    return { error: failure("AI_SETTINGS_DOC_CORRUPT") };
  }
}

export async function GET(request: Request): Promise<Response> {
  const denied = guard(request);
  if (denied) return denied;
  const result = readView();
  if ("error" in result) return result.error;
  return json(result.view, 200);
}

export async function PUT(request: Request): Promise<Response> {
  const denied = guard(request);
  if (denied) return denied;

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return failure("AI_SETTINGS_INVALID");
  }

  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
    return failure("AI_SETTINGS_TOO_LARGE");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return failure("AI_SETTINGS_INVALID");
  }

  const baseRevision =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as { baseRevision?: unknown }).baseRevision
      : undefined;

  let operations;
  try {
    operations = parseProviderOperations(payload);
  } catch (error) {
    if (error instanceof SettingsValidationError) return failure(error.code, 400);
    return failure("AI_SETTINGS_INVALID");
  }

  const paths = resolveSettingsPaths(scopedEnvForModelConfig() as NodeJS.ProcessEnv);

  /*
   * 版本校验、读取、写入必须在**同一个受保护范围**内：否则两个标签页各自读到同一版本，
   * 两次都写成功就成了静默覆盖。锁复用既有 `withConfigLock`（同一把锁实现，不另造队列）。
   */
  try {
    return await withConfigLock(configLockPath(paths.document), async () => {
      /*
       * 首次写入：服务端在**受保护范围内**读取并保留两类旧声明，形成同一份权威文档，
       * 再在其上应用本批操作。旧配置 ID 与环境凭据引用不会因为第一次保存而丢失
       * （旧文件与 .env 保持不变，不自动破坏迁移）。
       */
      let current;
      try {
        current = currentSettingsRevision(scopedEnvForModelConfig() as NodeJS.ProcessEnv, paths);
      } catch (error) {
        if (error instanceof SettingsStoreError) return failure(error.code);
        return failure("AI_SETTINGS_DOC_CORRUPT");
      }

      if (typeof baseRevision !== "string" || baseRevision.trim().length === 0) {
        return failure("AI_SETTINGS_PRECONDITION_REQUIRED");
      }
      if (baseRevision.trim() !== current.revision) {
        return failure("AI_SETTINGS_CONFLICT");
      }

      let next;
      try {
        next = applyProviderOperations(current.document, operations);
      } catch (error) {
        if (error instanceof SettingsValidationError) return failure(error.code);
        return failure("AI_SETTINGS_INVALID");
      }

      try {
        writeSettingsDocument({ ...next, schema: SETTINGS_SCHEMA_VERSION }, paths);
        // 文档已成为权威：旧声明快照立即作废，后续读写都以文档为准。

      } catch (error) {
        if (error instanceof SettingsStoreError) return failure(error.code);
        return failure("AI_SETTINGS_READONLY");
      }

      // 写后重新读盘回读：响应是服务端现在的状态，不是把请求体回显当成功。
      const reread = readView();
      if ("error" in reread) return reread.error;
      return json(reread.view, 200);
    });
  } catch (error) {
    // 锁被占用（`withConfigLock` 抛的是既有配置错误码）：如实回 409，让用户稍后重试。
    if (error instanceof Error && error.message.includes("AI_CONFIG_BUSY")) {
      return failure("AI_SETTINGS_BUSY");
    }
    if (error instanceof SettingsStoreError) return failure(error.code);
    return failure("AI_SETTINGS_READONLY");
  }
}
