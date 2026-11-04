import { apiFetch } from "@/lib/api-client";

export type AiPrivacyPermissions = { ai: boolean; images: boolean };
export type PrivacyView = {
  revision: string;
  permissions: AiPrivacyPermissions;
  available: boolean;
  imagesAvailable: boolean;
};

const ENDPOINT = "/api/ai/settings/privacy";

function valid(value: unknown): value is PrivacyView {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const view = value as Partial<PrivacyView> & { ok?: unknown };
  return view.ok === true && typeof view.revision === "string" && view.revision.length > 0 &&
    typeof view.available === "boolean" && typeof view.imagesAvailable === "boolean" &&
    typeof view.permissions?.ai === "boolean" && typeof view.permissions?.images === "boolean";
}

function detail(value: unknown, fallback: string): string {
  if (value && typeof value === "object" && "detail" in value && typeof value.detail === "string" && value.detail) {
    return value.detail;
  }
  return fallback;
}

async function requestPrivacy(init: RequestInit, action: "读取" | "保存", fetchImpl: typeof fetch): Promise<PrivacyView> {
  const signal = AbortSignal.timeout(15_000);
  try {
    const response = await fetchImpl(ENDPOINT, { ...init, signal });
    const data: unknown = await response.json().catch(() => null);
    if (signal.aborted) throw Error();
    if (!response.ok || !valid(data)) {
      throw Error(detail(data, action === "读取" ? "无法读取隐私选择，请重试。" : "隐私选择保存结果未确认，请重试。"));
    }
    return data;
  } catch (error) {
    if (signal.aborted) throw Error(`${action}隐私选择超时，请检查网络后重试。`);
    throw error;
  }
}

/** 两个登录入口共用同一账户许可接口，不保留另一份持久化选择。 */
export async function readPrivacySettings(fetchImpl: typeof fetch = apiFetch): Promise<PrivacyView> {
  return requestPrivacy({ cache: "no-store" }, "读取", fetchImpl);
}

export async function savePrivacyPermissions(view: PrivacyView, permissions: AiPrivacyPermissions, fetchImpl: typeof fetch = apiFetch): Promise<PrivacyView> {
  if ((!view.permissions.ai && permissions.ai && !view.available) ||
    (!view.permissions.images && permissions.images && (!view.available || !view.imagesAvailable))) {
    throw Error("当前服务不允许开启此功能，请取消对应许可后重试。");
  }
  const selected = { ai: permissions.ai, images: permissions.images };
  const data = await requestPrivacy({
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ revision: view.revision, permissions: selected })
  }, "保存", fetchImpl);
  if (data.permissions.ai !== selected.ai || data.permissions.images !== selected.images) {
    throw Error("保存的隐私选择与本次确认不一致，请重试。");
  }
  return data;
}
