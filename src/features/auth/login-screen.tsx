"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ArrowRight, CircleAlert, Eye, EyeOff, LoaderCircle } from "lucide-react";
import { login, logout, type SessionInfo } from "./auth-client";
import { readPrivacySettings, savePrivacyPermissions, type AiPrivacyPermissions } from "@/features/ai/privacy-client";
import { PrivacyAgreement } from "./privacy-agreement";
import { LOGIN_PRIVACY_PERMISSION_NOTICE } from "@/features/ai/privacy-content";

const LOGIN_ERRORS: Record<string, string> = {
  LOGIN_FAILED: "用户名或密码不正确，请重新输入。",
  LOGIN_LOCKED: "登录失败次数过多，账户已临时锁定，请稍后再试。",
  LOGIN_RATE_LIMITED: "尝试过于频繁，请稍后再试。",
  PEER_UNTRUSTED: "当前访问入口无法登录，请使用行迹服务启动时提供的访问地址。"
};

function LoginBrand() {
  return (
    <div className="auth-brand">
      <span className="auth-brand-mark" aria-hidden="true" />
      <span>行迹<small>XINGJI</small></span>
    </div>
  );
}

export function LoginChecking({ connectionError = false, onRetry }: { connectionError?: boolean; onRetry?: () => void }) {
  return (
    <main className="auth-boundary auth-checking">
      <LoginBrand />
      {connectionError ? <>
        <p role="alert">无法连接行迹服务，请检查网络后重试。</p>
        <button type="button" className="auth-submit" onClick={onRetry}>重试</button>
      </> : <p role="status"><LoaderCircle className="auth-spinner" size={18} aria-hidden="true" />正在检查登录状态…</p>}
    </main>
  );
}

