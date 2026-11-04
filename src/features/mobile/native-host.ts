/**
 * T4：native-host——远端 Next 页内的原生桥探针（任务书 §7.1/§7.2）。
 *
 * 职责：
 * - **桥探针**：检测 xingji-host 插件是否真实注册（不能因 Capacitor 检测为 web
 *   就静默创建浏览器存储后宣称原生通过——桥缺失必须明确失败）；
 * - **能力探测**：isSecureContext / crypto.subtle / randomUUID / getRandomValues
 *   在 LAN HTTP 下的真实可用性；SHA-256 不可用时走插件受控摘要方法（不用
 *   FNV/Math.random 冒充摘要或安全随机）；
 * - **受控标记**：本地页与远端页对同一受控标记读写一致（同库/同目录证明）。
 *
 * 边界：本文件只声明接缝与浏览器侧探测；插件方法的真实可用性由原生切片验证，
 * 未验证的能力如实返回 unavailable，不虚构通过。
 */

export type NativeBridge = {
  /** 唯一可信远端 origin 更新（只有本地页可调用；远端页不得扩展信任）。 */
  setTrustedOrigin(origin: string): Promise<void>;
  /** 受控标记读写（同库/同目录一致性证明用；非秘密）。 */
  getMarker(key: string): Promise<string | null>;
  setMarker(key: string, value: string): Promise<void>;
  /** 原生 SHA-256 摘要（hex）；crypto.subtle 不可用时的唯一替代路径。 */
  sha256Hex(bytes: Uint8Array): Promise<string>;
  /** 原生安全随机（hex）。 */
  randomHex(byteLength: number): Promise<string>;
  /**
   * 受控返回包内入口（T4 复核残留 3）：WebView 顶层直接加载本地页并清历史，
   * 不依赖 back 栈（远端页的 fragment 链接会把 history.back 困在远端）。
   */
  navigateToLocal(): Promise<void>;
};

export type HostCapabilities = {
  bridgeAvailable: boolean;
  secureContext: boolean;
  subtleCrypto: boolean;
  randomUUID: boolean;
  getRandomValues: boolean;
  /** subtle 不可用但插件摘要可用 = 受控降级路径；两者都不可 = 明确失败。 */
  digestAvailable: boolean;
};

/**
 * T4 复核七：本地页与远端页共用的**薄适配器**。原生插件经 Capacitor 注册
 * （`window.Capacitor.Plugins.XingjiHost`），方法参数是对象、结果是带字段的对象
 * （`{origin}`、`{dataBase64}`→`{hex}`、`{byteLength}`→`{hex}`）——调用方不直接摸
 * 原始形状。也接受直接挂 `window.XingjiHost` 的测试替身（方法签名与本适配器一致）。
 */
export type XingjiHostAdapter = NativeBridge;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function resolveXingjiHostAdapter(): XingjiHostAdapter | null {
  const capacitor = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean; Plugins?: Record<string, unknown> } }).Capacitor;
  const raw = capacitor?.Plugins?.XingjiHost ?? (globalThis as Record<string, unknown>).XingjiHost;
  if (!raw || typeof raw !== "object") return null;
  const plugin = raw as Record<string, (arg?: unknown) => Promise<unknown>>;
  const call = <T,>(name: string, arg: Record<string, unknown>): Promise<T> => {
    if (typeof plugin[name] !== "function") return Promise.reject(new Error("BRIDGE_METHOD_MISSING"));
    return Promise.resolve(plugin[name](arg)) as Promise<T>;
  };
  return {
    setTrustedOrigin: (origin) => call("setTrustedOrigin", { origin }).then(() => undefined),
    getMarker: (key) =>
      call<{ value?: string | null }>("getMarker", { key }).then((result) => result?.value ?? null),
    setMarker: (key, value) => call("setMarker", { key, value }).then(() => undefined),
    sha256Hex: (bytes) =>
      call<{ hex?: string }>("sha256Hex", { dataBase64: bytesToBase64(bytes) }).then((r) => {
        if (!r?.hex) throw new Error("BRIDGE_RESULT_INVALID");
        return r.hex;
      }),
    randomHex: (byteLength) =>
      call<{ hex?: string }>("randomHex", { byteLength }).then((r) => {
        if (!r?.hex) throw new Error("BRIDGE_RESULT_INVALID");
        return r.hex;
      }),
    navigateToLocal: () => call("navigateToLocal", {}).then(() => undefined)
  };
}

