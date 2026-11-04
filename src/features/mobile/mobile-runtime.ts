/**
 * T4：mobile-runtime——本地页与远端 Next 共用的身份/凭证接缝（任务书 §7.2）。
 *
 * 复用 R 的冻结语义（修复任务书 §4；原型 mobile/src/main.ts A1–A4 已验证）：
 * - **单一凭证队列**：所有系统凭证 IO（读/写/清）与身份提交串行执行；HTTP 不占队列；
 * - **凭证绑定服务**：token 与规范化服务地址成对存储；换服务/登出先清旧凭证；
 * - **none/pending/ready**：token 存在但 whoami 未确认 = pending，不冒充登录；
 * - **代数屏障**：切号/退出/换服务/开始导航都自增代数；迟到回调对比代数与凭证，
 *   不匹配即丢弃，不写新状态；
 * - **迟到 401**：处理前复查代数与当前凭证，旧请求不撤销新身份；
 * - **导航 drain 屏障（T4 新增）**：离开当前页（原生导航/返回/重载/错误回落；同文档
 *   SPA 切换除外）前：拒绝一切新凭证 IO 入队 → 增代数 → 等待在途队列 drain 后才放行。
 *   渲染进程死亡无法 JS drain 时由原生侧小屏障兜底（native-host 职责，见 §7.2）。
 *
 * 边界：token 只存系统安全存储，不进 URL/注入脚本文本/localStorage/日志；
 * 候选地址 health 探测不携带任何凭证。依赖全部注入（原生桥或测试替身），
 * 本文件不 import 任何 @capacitor 模块。
 */

export type IdentityState = "none" | "pending" | "ready";
export type Credential = { token: string; serverBase: string };
export type SessionUser = { id: string; username: string };

export type MobileRuntimeDeps = {
  /** 系统安全存储读取（凭证对：token + 绑定地址）。 */
  readCredential: () => Promise<Credential | null>;
  /** 系统安全存储写入/清除（null = 清除）。 */
  writeCredential: (credential: Credential | null) => Promise<void>;
  /**
   * 会话校验（whoami）。网络失败抛错（= pending，不冒充登录）；
   * 服务端明确拒绝返回 { ok:false }。`serverId` 由实现从会话响应携带
   * （远端页派生命名空间需要；本地页不用）。
   */
  verifySession: (token: string, serverBase: string) => Promise<
    { ok: true; user: SessionUser; serverId?: string } | { ok: false }
  >;
};

export type MobileRuntimeState = {
  generation: number;
  identity: IdentityState;
  serverBase: string | null;
  user: SessionUser | null;
  /** 会话响应携带的服务标识（远端页派生命名空间用；未验证前为 null）。 */
  serverId: string | null;
  /** 导航屏障已升起：拒绝新凭证 IO，等待 drain。 */
  navigationPending: boolean;
};

