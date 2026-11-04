/**
 * App 本地入口：连接、登录与会话恢复，身份确认后直接进入工作区。
 *
 * 职责：
 * - 连接：地址输入 + health 探测（候选地址**永不携带凭证**）；
 * - 登录：mobile-runtime 单一凭证队列（系统安全存储、服务绑定、none/pending/ready、代数）；
 * - 进入远端：会话确认后——runtime.beginNavigation()（拒绝新凭证 IO、drain）→
 *   xingji-host.setTrustedOrigin（唯一可信 origin 登记）→ 顶层导航到
 *   `<origin>/?client=native`（capacitor.config 的 server.allowNavigation 精确命中）。
 * - 恢复：已保存地址 + 系统凭证 → restore（pending 不冒充登录）。
 *
 * 边界：token 只进系统安全存储；地址/账号信息不进日志；能力不足明确显示，
 * 不降级到不安全实现。非原生平台（浏览器预览）禁用登录，不以 Web 存储替代原生验证。
 */
import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import {
  createMobileRuntime,
  normalizeServerBase,
  type MobileRuntimeDeps
} from "../../src/features/mobile/mobile-runtime";
import {
  createNativeCredentialDeps,
  detectHostCapabilities,
  resolveXingjiHostAdapter,
  type HostCapabilities
} from "../../src/features/mobile/native-host";
import { privacyIntroduction, LOGIN_PRIVACY_PERMISSION_NOTICE, PRIVACY_OPTIONAL_NOTICE, PRIVACY_WITHDRAW_NOTICE } from "../../src/features/ai/privacy-content";
import type { AiPrivacyPermissions } from "../../src/features/ai/privacy-client";
import { confirmNativePrivacy, nativePrivacyFetch } from "./privacy";

type User = { id: string; username: string };

const isBrowser = typeof document !== "undefined";
const isNative = Capacitor.isNativePlatform();
const platform = Capacitor.getPlatform();

/** 系统安全存储依赖（capacitor-secure-storage-plugin；读取缺失键返回 null）。 */
let nativeDeps: Promise<MobileRuntimeDeps> | undefined;
function credentialDeps(): Promise<MobileRuntimeDeps> {
  if (!isNative) return Promise.reject(new Error("请使用原生测试包登录"));
  return nativeDeps ??= createNativeCredentialDeps();
}
const runtimeDeps: MobileRuntimeDeps = {
  readCredential: async () => (await credentialDeps()).readCredential(),
  writeCredential: async value => (await credentialDeps()).writeCredential(value),
  verifySession: async (token, base) => (await credentialDeps()).verifySession(token, base)
};

const runtime = createMobileRuntime(runtimeDeps);
let serverBase = "";
let hostCaps: HostCapabilities | null = null;
let loginBusy = false;
let privacyChoices: AiPrivacyPermissions = { ai: false, images: false };

/** health 探测：候选地址永不携带凭证（显式 omit）。 */
async function healthCheck(candidateBase: string, timeoutMs = 8000): Promise<{ ok: boolean; message: string }> {
  let base: string;
  try {
    base = normalizeServerBase(candidateBase);
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}/api/health`, { signal: controller.signal, credentials: "omit" });
    const json = (await response.json().catch(() => ({}))) as { name?: string; serverId?: string; protocolVersion?: number };
    if (response.status === 200 && json.protocolVersion === 1 && json.serverId && typeof json.name === "string") {
      return { ok: true, message: `连接成功（${json.name}）` };
    }
    return { ok: false, message: `非行迹服务（HTTP ${response.status}）` };
  } catch (error) {
    return { ok: false, message: `连接失败：${(error as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}

/** 登录请求（不进 runtime 队列；队列只管凭证 IO）。 */
async function requestLogin(base: string, username: string, password: string) {
  const response = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "omit",
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ username, password, transport: "bearer", deviceLabel: `mobile ${platform}` })
  });
  const json = (await response.json().catch(() => null)) as
    | { token?: string; user?: User; error?: string }
    | null;
  if (response.status === 200 && json?.token && json.user?.id) {
    return { ok: true as const, token: json.token, user: { id: json.user.id, username: json.user.username } };
  }
  return { ok: false as const };
}

