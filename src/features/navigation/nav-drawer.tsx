"use client";

import { useDismissableLayer } from "@/lib/dismissable-layer";

import { useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { BookOpen, MapPinned, PanelLeft, NotebookPen, Settings, X, type LucideIcon } from "lucide-react";
import type { AppView } from "@/features/app/app-store";
import { AuthNavigationContext } from "@/features/auth/auth-navigation";

type NavigationItem = {
  id: AppView;
  label: string;
  /** 手机端显示名：抽屉更窄，保留入口原义即可。 */
  shortLabel?: string;
  icon: LucideIcon;
};

/** 主入口：全局导航顺序固定为地图 → 笔记本 → AI 工作台 → 设置（020 规则）。 */
export const PRIMARY_NAV_ITEMS: NavigationItem[] = [
  { id: "home", label: "地图", icon: MapPinned },
  { id: "notebook", label: "笔记本", shortLabel: "笔记", icon: BookOpen },
  { id: "record", label: "AI 工作台", shortLabel: "AI", icon: NotebookPen },
  { id: "settings", label: "设置", icon: Settings }
];

/** 手机底栏容量有限：只保留四个主入口。 */
export const MOBILE_NAV_ITEMS: NavigationItem[] = PRIMARY_NAV_ITEMS;

const FOCUSABLE =
  "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

const subscribeHydration = () => () => {};
/** Compact windows include touch-first phone landscape, without changing desktop windows. */
export const MOBILE_LAYOUT_QUERY = "(max-width: 780px), (pointer: coarse) and (max-height: 600px) and (max-width: 1100px)";
const subscribeMobile = (notify: () => void) => {
  const query = window.matchMedia(MOBILE_LAYOUT_QUERY);
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
};

/**
 * 019：全站统一的左侧导航抽屉。
 *
 * - 所有页面共用同一套组件与开关机制，不再各页复制导航；
 * - 模态语义：`role="dialog" aria-modal`，打开时 Tab 焦点锁在抽屉内，
 *   关闭后焦点回到触发按钮；Escape 与遮罩都可关闭；
 * - 抽屉内的导航不冒泡给地图容器，避免触发拖动/缩放/选择。
 */
export function useNavDrawer() {
  const hydrated = useSyncExternalStore(subscribeHydration, () => true, () => false);
  const [layout, setLayout] = useState({ open: false, width: 280, restored: false });
  const { open, width } = layout;
  const setOpen = (value: boolean | ((current: boolean) => boolean)) => setLayout(current => ({ ...current, open: typeof value === "function" ? value(current.open) : value }));
  const setWidth = (width: number) => setLayout(current => ({ ...current, width }));
  const mobile = useSyncExternalStore(subscribeMobile, () => window.matchMedia(MOBILE_LAYOUT_QUERY).matches, () => false);
  if (hydrated && !layout.restored) {
    let saved: { open?: unknown; width?: unknown } | null = null;
    try { saved = JSON.parse(localStorage.getItem("xingji-nav-layout-v1") ?? "null"); } catch { /* Keep defaults. */ }
    setLayout({ open: typeof saved?.open === "boolean" ? saved.open : false,
      width: typeof saved?.width === "number" && Number.isFinite(saved.width) ? Math.max(220, Math.min(420, saved.width)) : 280, restored: true });
  }
  useEffect(() => {
    if (!layout.restored) return;
    try { localStorage.setItem("xingji-nav-layout-v1", JSON.stringify({ open, width })); } catch { /* UI remains usable. */ }
  }, [open, width, layout.restored]);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);

  /**
   * 关闭后把焦点交还给「开关」。
   * 手机上开关是顶栏菜单按钮；桌面收起后顶栏按钮已隐藏（改由导航栏 logo 开关），
   * 此时若仍强行 focus 会落到 body，键盘用户就丢失了位置，因此回退到 logo。
   */
  function focusToggle() {
    const trigger = buttonRef.current;
    if (trigger && trigger.getClientRects().length > 0) {
      trigger.focus();
      return;
    }
    drawerRef.current?.querySelector<HTMLElement>(".nav-drawer-brand")?.focus();
  }

  function close() {
    setOpen(false);
    requestAnimationFrame(focusToggle);
  }

  function toggle() {
    setOpen((current) => !current);
  }

  useEffect(() => {
    if (!open) return;
    /* 手机端品牌按钮只做 CSS 隐藏，仍留在 DOM；按可见性过滤后才不会吞掉初始焦点与 Tab 回绕。 */
    const focusables = () => Array.from(drawerRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
      .filter(node => node.getClientRects().length > 0);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !mobile) return;
      const nodes = focusables();
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    focusables()[0]?.focus();
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [open, mobile]);

  useDismissableLayer(drawerRef, open && mobile, close);

  return { open, toggle, close, buttonRef, drawerRef, width, setWidth, mobile };
}

export type NavMenuButtonProps = {
  open: boolean;
  onToggle: () => void;
  buttonRef: RefObject<HTMLButtonElement | null>;
  className?: string;
};

/** 左上角菜单按钮：地图页与其它页面共用同一外观与语义。 */
export function NavMenuButton({ open, onToggle, buttonRef, className }: NavMenuButtonProps) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className={className ?? "map-menu-button"}
      aria-label="打开导航菜单"
      aria-expanded={open}
      aria-controls="app-nav-drawer"
      onClick={onToggle}
    >
      {open ? <X size={18} /> : <PanelLeft size={18} strokeWidth={1.7} />}
    </button>
  );
}

