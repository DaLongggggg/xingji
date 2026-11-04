import { readPrivacySettings, savePrivacyPermissions, type AiPrivacyPermissions } from "../../src/features/ai/privacy-client";
import { normalizeServerBase } from "../../src/features/mobile/mobile-runtime";
import type { HttpOptions, HttpResponse } from "@capacitor/core";

/** 包内页不在服务器同源下：只用现有原生HTTP发送这两条Bearer接口，不放宽服务端同源守卫。 */
export function nativePrivacyFetch(base: string, request: (options: HttpOptions) => Promise<HttpResponse>): typeof fetch {
  const server = normalizeServerBase(base);
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method || "GET";
    if (!((url.href === `${server}/api/ai/settings/privacy` && ["GET", "PUT"].includes(method)) || (url.href === `${server}/api/auth/logout` && method === "POST"))) {
      throw new Error("原生隐私请求不在当前服务范围内。");
    }
    init?.signal?.throwIfAborted();
    const headers = Object.fromEntries(new Headers(init?.headers));
    headers.Cookie = "";
    const response = await request({
      url: url.href, method, headers, data: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      responseType: "json", disableRedirects: true, connectTimeout: 8_000, readTimeout: 8_000
    });
    init?.signal?.throwIfAborted();
    if ((response.status >= 300 && response.status < 400) || (response.url && response.url !== url.href)) throw new Error("隐私请求被重定向，未确认保存。");
    return new Response(JSON.stringify(response.data), { status: response.status, headers: { "content-type": "application/json" } });
  };
}

/** 本地登录尚未持久化的新Bearer：同一服务/账户确认许可，失败先撤销再交回runtime。 */
export async function confirmNativePrivacy(base: string, token: string, permissions: AiPrivacyPermissions, fetchImpl: typeof fetch = fetch): Promise<void> {
  const server = normalizeServerBase(base);
  const authorizedFetch: typeof fetch = (input, init) => {
    if (input !== "/api/ai/settings/privacy") return Promise.reject(new Error("隐私请求地址无效。"));
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${token}`);
    return fetchImpl(`${server}${input}`, { ...init, headers, credentials: "omit" });
  };
  try {
    const current = await readPrivacySettings(authorizedFetch);
    await savePrivacyPermissions(current, permissions, authorizedFetch);
  } catch (failure) {
    let revoked = false;
    try {
      const response = await fetchImpl(`${server}/api/auth/logout`, {
        method: "POST", credentials: "omit", signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}"
      });
      revoked = response.ok || response.status === 401;
    } catch { /* 新凭证尚未写入安全存储；保留可见的撤销不确定状态。 */ }
    const detail = failure instanceof Error ? failure.message : "隐私选择未能保存。";
    throw new Error(`${detail} ${revoked ? "本次登录已撤销，请重试。" : "本次登录未保存，服务端退出未确认，请重试。"}`);
  }
}
