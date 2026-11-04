import { handleSession } from "@/server/ai/auth-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
  return handleSession(request);
}