function hint(id: string, text: string): void {
  if (!isBrowser) return;
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function render(): void {
  if (!isBrowser) return;
  const state = runtime.getState();
  const ready = state.identity === "ready";
  const form = document.getElementById("login-form");
  if (form) form.hidden = ready;
  for (const id of ["btn-health", "btn-login", "privacy-open", "privacy-agreed"]) {
    const control = document.getElementById(id) as HTMLButtonElement | HTMLInputElement | null;
    if (control) control.disabled = loginBusy || (id === "btn-login" && !isNative);
  }
  for (const id of ["server-input", "username", "password"]) {
    const input = document.getElementById(id) as HTMLInputElement | null;
    if (input) input.readOnly = loginBusy;
  }
  const loginButton = document.getElementById("btn-login");
  if (loginButton) loginButton.textContent = loginBusy ? "正在确认登录…" : "登录行迹";
}

/** 会话确认后的受控导航：drain → 受信登记 → 顶层导航（带 client=native 启动标志，非身份）。 */
async function enterRemote(): Promise<void> {
  if (loginBusy || !isNative || !serverBase || runtime.getState().identity !== "ready") return;
  loginBusy = true;
  hint("status-line", "正在进入工作区…");
  render();
  try {
    if (!hostCaps?.bridgeAvailable || !hostCaps.digestAvailable) throw new Error("原生桥不可用，请重新打开或更新 App。");
    const base = normalizeServerBase(serverBase);
    const adapter = resolveXingjiHostAdapter();
    if (!adapter) throw new Error("原生桥不可用");
    await runtime.beginNavigation();
    await adapter.setTrustedOrigin(new URL(base).origin);
    window.location.replace(`${base}/?client=native`);
  } catch (error) {
    runtime.endNavigation();
    loginBusy = false;
    hint("status-line", `未能进入：${(error as Error).message}`);
    render();
  }
}

async function connect(): Promise<void> {
  if (loginBusy) return;
  const input = (document.getElementById("server-input") as HTMLInputElement).value;
  loginBusy = true;
  render();
  try {
    const result = await healthCheck(input);
    hint("status-line", result.message);
    if (!result.ok) return;
    const base = normalizeServerBase(input);
    if (base !== serverBase) {
      await runtime.setServerBase(base);
      serverBase = base;
      await Preferences.set({ key: "server", value: base }).catch(() => undefined);
    }
    if (isNative && await runtime.restore() === "pending") hint("status-line", "暂时无法确认登录，请稍后重试连接。");
  } catch (error) {
    hint("status-line", `连接未完成：${(error as Error).message}`);
    return;
  } finally {
    loginBusy = false;
    render();
  }
  await enterRemote();
}

async function loginAction(): Promise<void> {
  if (loginBusy) return;
  if (!serverBase) {
    hint("status-line", "请先连接服务器");
    return;
  }
  const username = (document.getElementById("username") as HTMLInputElement).value.trim();
  const password = (document.getElementById("password") as HTMLInputElement).value;
  if (!username || !password) {
    hint("status-line", "请输入用户名与密码");
    return;
  }
  if (!(document.getElementById("privacy-agreed") as HTMLInputElement).checked) {
    hint("status-line", "请先阅读并同意隐私协议。");
    return;
  }
  const choices = { ...privacyChoices };
  let privacyFailure = "";
  loginBusy = true;
  render();
  try {
    const user = await runtime.login(async base => {
      const result = await requestLogin(base, username, password);
      if (!result.ok) return result;
      try {
        await confirmNativePrivacy(base, result.token, choices, nativePrivacyFetch(base, options => CapacitorHttp.request(options)));
        return result;
      } catch (error) {
        privacyFailure = error instanceof Error ? error.message : "隐私选择未能保存，请重试。";
        return { ok: false as const };
      }
    });
    if (user) (document.getElementById("password") as HTMLInputElement).value = "";
    else hint("status-line", privacyFailure || "登录失败，请检查连接、账户和系统安全存储后重试。");
  } catch {
    hint("status-line", "登录暂未完成，请稍后重试。");
  } finally {
    loginBusy = false;
    render();
  }
  await enterRemote();
}

async function main(): Promise<void> {
  if (!isBrowser) return;
  const viewport = window.visualViewport;
  if (viewport) {
    const syncViewport = () => {
      document.documentElement.style.setProperty("--native-viewport-height", `${viewport.height}px`);
      document.documentElement.style.setProperty("--native-viewport-top", `${viewport.pageTop}px`);
    };
    const resizeViewport = () => {
      syncViewport();
      const pane = document.querySelector<HTMLElement>(".page");
      const active = document.activeElement;
      if (!pane || !(active instanceof HTMLInputElement) || !pane.contains(active)) return;
      const field = active.getBoundingClientRect(), bounds = pane.getBoundingClientRect();
      if (field.bottom > bounds.bottom - 16) pane.scrollBy(0, field.bottom - bounds.bottom + 16);
      else if (field.top < bounds.top + 16) pane.scrollBy(0, field.top - bounds.top - 16);
    };
    syncViewport();
    viewport.addEventListener("resize", resizeViewport);
    viewport.addEventListener("scroll", syncViewport);
  }
  const agreementCheckbox = document.getElementById("privacy-agreed") as HTMLInputElement;
  const aiPermission = document.getElementById("privacy-ai") as HTMLInputElement;
  const imagePermission = document.getElementById("privacy-images") as HTMLInputElement;
  hint("privacy-note", LOGIN_PRIVACY_PERMISSION_NOTICE);
  agreementCheckbox.addEventListener("change", () => {
    privacyChoices = { ai: agreementCheckbox.checked, images: agreementCheckbox.checked };
    aiPermission.checked = privacyChoices.ai;
    imagePermission.checked = privacyChoices.images;
  });
  // T4 复核七：统一经薄适配器访问插件（Capacitor.Plugins.XingjiHost 形状）。
  hostCaps = detectHostCapabilities(resolveXingjiHostAdapter());
  if (isNative && !hostCaps.bridgeAvailable) {
    hint("status-line", "无法初始化 App，请重新打开或更新安装包。");
  }
  try {
    const saved = await Preferences.get({ key: "server" });
    const configured = (window as unknown as { __XINGJI_BETA_CONFIG__?: { server?: string } }).__XINGJI_BETA_CONFIG__?.server;
    if (saved.value || configured) serverBase = normalizeServerBase(saved.value || configured!);
  } catch {
    /* 浏览器预览无插件 */
  }
  if (serverBase) {
    (document.getElementById("server-input") as HTMLInputElement).value = serverBase;
    // T4 复核六：冷启动恢复前先初始化地址（不清凭证）——否则凭证绑定核对无从进行。
    runtime.initializeServerBase(serverBase);
    if (isNative && await runtime.restore() === "pending") hint("status-line", "暂时无法连接服务器，请检查地址或稍后重试。");
  }
  document.getElementById("btn-health")?.addEventListener("click", () => void connect());
  document.getElementById("login-form")?.addEventListener("submit", event => { event.preventDefault(); void loginAction(); });
  const dialog = document.getElementById("privacy-dialog") as HTMLDialogElement;
  const agreementButton = document.getElementById("privacy-open") as HTMLButtonElement;
  const closePrivacy = () => { dialog.close(); agreementButton.focus(); };
  const introduction = document.getElementById("privacy-introduction")!;
  for (const paragraph of privacyIntroduction(true)) {
    const p = document.createElement("p");
    p.textContent = paragraph;
    introduction.append(p);
  }
  hint("privacy-optional", PRIVACY_OPTIONAL_NOTICE);
  hint("privacy-withdraw", PRIVACY_WITHDRAW_NOTICE);
  agreementButton.addEventListener("click", () => {
    aiPermission.checked = privacyChoices.ai;
    imagePermission.checked = privacyChoices.images;
    dialog.showModal();
  });
  document.getElementById("privacy-close")?.addEventListener("click", closePrivacy);
  dialog.addEventListener("cancel", event => { event.preventDefault(); closePrivacy(); });
  dialog.addEventListener("click", event => {
    const bounds = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) closePrivacy();
  });
  document.getElementById("privacy-confirm")?.addEventListener("click", () => {
    privacyChoices = { ai: aiPermission.checked, images: imagePermission.checked };
    agreementCheckbox.checked = true;
    closePrivacy();
  });
  const passwordInput = document.getElementById("password") as HTMLInputElement;
  const passwordToggle = document.getElementById("password-toggle") as HTMLButtonElement;
  passwordToggle.addEventListener("click", () => {
    const visible = passwordInput.type === "password";
    passwordInput.type = visible ? "text" : "password";
    passwordToggle.setAttribute("aria-label", visible ? "隐藏密码" : "显示密码");
    passwordToggle.setAttribute("aria-pressed", String(visible));
    passwordToggle.title = visible ? "隐藏密码" : "显示密码";
  });
  render();
  await enterRemote();
}

void main();
