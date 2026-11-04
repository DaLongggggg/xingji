import { betaReadiness } from "@/server/ai/auth-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 公开健康检查：稳定协议版本、serverId 与非秘密服务标识；不授予任何身份。 */
export function GET(): Response {
  const readiness = betaReadiness();
  return Response.json(
    {
      ok: true,
      name: "xingji",
      protocolVersion: 1,
      serverId: readiness.serverId,
      initialized: readiness.initialized
    },
    { headers: { "cache-control": "no-store" } }
  );
}