export function detectGlobalBridge(): NativeBridge | null {
  const adapter = resolveXingjiHostAdapter();
  if (!adapter) return null;
  const ok =
    typeof adapter.setTrustedOrigin === "function" &&
    typeof adapter.getMarker === "function" &&
    typeof adapter.setMarker === "function" &&
    typeof adapter.sha256Hex === "function" &&
    typeof adapter.randomHex === "function" &&
    typeof adapter.navigateToLocal === "function";
  return ok ? adapter : null;
}

export function detectHostCapabilities(bridge: NativeBridge | null = detectGlobalBridge()): HostCapabilities {
  const crypto = (globalThis as { crypto?: Crypto }).crypto;
  const secureContext = typeof window !== "undefined" ? window.isSecureContext === true : false;
  const subtleCrypto = !!crypto?.subtle && typeof crypto.subtle.digest === "function";
  const randomUUID = typeof crypto?.randomUUID === "function";
  const getRandomValues = !!crypto && typeof crypto.getRandomValues === "function";
  return {
    bridgeAvailable: bridge !== null,
    secureContext,
    subtleCrypto,
    randomUUID,
    getRandomValues,
    digestAvailable: subtleCrypto || (!!bridge && typeof bridge.sha256Hex === "function")
  };
}

/** 摘要统一出口：subtle 可用走标准路径；否则走插件受控摘要；都没有就明确失败。 */
export async function digestBytes(bytes: Uint8Array, bridge: NativeBridge | null): Promise<string> {
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (subtle) {
    const buffer = await subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
    return Array.from(new Uint8Array(buffer), (b: number) => b.toString(16).padStart(2, "0")).join("");
  }
  if (bridge) return bridge.sha256Hex(bytes);
  throw new Error("DIGEST_UNAVAILABLE");
}

/** 安全随机统一出口：randomUUID/getRandomValues 都不可用走插件；不降级 Math.random。 */
export async function randomToken(byteLength: number, bridge: NativeBridge | null): Promise<string> {
  const crypto = (globalThis as { crypto?: Crypto }).crypto;
  if (crypto?.getRandomValues) {
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b: number) => b.toString(16).padStart(2, "0")).join("");
  }
  if (bridge) return bridge.randomHex(byteLength);
  throw new Error("RANDOM_UNAVAILABLE");
}

/**
 * 远端业务挂载前置（§7.2）：原生模式下，只有桥探针与能力探测都就绪才允许
 * mount 业务；桥缺失（即使 Capacitor 检测为 web）必须返回 false 让页面明确失败。
 */
export function nativeBusinessReady(bridge: NativeBridge | null): boolean {
  const caps = detectHostCapabilities(bridge);
  return caps.bridgeAvailable && caps.digestAvailable && caps.getRandomValues;
}

/**
 * T4 复核八：受控返回本地包内页。优先走**原生导航接缝**（插件
 * `navigateToLocal`：WebView 顶层直接加载包内入口并清历史——不依赖 back 栈，
 * 远端页的错误摘要 fragment 链接不会把后退困在远端）；handler 由原生启动流程
 * 注册（携带 runtime 的 drain）。T4 复核残留 4：并发调用（返回按钮 + 迟到 401）
 * 只执行**一次**导航。
 * T4 复核二轮残留 5（P2）：无桥时**区分**两种情况——纯浏览器（无 Capacitor）
 * 才允许 history.back；原生模式缺桥（启动失败正包含此情况）不猜历史目的地，
 * 抛 NATIVE_BACK_FAILED 让页面保持失败态并提供重启恢复指引。
 */
let nativeBackHandler: (() => Promise<void>) | null = null;
/**
 * T4 复核三轮残留 2：显式原生启动模式（URL `client=native` 且业务树已按原生
 * 流程装配）。置位后，无桥返回**一律**失败态——即使 Capacitor 未注入或
 * isNativePlatform() 返回 false（两者都可能是注入失败的表现），不猜 history 目的地。
 */
