import { requireBetaAccess } from "@/server/ai/session-http";
import { readJsonBodyWithinLimit } from "@/server/ai/skill-settings";
import {
  installSkillChoices,
  skillInstallFailure,
  skillInstallJson
} from "@/server/ai/skill-install";
import { SkillInstallError } from "@/features/skills/skill-package";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const denied = requireBetaAccess(request);
  if (denied) return denied;
  try {
    if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json")
      throw new SkillInstallError("SKILL_INVALID", "安装请求格式无效。");
    const read = await readJsonBodyWithinLimit(request, 12 * 1024 * 1024);
    if (!read.ok)
      throw new SkillInstallError(
        read.code === "AI_SKILL_BODY_TOO_LARGE" ? "SKILL_LIMIT" : "SKILL_INVALID",
        "安装请求过长或格式无效。"
      );
    return skillInstallJson(await installSkillChoices(read.value));
  } catch (error) {
    return skillInstallFailure(error);
  }
}
