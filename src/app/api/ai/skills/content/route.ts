/**
 * `GET /api/ai/skills/content`：read_skill 工具的受控读取端点（阶段B）。
 *
 * - 仅本机同源（`requireBetaAccess`），响应 `no-store`；
 * - 只接受 id + `SKILL.md`/`references/*.md` + 字符窗口；路径穿越、根外符号链接、
 *   脚本、URL 与停用资源都明确报错（fail closed），不做静默回退。
 */
import { requireBetaAccess } from "@/server/ai/session-http";
import { readSkillDoc } from "@/server/ai/skill-catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

const STATUS_BY_CODE: Record<string, number> = {
  SKILL_NOT_FOUND: 404,
  SKILL_DISABLED: 403,
  SKILL_PATH_INVALID: 400,
  SKILL_UNREADABLE: 503,
  SKILL_STATE_UNREADABLE: 503
};

export async function GET(request: Request): Promise<Response> {
  // requireBetaAccess 返回的是 Response（401/403/503）或 undefined——原样透传。
  const denied = requireBetaAccess(request);
  if (denied) return denied;
  const params = new URL(request.url).searchParams;
  const id = params.get("id") ?? "";
  const path = params.get("path") ?? undefined;
  const offsetRaw = params.get("offset");
  const limitRaw = params.get("limit");
  const offset = offsetRaw === null ? undefined : Number(offsetRaw);
  const limit = limitRaw === null ? undefined : Number(limitRaw);
  if ((offsetRaw !== null && (!Number.isInteger(offset) || (offset as number) < 0))
    || (limitRaw !== null && (!Number.isInteger(limit) || (limit as number) < 1))) {
    return json({ ok: false, code: "SKILL_PATH_INVALID", detail: "offset/limit 必须是正整数。" }, 400);
  }
  const result = await readSkillDoc({
    id,
    ...(path !== undefined ? { path } : {}),
    ...(offset !== undefined ? { offset } : {}),
    ...(limit !== undefined ? { limit } : {})
  });
  if (!result.ok) return json(result, STATUS_BY_CODE[result.code] ?? 503);
  return json(result);
}
