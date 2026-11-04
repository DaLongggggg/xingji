type RateEntry = {
  count: number;
  resetAt: number;
};

const requests = new Map<string, RateEntry>();

/**
 * 进程内轻量限流，仅保护个人演示部署。
 *
 * 多实例公开部署启用付费 AI 前，应替换为共享存储限流。
 */
export function checkRateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const existing = requests.get(key);
  if (!existing || existing.resetAt <= now) {
    requests.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (existing.count >= limit) {
    return false;
  }
  existing.count += 1;
  return true;
}

export function getClientKey(request: Request, scope: string): string {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return `${scope}:${forwardedFor || "local"}`;
}