export type NavDrawerProps = {
  width?: number;
  onWidthChange?: (width: number) => void;
  mobile?: boolean;
  open: boolean;
  onClose: () => void;
  onToggle: () => void;
  activeView: AppView;
  onNavigate: (view: AppView) => void;
  drawerRef: RefObject<HTMLDivElement | null>;
  /** 遮罩层标记，手机点遮罩关闭。 */
  scrimTestId?: string;
};

/** 左侧导航抽屉主体：主入口 + 辅助功能 + 旧版工具与数据恢复入口。 */
export function NavDrawer({
  width = 280,
  onWidthChange,
  mobile = false,
  open,
  onClose,
  onToggle,
  activeView,
  onNavigate,
  drawerRef,
  scrimTestId = "nav-drawer-scrim"
}: NavDrawerProps) {
  // 抽屉内的交互不冒泡：地图页下不会触发 Leaflet 的拖动/缩放/选择。
  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();
  const account = useContext(AuthNavigationContext);
  const footer = (
    <div className="nav-settings-bottom"><button type="button" className="nav-button" aria-label="设置" title="设置" aria-haspopup="dialog" onClick={() => onNavigate("settings")}><Settings size={19} aria-hidden /><span>设置</span></button></div>
  );
  return (
    <>
      {open && mobile ? (
        <div
          className={scrimClassName()}
          role="presentation"
          onClick={onClose}
          data-testid={scrimTestId}
        />
      ) : null}
      <div
        ref={drawerRef}
        id="app-nav-drawer"
        className={open ? "nav-drawer is-open" : "nav-drawer"}
        role={mobile ? "dialog" : "complementary"}
        aria-modal={open && mobile ? "true" : undefined}
        aria-label="导航菜单"
        onPointerDown={stop}
        onWheel={stop}
        onKeyDown={stop}
      >
        <div className="nav-drawer-head">
          {/*
            桌面收起后顶栏不再保留专门的菜单按钮，改由这里的 logo 开关导航
            （收起态点它展开，展开态点它收起）。可访问名称随状态切换：
            收起时叫「打开导航菜单」，避免与顶栏按钮同时出现两个同名控件。
          */}
          <button
            type="button"
            className="nav-drawer-brand"
            aria-label={open ? "收起导航菜单" : "打开导航菜单"}
            title={open ? "收起导航菜单" : "打开导航菜单"}
            aria-expanded={open}
            onClick={onToggle}
          >
            <span className="brand-mark">
              <MapPinned size={20} aria-hidden="true" />
            </span>
          </button>
          <strong>行迹</strong>
          <button
            type="button"
            className="nav-drawer-close"
            onClick={onClose}
            aria-label="关闭菜单"
            title="关闭菜单"
          >
            <X size={18} />
          </button>
        </div>
        <nav aria-label="主入口">
          {PRIMARY_NAV_ITEMS.filter(item => item.id !== "settings").map(item => {
            const Icon = item.icon;
            /* 手机抽屉更窄：显示短名，视图 id 与回调不变。 */
            const label = mobile ? item.shortLabel ?? item.label : item.label;
            return (
              <button
                key={item.id}
                type="button"
                data-nav-view={item.id}
                className={activeView === item.id ? "nav-button is-active" : "nav-button"}
                /*
                 * 桌面收起成图标轨道时文字会隐藏，因此用 aria-label 提供稳定的
                 * 可访问名称：收起/展开两种状态下读屏与测试拿到的名字一致。
                 */
                aria-label={label}
                title={label}
                onClick={() => onNavigate(item.id)}
                aria-current={activeView === item.id ? "page" : undefined}
              >
                <Icon size={19} aria-hidden="true" />
                <span>{label}</span>
              </button>
            );
          })}
        </nav>
        {/*
          020-A 修正：抽屉只保留四个主入口（地图/AI 工作台/笔记本/设置）。
          推荐/推荐地图/转盘与旧版工具不再作为顶层导航展示——
          旧页面入口暂时隐藏，专用实现归档到 legacy；不删除旧数据。
        */}
        <div className="nav-footer">{footer}{account}</div>
        {!mobile && onWidthChange && (
          <div
            className="nav-resize-handle"
            role="separator"
            aria-label="调整导航栏宽度"
            aria-orientation="vertical"
            aria-valuemin={220}
            aria-valuemax={420}
            aria-valuenow={width}
            tabIndex={0}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
              onWidthChange(Math.max(220, Math.min(420, event.clientX)));
            }}
            onPointerUp={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId))
                event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              onWidthChange(
                event.key === "Home"
                  ? 220
                  : event.key === "End"
                    ? 420
                    : Math.max(220, Math.min(420, width + (event.key === "ArrowRight" ? 10 : -10)))
              );
            }}
          />
        )}
      </div>
    </>
  );
}

function scrimClassName(): string {
  return "drawer-scrim";
}

/** 手机底栏：抽屉打开时隐藏，避免与模态遮罩同时出现两层导航。 */
export function MobileNavigation({
  activeView,
  onNavigate
}: {
  activeView: AppView;
  onNavigate: (view: AppView) => void;
}): ReactNode {
  return (
    <nav className="mobile-navigation" aria-label="手机端导航">
      {MOBILE_NAV_ITEMS.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          className={activeView === id ? "is-active" : ""}
          onClick={() => onNavigate(id)}
        >
          <Icon size={19} />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}
