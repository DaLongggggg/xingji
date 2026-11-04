import { isSemanticSearchEnabled } from "@/features/ai/search-chunks";
import { embeddingResponse } from "@/server/ai/embedding-gateway";
import { requireBetaAccess } from "@/server/ai/session-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = (request: Request) =>
  requireBetaAccess(request) ??
  (isSemanticSearchEnabled()
    ? embeddingResponse(request)
    : Response.json(
        { enabled: false, reason: "paused" },
        { headers: { "cache-control": "no-store" } }
      ));
export const POST = (request: Request) =>
  requireBetaAccess(request) ??
  (isSemanticSearchEnabled()
    ? embeddingResponse(request)
    : Response.json(
        { error: "语义搜索暂未启用。" },
        { status: 503, headers: { "cache-control": "no-store" } }
      ));
