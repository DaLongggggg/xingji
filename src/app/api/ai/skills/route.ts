/**
 * `GET /api/ai/skills`：按需 Skill 的轻量目录（阶段B）。
 *
 * - 仅本机同源（`requireBetaAccess`），响应 `no-store`，不回传本机绝对路径或正文；
 * - 目录来自统一 `.local/skills/`（或配置根） 直接子目录的**文件系统发现**，没有 TS 常量清单；
 * - 只有元数据（id/name/description/状态/SKILL.md 摘要），正文走 `/api/ai/skills/content`。
 * - 已移除项仅留在管理视图供恢复，不进入工作台/Agent 的调用目录。
 */
import { requireBetaAccess } from "@/server/ai/session-http";
import { scanSkillCatalog } from "@/server/ai/skill-catalog";
import { SkillSettingsError, readSkillStates } from "@/server/ai/skill-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

export async function GET(request: Request): Promise<Response> {
  // requireBetaAccess 返回的是 Response（401/403/503）或 undefined——原样透传。
  const denied = requireBetaAccess(request);
  if (denied) return denied;
  let states;
  try {
    states = readSkillStates();
  } catch (error) {
    // 状态读不出按不可用处理（fail closed），与设置端点同一文案口径。
    const unreadable = error instanceof SkillSettingsError;
    return json({ ok: false, detail: unreadable ? "本机 Skill 状态无效，已停止读取。" : "无法读取 Skill 设置，请重试。" }, 503);
  }
  try {
    const skills = (await scanSkillCatalog(process.cwd(), states))
      .filter(skill => states[skill.id] !== "removed");
    return json({ ok: true, skills });
  } catch {
    return json({ ok: false, detail: "Skill 目录扫描失败，请重试。" }, 503);
  }
}
