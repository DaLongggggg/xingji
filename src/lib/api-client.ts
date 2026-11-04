type ApiSuccess<T> = { data: T; meta: { requestId: string } };
type ApiFailure = { error: { code: string; message: string; requestId: string } };

export class ApiClientError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly requestId?: string
  ) {
    super(message);
  }
}

/**
 * T1 起私有 API 的受控认证入口（连续实施任务书 §6 T2a 扩展）：
 * 桌面浏览器走同源 Cookie；只对同源相对路径的私有 API 附带凭证，
 * 不对外链/健康检查/图片搜索源附加任何 Authorization（T4 原生 Bearer 在此单一接缝注入）。
 * 401 时广播会话过期，由认证边界回到登录态，不自动重试。
 */
export async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(url, init);
  const payload = (await response.json()) as ApiSuccess<T> | ApiFailure;
  if (!response.ok || "error" in payload) {
    const failure = payload as ApiFailure;
    throw new ApiClientError(
      failure.error?.message ?? "请求失败",
      failure.error?.code ?? "UNKNOWN",
      failure.error?.requestId
    );
  }
  return payload.data;
}

/**
 * T4：原生 Bearer 的**单一注入点**。原生模式下由应用装配（xingji-app）注册——
 * 提供者来自 mobile-runtime（系统安全存储、服务绑定、代数屏障）；只对**同源相对
 * 路径**的私有 API 附带 Authorization，绝不给外链/健康检查/图片搜索源带 Bearer，
 * 不 monkey-patch 全局 fetch。桌面（未注册）行为与 T2a 完全一致。
 */
type BearerProvider = () => { token: string; serverBase: string } | null;
let bearerProvider: BearerProvider | null = null;
let unauthorizedHandler: ((credential: { token: string; serverBase: string }) => Promise<void>) | null = null;

export function setBearerProvider(provider: BearerProvider | null, onUnauthorized?: typeof unauthorizedHandler): void {
  bearerProvider = provider;
  unauthorizedHandler = onUnauthorized ?? null;
}

/**
 * T2a：`fetch` 形状的受控认证入口——所有私有 API 客户端的**默认**出站通道。
 * 同源相对路径附带同源凭证（原生模式下再按注册的提供者附 Bearer）；
 * 绝对地址（外链/健康检查/图片搜索源）一律 `credentials:"omit"` 且不注入 Bearer。
 * 401 统一广播会话过期。不 monkey-patch 全局 fetch：客户端仍可显式注入 fetchImpl（测试用），
 * 只是默认值从裸 fetch 换成这一层。
 */
export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
  const relative = url.startsWith("/") && !url.startsWith("//");
  const privateApi = relative && /^\/api\/(?:ai|agent|auth)(?:\/|$)/.test(url);
  // 桌面/未注册提供者时 headers 原样透传（不物化，保持调用方形状与既有断言）；
  // 只有原生 Bearer 真正注入时才构造 Headers。
  let headers = init?.headers ?? (typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined);
  const native = bearerProvider !== null;
  const snapshot = privateApi ? bearerProvider?.() ?? null : null;
  if (privateApi && native) {
    if (!snapshot) throw new ApiClientError("请重新登录后继续。", "SESSION_UNAVAILABLE");
    if (typeof window !== "undefined" && new URL(snapshot.serverBase).origin !== window.location.origin) {
      throw new ApiClientError("服务器地址已变化，请返回连接页。", "SERVER_BINDING_MISMATCH");
    }
      const merged = new Headers(headers);
      merged.set("authorization", `Bearer ${snapshot.token}`);
      headers = merged;
  }
  const response = await fetch(input, { ...init, headers, credentials: native || !relative ? "omit" : "same-origin" });
  if (privateApi && response.status === 401 && typeof window !== "undefined") {
    const current = bearerProvider?.();
    if (!native || (snapshot && current?.token === snapshot.token && current.serverBase === snapshot.serverBase)) {
      if (snapshot) await unauthorizedHandler?.(snapshot);
      // A late failure cannot navigate away from a newer login.
      if (!native || !bearerProvider?.()) window.dispatchEvent(new CustomEvent("xingji:session-expired"));
    }
  }
  return response;
}
