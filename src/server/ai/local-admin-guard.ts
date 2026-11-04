/**
 * 本机管理端点的共享守卫（从模型设置路由抽出，行为不变）。
 * 两个端点用同一份判定，避免各写一套 Host/同源规则。
 */
import { isUnauthenticatedGatewayAllowed } from "@/server/ai/model-config";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Host 必须是回环地址（含端口）。 */
export function hostIsLoopback(request: Request): boolean {
  const host = request.headers.get("host");
  if (!host) return false;
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return LOOPBACK_HOSTS.has(name.toLowerCase());
}

/** 带 Origin/Referer 时必须与请求同源（跨站写入一律拒绝）。 */
export function originIsSameSite(request: Request): boolean {
  const origin = request.headers.get("origin") ?? request.headers.get("referer");
  if (!origin) return true;
  const host = request.headers.get("host");
  if (!host) return false;
  try {
    const parsed = new URL(origin);
    return parsed.host === host && parsed.protocol === new URL(request.url).protocol;
  } catch {
    return false;
  }
}

/**
 * 本机同源 + 非无认证生产部署。
 * 返回 undefined 表示通过；否则返回稳定的失败原因码（由调用方映射到自己的错误码与文案）。
 */
export function localAdminGuard(request: Request): "forbidden" | "readonly" | undefined {
  if (!hostIsLoopback(request) || !originIsSameSite(request)) return "forbidden";
  if (!isUnauthenticatedGatewayAllowed()) return "readonly";
  return undefined;
}