/** 两个浏览器入口共用展示与提交；会话/导航仍由各入口掌握。 */
export function LoginScreen({
  onSignedIn,
  sessionExpired = false
}: {
  onSignedIn: (user: SessionInfo["user"]) => void;
  sessionExpired?: boolean;
}) {
  const id = useId();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [privacyAgreed, setPrivacyAgreed] = useState(false);
  const [permissions, setPermissions] = useState<AiPrivacyPermissions>({ ai: false, images: false });
  const submitting = useRef(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const privacyLinkRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  async function submit(form: FormData) {
    if (submitting.current) return;
    if (!privacyAgreed) {
      setError("请先阅读并同意隐私协议。");
      return;
    }
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await login(String(form.get("username") || ""), String(form.get("password") || ""), "桌面浏览器");
      if (!result.ok) {
        setError(LOGIN_ERRORS[result.error] || "暂时无法登录，请稍后重试。");
      } else {
        try {
          const current = await readPrivacySettings();
          await savePrivacyPermissions(current, permissions);
        } catch (failure) {
          const detail = failure instanceof Error ? failure.message : "隐私选择未能保存。";
          try {
            await logout({ requireConfirmation: true });
            setError(`${detail} 本次登录已退出，请调整选择或重试。`);
          } catch {
            setError(`${detail} 退出状态未能确认，请重试登录。`);
          }
          return;
        }
        onSignedIn(result.user);
      }
    } catch {
      setError("连接未成功，请检查网络后重试。");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <main className="auth-boundary">
      {sessionExpired ? <div className="auth-expiry-toast" role="status" aria-live="polite" aria-atomic="true"><CircleAlert size={20} aria-hidden="true" /><span>登录已过期，请重新登录。</span></div> : null}
      <div className="auth-shell">
        <aside className="auth-story" aria-label="行迹旅行笔记">
          <LoginBrand />
          <div className="auth-story-copy">
            <p className="auth-eyebrow ui-secondary-copy">沿途所见，皆为珍藏</p>
            <h2>把旅途，<br />留在身边。</h2>
            <p className="ui-secondary-copy">一张照片，一段文字。<br />让走过的地方，有迹可循。</p>
          </div>
          <svg className="auth-journey" viewBox="0 0 480 230" fill="none" aria-hidden="true">
            <path className="auth-contour" d="M-30 195C60 61 103 254 216 155S361 32 510 98M-30 164C67 33 107 221 209 127S367 4 510 68M-30 132C72 0 114 190 204 98S370-25 510 38" />
            <path className="auth-route" d="M65 170C104 95 180 205 235 135S301 60 398 67" />
            <circle className="auth-route-point" cx="65" cy="170" r="6" />
            <circle className="auth-route-halo" cx="398" cy="67" r="15" />
            <circle className="auth-route-point" cx="398" cy="67" r="6" />
          </svg>
          <p className="auth-story-footer ui-secondary-copy">旅行笔记 <span> / </span> 地图里的回忆</p>
        </aside>

        <section className="auth-panel" aria-labelledby={`${id}-title`}>
          <header className="auth-heading" title="登录你的行迹账户">
            <p className="auth-eyebrow ui-secondary-copy">旅程继续</p>
            <h1 id={`${id}-title`}>欢迎回来</h1>
            <p className="ui-secondary-copy">登录你的行迹账户</p>
          </header>
          <form
            className="auth-form"
            aria-busy={busy}
            aria-describedby={error ? `${id}-error` : undefined}
            onSubmit={(event) => {
              event.preventDefault();
              void submit(new FormData(event.currentTarget));
            }}
          >
            <div className="auth-field">
              <label htmlFor={`${id}-username`}>用户名</label>
              <input id={`${id}-username`} name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder="请输入用户名" required minLength={3} readOnly={busy} />
            </div>
            <div className="auth-field">
              <label htmlFor={`${id}-password`}>密码</label>
              <div className="auth-password">
                <input id={`${id}-password`} name="password" type={showPassword ? "text" : "password"} autoComplete="current-password" placeholder="请输入密码" required readOnly={busy} />
                <button type="button" className="auth-password-toggle" aria-label={showPassword ? "隐藏密码" : "显示密码"} title={showPassword ? "隐藏密码" : "显示密码"} aria-pressed={showPassword} aria-controls={`${id}-password`} onClick={() => setShowPassword((visible) => !visible)}>
                  {showPassword ? <EyeOff size={19} aria-hidden="true" /> : <Eye size={19} aria-hidden="true" />}
                </button>
              </div>
            </div>
            <div className="auth-privacy-consent">
              <label><input type="checkbox" name="privacyAgreement" checked={privacyAgreed} disabled={busy} required aria-describedby={`${id}-privacy-note`}
                onChange={event => {
                  const agreed = event.target.checked;
                  setPrivacyAgreed(agreed);
                  setPermissions({ ai: agreed, images: agreed });
                  setError("");
                }} />我已阅读并同意</label>
              <button ref={privacyLinkRef} type="button" className="auth-privacy-link" disabled={busy} title="阅读隐私协议，选择AI与图片许可" aria-haspopup="dialog" onClick={() => setPrivacyOpen(true)}>《隐私协议》</button>
              <p id={`${id}-privacy-note`} className="auth-privacy-note">{LOGIN_PRIVACY_PERMISSION_NOTICE}</p>
            </div>
            {privacyAgreed ? <button type="button" className="auth-privacy-link" disabled={busy} onClick={() => setPrivacyOpen(true)}>AI{permissions.ai ? "已允许" : "未允许"} · 图片{permissions.images ? "已允许" : "未允许"}（调整）</button> : null}
            {error ? (
              <p className="auth-error" id={`${id}-error`} role="alert" tabIndex={-1} ref={errorRef}>
                <CircleAlert size={18} aria-hidden="true" /><span>{error}</span>
              </p>
            ) : null}
            <button className="auth-submit" type="submit" disabled={busy} title="登录行迹">
              {busy ? <><LoaderCircle className="auth-spinner" size={18} aria-hidden="true" />登录中…</> : <>登录行迹<ArrowRight size={18} aria-hidden="true" /></>}
            </button>
          </form>
          <p className="auth-help">还没有账户？请联系此服务的管理员。</p>
        </section>
      </div>
      {privacyOpen ? <PrivacyAgreement permissions={permissions} returnFocusRef={privacyLinkRef} onClose={() => setPrivacyOpen(false)} onConfirm={value => {
        setPermissions(value);
        setPrivacyAgreed(true);
        setPrivacyOpen(false);
        setError("");
      }} /> : null}
    </main>
  );
}