export function normalizeServerBase(input: string): string {
  let url: URL;
  try {
    url = new URL(String(input || "").trim());
  } catch {
    throw new Error("地址无法解析");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("仅允许 http/https 地址");
  if (url.username || url.password) throw new Error("地址不允许携带用户名密码");
  if (url.search || url.hash) throw new Error("地址不允许携带 query 或 fragment");
  const path = url.pathname.replace(/\/+$/, "");
  return url.origin + path;
}

export function createMobileRuntime(deps: MobileRuntimeDeps) {
  let generation = 1;
  let serverBase: string | null = null;
  let credential: Credential | null = null;
  let user: SessionUser | null = null;
  let serverId: string | null = null;
  let identity: IdentityState = "none";
  let navigationPending = false;

  /** 单一凭证队列：凭证 IO 与身份提交串行；drain 升起后拒绝新入队。 */
  let queueTail: Promise<unknown> = Promise.resolve();
  let queueLength = 0;

  const listeners = new Set<() => void>();
  const notify = () => forListeners((fn) => fn());
  function forListeners(fn: (l: () => void) => void): void {
    for (const listener of [...listeners]) fn(listener);
  }

  function getState(): MobileRuntimeState {
    return { generation, identity, serverBase, user, serverId, navigationPending };
  }
  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /** 当前凭证是否可用于该地址（绑定一致才复用）。 */
  function credentialUsableFor(base: string | null): Credential | null {
    if (!credential || !base) return null;
    try {
      return normalizeServerBase(credential.serverBase) === normalizeServerBase(base) ? credential : null;
    } catch {
      return null;
    }
  }

  /** apiFetch / 远端页取 Bearer：身份 ready 且凭证绑定当前服务才给。 */
  function getBearer(base: string | null = serverBase): { token: string; serverBase: string } | null {
    const usable = credentialUsableFor(base);
    return usable && identity === "ready" ? { token: usable.token, serverBase: usable.serverBase } : null;
  }

  function resetIdentity(): void {
    credential = null;
    user = null;
    serverId = null;
    identity = "none";
    notify();
  }

  /** 身份边界动作：换服务/登出/开始导航。先增代数再清理，迟到回调全部失效。 */
  function beginIdentityChange(): number {
    generation += 1;
    resetIdentity();
    return generation;
  }

  /** 排队执行凭证 IO；导航屏障升起后拒绝新入队（返回 rejected，不排队）。 */
  function enqueue<T>(action: () => Promise<T>): Promise<T> {
    if (navigationPending) {
      return Promise.reject(new Error("NAVIGATION_DRAINING"));
    }
    queueLength += 1;
    const run = queueTail.then(action);
    queueTail = run.then(
      () => undefined,
      () => undefined
    );
    void run.then(() => { queueLength -= 1; }, () => { queueLength -= 1; });
    return run;
  }

  /** 在途凭证 IO 是否已全部结束（屏障放行条件）。 */
  function drained(): boolean {
    return queueLength === 0;
  }

  /**
   * 导航屏障：离开当前页前调用。拒绝新凭证 IO → 增代数（在途回调全部失效）→
   * 等待队列 drain。之后调用方才发起原生导航。
   * T4 复核残留 4：并发返回共享**同一个 drain Promise**——第二次调用不再立即返回
   * （那会让第二次的后退在凭证读取结束前执行），也不会重复增代数；导航整体只发生一次。
   */
  let navigationPromise: Promise<void> | null = null;
  async function beginNavigation(): Promise<void> {
    if (!navigationPromise) {
      navigationPending = true;
      generation += 1;
      resetIdentity();
      notify();
      // 在途 IO 收尾（不排队新任务）：等待队列 drain（队列不新增，必然结束）。
      navigationPromise = (async () => {
        while (!drained()) {
          await queueTail.catch(() => undefined);
        }
      })();
    }
    await navigationPromise;
  }

  /**
   * 导航被取消/失败：**结束并重建导航周期**——清除已完成的 drain Promise，
   * 下一次 beginNavigation 重新冻结入队并等待新的在途 IO。
   * T4 复核二轮残留 3：只置 navigationPending=false 而不清 promise，会让下一次
   * 导航直接 await 已完成的 Promise——既不冻结入队也不等新 IO，屏障被绕过。
   */
  function endNavigation(): void {
    navigationPromise = null;
    navigationPending = false;
    notify();
  }

  /** 迟到 401：只清「仍是这份凭证」的存储；代数或凭证已变则丢弃。 */
  function handleUnauthorized(stale: Credential): Promise<void> {
    const gen = generation;
    return enqueue(async () => {
      if (gen !== generation) return;
      if (credential?.token !== stale.token || credential?.serverBase !== stale.serverBase) return;
      try {
        await deps.writeCredential(null);
      } finally {
        if (gen === generation) {
          generation += 1;
          resetIdentity();
        }
      }
    }).catch(() => undefined);
  }

  /** 启动恢复：读系统凭证 → 绑定核对 → pending → whoami → ready/none。 */
  async function restore(): Promise<IdentityState> {
    const gen = generation;
    const base = serverBase;
    let candidate: Credential | null = null;
    try {
      candidate = await enqueue(async () => {
        if (gen !== generation || base !== serverBase) return null;
        const stored = await deps.readCredential();
        if (gen !== generation || base !== serverBase) return null;
        if (!stored?.token) return null;
        let bound: string | null = null;
        try {
          bound = normalizeServerBase(stored.serverBase);
        } catch {
          return null; // 无效绑定不可复用
        }
        if (!base || bound !== normalizeServerBase(base)) return null;
        credential = { token: stored.token, serverBase: bound };
        user = null;
        identity = "pending";
        notify();
        return credential;
      });
    } catch {
      // 队列拒绝（导航中）或存储读取失败：pending 语义不冒充登录。
      return identity === "ready" ? identity : navigationPending ? "none" : identity;
    }
    if (!candidate) return identity;
    try {
      const result = await deps.verifySession(candidate.token, candidate.serverBase);
      const settled = await enqueue(async () => {
        if (gen !== generation || base !== serverBase || credential?.token !== candidate!.token) return identity;
        if (result.ok) {
          user = result.user;
          serverId = result.serverId ?? null;
          identity = "ready";
        } else {
          // 服务端明确拒绝（过期/撤销）：清存储并回到 none。
          try {
            await deps.writeCredential(null);
          } finally {
            generation += 1;
            resetIdentity();
          }
        }
        return identity;
      });
      notify();
      return settled;
    } catch {
      // 网络不可达：pending（凭证在、身份未确认），旧请求不改新身份。
      return identity;
    }
  }

  /** 登录：先清旧凭证 → 请求登录 → 绑定服务、最后写 token。成功返回 user。 */
  async function login(
    requestLogin: (serverBase: string) => Promise<{ ok: true; token: string; user: SessionUser } | { ok: false }>
  ): Promise<SessionUser | null> {
    const base = serverBase ? normalizeServerBase(serverBase) : null;
    if (!base) return null;
    const gen = beginIdentityChange();
    try {
      await enqueue(() => deps.writeCredential(null));
    } catch (error) {
      // 导航屏障升起：凭证 IO 被拒，登录必须显式失败（不冒充已清场）。
      if ((error as Error)?.message === "NAVIGATION_DRAINING") throw error;
      if (gen === generation && base === serverBase) resetIdentity();
      return null;
    }
    try {
      if (gen !== generation) return null;
      const result = await requestLogin(base);
      if (gen !== generation || base !== serverBase) return null;
      if (!result.ok) return null;
      return await enqueue(async () => {
        if (gen !== generation || base !== serverBase) return null;
        try {
          // 先绑定服务、最后写 token：中途退出不会得到新 token + 旧服务器。
          await deps.writeCredential({ token: result.token, serverBase: base });
        } catch (error) {
          await deps.writeCredential(null).catch(() => undefined);
          throw error;
        }
        if (gen !== generation || base !== serverBase) {
          await deps.writeCredential(null).catch(() => undefined);
          return null;
        }
        credential = { token: result.token, serverBase: base };
        user = result.user;
        identity = "ready";
        notify();
        return user;
      });
    } catch {
      if (gen === generation && base === serverBase) resetIdentity();
      return null;
    }
  }

  /**
   * F8 退出：清本地凭证（串行）→ 通知服务端撤销由调用方附带旧 token 执行。
   * 返回明确结果：安全存储删除失败＝local-clear-failed（不冒充已退出、不导航）；
   * 服务端撤销网络异常＝revoked-unreachable（本地已退出，撤销留待会话过期）。
   */
  async function logout(revokeServerSide?: (stale: Credential) => Promise<void>): Promise<"signed-out" | "local-clear-failed" | "revoked-unreachable"> {
    const departing = credentialUsableFor(serverBase);
    const gen = beginIdentityChange();
    try {
      await enqueue(() => deps.writeCredential(null));
    } catch {
      // F8/R6：清除失败明确返回失败。系统安全存储仍是权威（token 未被删）——
      // 把 departing 恢复到内存投影，重试 logout 才能携带原 token 撤销。
      if (departing && gen === generation) {
        credential = departing;
        identity = "pending";
        notify();
      }
      return "local-clear-failed";
    }
    let revoked = true;
    if (departing && revokeServerSide) {
      try {
        await revokeServerSide(departing);
      } catch {
        revoked = false;
      }
    }
    if (gen === generation) notify();
    return revoked ? "signed-out" : "revoked-unreachable";
  }

  /** 服务地址变化始终构成身份边界：排队清凭证。 */
  async function setServerBase(nextBase: string): Promise<void> {
    const next = normalizeServerBase(nextBase);
    if (next === serverBase) return;
    beginIdentityChange();
    serverBase = next;
    notify();
    try {
      await enqueue(() => deps.writeCredential(null));
    } catch {
      // 保存失败不回滚地址：restore 会因绑定不一致拒绝旧凭证。
    }
    notify();
  }

  /**
   * 初始化地址（恢复路径）：与 `setServerBase`（切换服务 = 身份边界、清凭证）不同——
   * 本方法只登记地址、**绝不清凭证**。远端页从受信导航进入时入口 origin 就是服务地址，
   * 本地页冷启动读回已保存地址：两者都必须先 initialize 再 restore，否则凭证的
   * 服务绑定核对无从进行（T4 复核六）。
   */
  function initializeServerBase(nextBase: string): void {
    serverBase = normalizeServerBase(nextBase);
    notify();
  }

  return {
    getState,
    subscribe,
    getBearer,
    enqueue,
    drained,
    beginNavigation,
    endNavigation,
    handleUnauthorized,
    restore,
    login,
    logout,
    setServerBase,
    initializeServerBase
  };
}

export type MobileRuntime = ReturnType<typeof createMobileRuntime>;