let nativeClientMode = false;

export function setNativeClientMode(enabled: boolean): void {
  nativeClientMode = enabled;
}

export function setNativeBackHandler(handler: (() => Promise<void>) | null): void {
  nativeBackHandler = handler;
}

let nativeBackStarted = false;

export async function nativeBackWithDrain(): Promise<void> {
  if (nativeBackStarted) return;
  nativeBackStarted = true;
  try {
    if (nativeBackHandler) {
      await nativeBackHandler();
    }
    const adapter = resolveXingjiHostAdapter();
    if (adapter?.navigateToLocal) {
      await adapter.navigateToLocal();
      return;
    }
    const capacitor = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
    const isNative = nativeClientMode || capacitor?.isNativePlatform?.() === true;
    if (isNative) {
      // 显式原生启动但桥缺失/未注入：返回不可靠（fragment 历史可能困在远端）——
      // 保持失败态，由页面给出重启恢复指引；不猜 history 的目的地。
      throw new Error("NATIVE_BACK_FAILED");
    }
    if (typeof window !== "undefined" && window.history.length > 1) {
      window.history.back();
      return;
    }
    nativeBackStarted = false;
    throw new Error("NATIVE_BACK_FAILED");
  } catch {
    // 导航失败：允许重试（留在当前页显示失败状态）。
    nativeBackStarted = false;
    throw new Error("NATIVE_BACK_FAILED");
  }
}

/**
 * 原生凭证依赖（T4）：远端 Next 页内 mobile-runtime 的系统存储后端。
 * 动态 import capacitor 插件（根工程按 mobile 实际锁定版本安装，§7.2）——
 * 桌面 Web 构建不携带原生路径；Web 实现一律不用（原生模式由 nativeBusinessReady 把关）。
 */
export async function createNativeCredentialDeps(
  verifyEndpoint = "/api/auth/session"
): Promise<import("./mobile-runtime").MobileRuntimeDeps> {
  const { SecureStoragePlugin } = await import("capacitor-secure-storage-plugin");
  const removeKey = async (key: string): Promise<void> => {
    try { await SecureStoragePlugin.remove({ key }); }
    catch (error) {
      if (String((error as { message?: string })?.message || error) !== "Item with given key does not exist") throw error;
    }
  };
  const readPair = async (): Promise<{ token: string; serverBase: string } | null> => {
    try {
      const token = (await SecureStoragePlugin.get({ key: "beta_token" })).value || null;
      const serverBase = (await SecureStoragePlugin.get({ key: "beta_token_server" })).value || null;
      return token && serverBase ? { token, serverBase } : null;
    } catch (error) {
      if (String((error as { message?: string })?.message || error) === "Item with given key does not exist") {
        return null;
      }
      throw new Error("系统安全存储读取失败");
    }
  };
  return {
    readCredential: readPair,
    writeCredential: async (credential) => {
      if (credential) {
        // 先绑定服务、最后写 token（与本地页同一顺序，中断不成新 token+旧服务器）。
        await SecureStoragePlugin.set({ key: "beta_token_server", value: credential.serverBase });
        await SecureStoragePlugin.set({ key: "beta_token", value: credential.token });
      } else {
        await removeKey("beta_token");
        await removeKey("beta_token_server");
      }
    },
    verifySession: async (token, serverBase) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(new URL(verifyEndpoint, serverBase + "/").href, {
          headers: { authorization: `Bearer ${token}` },
          credentials: "omit",
          cache: "no-store",
          signal: controller.signal
        });
        if (response.status === 401) return { ok: false };
        if (!response.ok) throw new Error("SESSION_UNAVAILABLE");
        const json = (await response.json().catch(() => null)) as
          | { user?: { id?: string; username?: string }; serverId?: string }
          | null;
        if (!json?.user?.id || !json.user?.username) return { ok: false };
        return {
          ok: true,
          user: { id: json.user.id, username: json.user.username },
          ...(typeof json.serverId === "string" && json.serverId ? { serverId: json.serverId } : {})
        };
      } finally {
        clearTimeout(timer);
      }
    }
  };
}
