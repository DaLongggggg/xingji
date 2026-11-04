"use client";

/**
 * T1 认证边界（连续实施任务书 §4.1）：挂载时查询会话；未登录渲染登录表单，
 * 已登录渲染 children。401 会话过期事件回到登录态。
 *
 * T4：`client=native`（远端 WebView 内）不使用 Cookie 边界——身份由本地页经
 * mobile-runtime 建立并注入 Bearer（apiFetch 单一接缝），这里只透传 children；
 * 401 过期事件表示凭证已失效，整页返回本地连接页（重新登录/重连），不显示表单。
 */
import { createContext, useCallback, useEffect, useRef, useState } from "react";
import { fetchSession, logout, type SessionInfo } from "./auth-client";
import { LoginChecking, LoginScreen } from "./login-screen";
import { nativeBackWithDrain } from "@/features/mobile/native-host";
import { LogOut, UserRound } from "lucide-react";
import { AuthNavigationContext } from "./auth-navigation";

function isNativeClient(): boolean {
  return typeof window !== "undefined" && new URLSearchParams(window.location.search).get("client") === "native";
}

type AuthState =
  | { phase: "checking" }
  | { phase: "anonymous"; expired?: true }
  | { phase: "connection-error" }
  | { phase: "ready"; session: SessionInfo };

export const AuthSessionContext = createContext<SessionInfo | null>(null);

export function AuthBoundary({ children }: { children: React.ReactNode }): React.ReactElement {
  const native = isNativeClient();
  const [state, setState] = useState<AuthState>({ phase: "checking" });
  const signingOut = useRef(false);
  const query = useRef<AbortController | null>(null);
  const [queryVersion, setQueryVersion] = useState(0);
  const expired = state.phase === "anonymous" && state.expired === true;

  useEffect(() => {
    if (!expired) return;
    const timer = setTimeout(() => setState(current => current.phase === "anonymous" ? { phase: "anonymous" } : current), 1_500);
    return () => clearTimeout(timer);
  }, [expired]);

  useEffect(() => {
    if (!native) return;
    // 原生：身份闸门在 XingjiApp 的 native boot（桥探针 + mobile-runtime restore）。
    const onExpired = () => {
      // T4 复核八：凭证失效——受控返回本地包内页（drain 后 history.back），
      // 不导航去远端 origin 的 `/`（那会丢 client=native 并落入 Cookie 链）。
      void nativeBackWithDrain();
    };
    window.addEventListener("xingji:session-expired", onExpired);
    return () => window.removeEventListener("xingji:session-expired", onExpired);
  }, [native]);

  useEffect(() => {
    if (native) return;
    const controller = new AbortController();
    query.current = controller;
    void fetchSession({ signal: controller.signal }).then(session => {
      if (controller.signal.aborted || query.current !== controller) return;
      if (session.ok) setState({ phase: "ready", session });
      else if (session.error) setState({ phase: "connection-error" });
      else if (!session.cancelled) setState({ phase: "anonymous", ...(session.expired ? { expired: true as const } : {}) });
    });
    const onExpired = () => {
      if (signingOut.current) return;
      controller.abort();
      setState(current => current.phase === "ready" || current.phase === "checking" ? { phase: "anonymous", expired: true } : current);
    };
    window.addEventListener("xingji:session-expired", onExpired);
    return () => {
      controller.abort();
      if (query.current === controller) query.current = null;
      window.removeEventListener("xingji:session-expired", onExpired);
    };
  }, [native, queryVersion]);

  const refresh = () => {
    query.current?.abort();
    setState({ phase: "checking" });
    setQueryVersion(value => value + 1);
  };

  const signOut = useCallback(async () => {
    if (signingOut.current) return;
    signingOut.current = true;
    query.current?.abort();
    try {
      await logout().catch(() => undefined);
      setState({ phase: "anonymous" });
    } finally {
      signingOut.current = false;
    }
  }, []);

  if (native) return <>{children}</>;
  if (state.phase === "connection-error") return <LoginChecking connectionError onRetry={refresh} />;
  if (state.phase === "checking") {
    return <LoginChecking />;
  }
  if (state.phase === "anonymous") {
    return <LoginScreen sessionExpired={expired} onSignedIn={refresh} />;
  }
  return (
    <AuthSessionContext.Provider value={state.session}>
    <AuthNavigationContext.Provider value={(
      <div className="nav-account">
        <div className="nav-account-identity" title={state.session.user.username}>
          <UserRound size={18} aria-hidden="true" />
          <span className="nav-account-name">{state.session.user.username}</span>
        </div>
        <button
          type="button"
          className="auth-signout"
          aria-label={`退出登录（${state.session.user.username}）`}
          title={`退出登录（${state.session.user.username}）`}
          onClick={() => void signOut()}
        >
          <LogOut size={20} aria-hidden="true" />
        </button>
      </div>
    )}>
      {children}
    </AuthNavigationContext.Provider>
    </AuthSessionContext.Provider>
  );
}
