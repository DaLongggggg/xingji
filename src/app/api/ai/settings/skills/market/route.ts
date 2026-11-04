import { requireBetaAccess } from "@/server/ai/session-http";
import { readSkillMarket, skillInstallFailure, skillInstallJson } from "@/server/ai/skill-install";
import { skillMarketListing } from "@/features/skills/skill-market";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const denied = requireBetaAccess(request);
  if (denied) return denied;
  try {
    return skillInstallJson({
      ok: true,
      version: 1,
      skills: readSkillMarket().map(skillMarketListing)
    });
  } catch (error) {
    return skillInstallFailure(error);
  }
}
