"use client";

import { useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useAppInteractions } from "@/lib/dismissable-layer";
import { HomeCapture } from "@/features/capture/home-capture";
import {
  assignCapturesToPage,
  createNotebookPageFromCaptures,
  type CaptureAssignmentOutcome
} from "@/features/capture/capture-assignment";
import { useCaptureArchive } from "@/features/capture/use-capture-archive";
import {
  AtlasSlot,
  type AtlasPageSummary,
  type AtlasRegionCounts
} from "@/features/atlas/atlas-slot";
import {
  readAtlasMapStyle,
  saveAtlasMapStyle,
  type AtlasMapStyle
} from "@/features/atlas/map-style";
import { NavDrawer, NavMenuButton, useNavDrawer } from "@/features/navigation/nav-drawer";
import { SettingsDialog } from "@/features/settings/settings-dialog";
import { readUiTheme, saveUiTheme, type UiTheme } from "./ui-theme";
import { SettingsPage } from "@/features/settings/settings-page";
import { NotebookPageView } from "@/features/notebook/notebook-page";
import { useNotebookArchive } from "@/features/notebook/use-notebook-archive";
import { isPageDeleted, listTrash, listVisibleNotebooks } from "@/features/notebook/notebook-model";
import { createIndexedDbAiRepository } from "@/features/ai/ai-repository";
import { createAiGatewayCaller } from "@/features/ai/ai-gateway-client";
import { PageDetailPanel } from "@/features/notebook/page-detail-panel";
import {
  aggregateRegions,
  provinceOnlyPages as listProvinceOnlyPages
} from "@/features/regions/region-aggregate";
import { selectRegionCover } from "@/features/regions/region-memory";
import type { MemoryNote } from "@/features/atlas/region-card-layout";
import { wgs84ToGcj02 } from "@/features/regions/gcj02";
import {
  ensureCoverThumbnails,
  selectNeededThumbnailUrls,
  type CoverThumbnailCache,
  type CoverThumbnailNeed
} from "@/features/regions/cover-thumbnails";
import { listProvinces } from "@/features/regions/region-catalog";
import { REGION_CATALOG } from "@/features/regions/region-catalog";
import { WorkbenchConnected } from "@/features/workbench/workbench-connected";
import { useWorkbenchStore } from "@/features/workbench/workbench-store";
import { scoreQuickNotes } from "@/features/workbench/workbench-search";
import {
  describeScope,
  type WorkbenchNotebook,
  type WorkbenchScope
} from "@/features/workbench/workbench-types";
import { createNavigationGate } from "./navigation-gate";
import { AuthSessionContext } from "@/features/auth/auth-boundary";
import { createMobileRuntime, type MobileRuntime } from "@/features/mobile/mobile-runtime";
import {
  createNativeCredentialDeps,
  detectGlobalBridge,
  nativeBackWithDrain,
  nativeBusinessReady,
  setNativeBackHandler,
  setNativeClientMode
} from "@/features/mobile/native-host";
import { apiFetch, setBearerProvider } from "@/lib/api-client";
import { digestBytes, resolveXingjiHostAdapter } from "@/features/mobile/native-host";
import { openNativeDatabase, type NativeActor, type NativeDatabase } from "@/features/mobile/native-database";
import { NativeFiles, createNativeFilePort } from "@/features/mobile/native-files";
import { createNativeRepositories, recoverPendingCleanups } from "@/features/mobile/native-repositories";
import { createNativeBackup, restoreNativeBackup } from "@/features/mobile/native-backup";
import { collectSkillSnapshots } from "@/features/mobile/mobile-task-client";
import { skillDownloadFromPreviewResponse } from "@/features/skills/skill-package";
import { createNativeWorkbenchStore } from "@/features/mobile/native-workbench-store";
import { createMobileTaskClient, recoverPendingAcknowledgments, recoverUnclaimedResults } from "@/features/mobile/mobile-task-client";
import { randomToken } from "@/features/mobile/native-host";
import {
  getNotebookLeaveGuard,
  getWorkbenchLeaveGuard,
  setNotebookLeaveGuard,
  useAppStore,
  type AppView
} from "./app-store";

/**
 * T2a：账号命名空间（serverId/userId）。业务树在会话派生完成前**不挂载**——
 * Notebook/Capture/Ai 仓储都由它派生独立 IDB 名，未定名空间时绝不打开任何库，
 * 旧单用户档案不会被读取或继承。登出/切号 = 整棵树重挂载，各仓储实例与原账号绑定。
 *
 * T4：`client=native`（受信远端 WebView 内）改走 native boot——桥探针 + 原生
 * 凭证依赖的 mobile-runtime restore；ready 才注册 Bearer 提供者（apiFetch 单一
 * 接缝）并挂载业务；桥缺失/pending/未登录都明确停留失败页，不回退 Web 存储。
 */
function isNativeClient(): boolean {
  return typeof window !== "undefined" && new URLSearchParams(window.location.search).get("client") === "native";
}

function useAccountNamespace(enabled: boolean): { serverId: string; userId: string } | null {
  const session = useContext(AuthSessionContext);
  return enabled && session ? { serverId: session.serverId ?? "local", userId: session.user.id } : null;
}

type NativeWorkspaceResources = {
  actor: NativeActor;
  database: NativeDatabase;
  files: NativeFiles;
  repositories: ReturnType<typeof createNativeRepositories>;
  workbench: ReturnType<typeof createNativeWorkbenchStore>;
  runtime: ReturnType<typeof import("@/features/mobile/mobile-runtime").createMobileRuntime>;
  skills: ReturnType<typeof import("@/features/mobile/native-skill-store").createNativeSkillStore>;
};

type NativeBoot =
  | { phase: "checking" }
  | { phase: "ready"; runtime: MobileRuntime; namespace: { serverId: string; userId: string }; resources: NativeWorkspaceResources }
  | { phase: "failed"; reason: string };

function useNativeBoot(enabled: boolean): NativeBoot {
  const [boot, setBoot] = useState<NativeBoot>({ phase: "checking" });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let runtimeRef: MobileRuntime | null = null;
    // T4 复核三轮残留 2：登记显式原生启动模式——无桥返回保持失败态（不后退）。
    setNativeClientMode(true);
    // T4 复核八：注册受控返回（先 drain 再回包内页）。
    setNativeBackHandler(() =>
      runtimeRef ? runtimeRef.beginNavigation().catch(() => undefined) : Promise.resolve()
    );
    void (async () => {
      try {
        const bridge = detectGlobalBridge();
        if (!nativeBusinessReady(bridge)) {
          setBoot({ phase: "failed", reason: "原生桥缺失或能力不足：请使用本任务生成的安装包进入（不回退 Web 存储）。" });
          return;
        }
        const runtime = createMobileRuntime(await createNativeCredentialDeps());
        runtimeRef = runtime;
        // T4 复核六：受信导航的入口 origin 就是服务地址——先初始化（不清凭证）
        // 再 restore；凭证的服务绑定核对依赖这个地址。
        runtime.initializeServerBase(window.location.origin);
        const state = await runtime.restore();
        if (cancelled) return;
        if (state !== "ready") {
          setBoot({
            phase: "failed",
            reason:
              state === "pending"
                ? "凭证待恢复（服务不可达或安全存储不可读）：请回到连接页重试。"
                : "未登录：请回到连接页登录。"
          });
          return;
        }
        const settled = runtime.getState();
        if (!settled.serverId || !settled.user) throw new Error("原生会话缺少服务或账号标识，请重新连接。");
        const database = await openNativeDatabase();
        const actor = await database.account({ serverId: settled.serverId, userId: settled.user.id }, () => randomToken(16, bridge));
        const files = new NativeFiles(database, await createNativeFilePort());
        const repositories = createNativeRepositories(database, files, actor);
        const { createNativeSkillStore } = await import("@/features/mobile/native-skill-store");
        const skills = createNativeSkillStore(database, actor, { assertCurrent: () => {
          if (cancelled || runtime.getState().navigationPending) throw new Error("NATIVE_ACTOR_STALE");
        } });
        const workbench = createNativeWorkbenchStore(database, files, actor, { assertCurrent: () => {
          if (cancelled || runtime.getState().navigationPending) throw new Error("NATIVE_ACTOR_STALE");
        } });
        // Confirm the native filesystem port in this same realm; no original bytes are preloaded.
        await files.port.list(await files.namespace(actor));
        if (cancelled) { files.releaseObjectUrls(actor); return; }
        setBearerProvider(() => runtime.getBearer(), stale => runtime.handleUnauthorized(stale));
        setBoot({
          phase: "ready",
          runtime,
          namespace: { serverId: settled.serverId, userId: settled.user.id },
          resources: { actor, database, files, repositories, workbench, runtime, skills }
        });
        // F7：清理仍挂起的已清空命名空间（即时清理失败的持久重试；成功才删记录）。
        void recoverPendingCleanups(database, files, { serverId: settled.serverId, userId: settled.user.id }).catch(() => undefined);
        // T6a 恢复：①本地收据已 ACK 但服务端 ACK 可能因退出未到达——按原收据只补 ACK；
        // ②交付前退出时 awaiting_ack 结果留在服务端——重开后按原归属领取交付。
        void (async () => {
          const client = createMobileTaskClient({ digest: bytes => digestBytes(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes, bridge) });
          const ports = { client, repositories, actor, datasetId: actor.datasetId };
          const recovered = await recoverUnclaimedResults({
            ...ports,
            files,
            digest: bytes => digestBytes(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes, bridge),
            findPendingAssistantMessageId: async (chatSessionId) => {
              try {
                const record = await workbench.sessionApi.read(chatSessionId);
                const pending = [...record.payload.messages].reverse().find(m => m.role === "assistant" && m.status === "pending");
                return pending?.id ?? null;
              } catch { return null; }
            }
          });
          const reAcked = await recoverPendingAcknowledgments(ports);
          if (recovered.recovered || recovered.failed || reAcked.confirmed || reAcked.skipped) {
            console.info(`[t6a-recover] claimed=${recovered.recovered}/${recovered.recovered + recovered.failed} reAcked=${reAcked.confirmed}/${reAcked.confirmed + reAcked.skipped}`);
          }
        })().catch((error) => {
          console.error("[t6a-recover] 恢复流程失败", error instanceof Error ? error.message : error);
        });
      } catch (error) {
        if (!cancelled) {
          setBoot({ phase: "failed", reason: `原生启动失败：${(error as Error).message}` });
        }
      }
    })();
    return () => {
      cancelled = true;
      setNativeClientMode(false);
      setNativeBackHandler(null);
      setBearerProvider(null);
    };
  }, [enabled]);
  return boot;
}

/** 原生失败页：受控返回本地包内页（drain 后经原生接缝导航）；无桥原生保持失败态并给出重启恢复。 */
function NativeBootFailed({ reason }: { reason: string }): React.ReactElement {
  const [backError, setBackError] = useState("");
  return (
    <div className="xingji-boot-failed" role="alert">
      <p>{reason}</p>
      {backError ? (
        <p>无法自动返回连接页。请完全退出应用后重新打开（冷启动始终回到包内连接页），再从连接页开始。</p>
      ) : null}
      <button
        type="button"
        onClick={() => {
          nativeBackWithDrain().catch((error: unknown) => {
            setBackError((error as Error)?.message ?? "返回失败");
          });
        }}
      >
        返回连接页
      </button>
    </div>
  );
}

export function XingjiApp() {
  const nativeClient = isNativeClient();
  const nativeBoot = useNativeBoot(nativeClient);
  // 桌面：命名空间未定时渲染引导壳；原生：桥探针与 restore 完成前同样零开库。
  const desktopNamespace = useAccountNamespace(!nativeClient);
  const namespace = nativeClient
    ? nativeBoot.phase === "ready"
      ? nativeBoot.namespace
      : null
    : desktopNamespace;
  /*
   * T2a 复核一：工作台 Store 是模块单例（跨组件卸载存活）。挂载新账号业务树
   * **之前**同步清空上一账号的会话投影并登记账号；此后迟到的水合/保存回执由
   * store 的账号守卫整体丢弃。
   */
  if (namespace && (useWorkbenchStore.getState().accountId !== namespace.userId || useWorkbenchStore.getState().serverId !== namespace.serverId)) {
    useWorkbenchStore.getState().resetForAccount(namespace.userId, namespace.serverId);
  }
  if (nativeClient) {
    if (nativeBoot.phase !== "ready") {
      return nativeBoot.phase === "failed" ? (
        <NativeBootFailed reason={nativeBoot.reason} />
      ) : (
        <div className="xingji-boot" aria-busy="true" />
      );
    }
    return <XingjiWorkspace key={JSON.stringify(nativeBoot.resources.actor)} namespace={nativeBoot.namespace} native={nativeBoot.resources} />;
  }
  if (!desktopNamespace) {
    return <div className="xingji-boot" aria-busy="true" />;
  }
  return <XingjiWorkspace key={JSON.stringify(desktopNamespace)} namespace={desktopNamespace} />;
}

function XingjiWorkspace({ namespace, native }: { namespace: { serverId: string; userId: string }; native?: NativeWorkspaceResources }) {
  useAppInteractions();
  useEffect(() => {
    if (!native) return;
    const back = (event: Event) => {
      if (event.defaultPrevented) return;
      // Reuse the visible notebook Back action, including its draft and save behavior.
      const button = [...document.querySelectorAll<HTMLButtonElement>(".notebook-page[data-mobile-layout='true'] .nb-mobile-back")]
        .find(node => node.getClientRects().length > 0);
      if (!button) return;
      event.preventDefault();
      // Acknowledge native Back before a rich editor unmount can occupy the renderer.
      window.setTimeout(() => { if (button.isConnected && button.getClientRects().length) button.click(); }, 0);
    };
    document.addEventListener("xingji:native-back", back);
    return () => document.removeEventListener("xingji:native-back", back);
  }, [native]);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!native || !viewport) return;
    const root = document.documentElement;
    let frame = 0;
    const sync = () => {
      root.style.setProperty("--native-viewport-height", `${viewport.height}px`);
      root.style.setProperty("--native-viewport-top", `${viewport.pageTop}px`);
      const pane = document.querySelector<HTMLElement>(".app-shell[data-native-storage] .app-main:has(.notebook-page)");
      const active = document.activeElement;
      if (!pane || !(active instanceof HTMLElement) || !pane.contains(active) || getComputedStyle(pane).position !== "fixed") return;
      const selection = window.getSelection();
      const caret = active.isContentEditable && selection?.rangeCount && selection.focusNode && active.contains(selection.focusNode)
        ? selection.getRangeAt(0).getBoundingClientRect()
        : active.matches("input, textarea") ? active.getBoundingClientRect() : null;
      if (!caret?.height) return;
      const bounds = pane.getBoundingClientRect();
      const style = getComputedStyle(pane);
      const top = bounds.top + parseFloat(style.scrollPaddingTop);
      const bottom = bounds.bottom - parseFloat(style.scrollPaddingBottom);
      if (caret.bottom > bottom) pane.scrollBy(0, caret.bottom - bottom);
      else if (caret.top < top) pane.scrollBy(0, caret.top - top);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(sync); };
    sync();
    viewport.addEventListener("resize", schedule);
    viewport.addEventListener("scroll", schedule);
    window.addEventListener("scroll", schedule);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", schedule);
      viewport.removeEventListener("scroll", schedule);
      window.removeEventListener("scroll", schedule);
      root.style.removeProperty("--native-viewport-height");
      root.style.removeProperty("--native-viewport-top");
    };
  }, [native]);
  const { activeView, setActiveView } = useAppStore();
  /** 首次进入后保留工作台实例：切到其他页面时，在途图片和对话仍能收尾。 */
  const [workbenchVisited, setWorkbenchVisited] = useState(() => activeView === "record");
  /** 014-C：地图/城市列表打开的笔记（只读面板，不卸载记录输入）。 */
  const [openedPageId, setOpenedPageId] = useState<string | null>(null);
  /** 从地图详情跳转到笔记本时，只消费一次的目标篇。 */
  const [notebookOpenRequest, setNotebookOpenRequest] = useState<{
    pageId: string;
    token: number;
  } | null>(null);
  // 本轮调整：手动选择边界文件的开发态入口已移除，边界输入句柄不再需要。
  // 地图浏览状态由 AtlasController 在槽位内部管理；这里不做持久化、不写页地点。

  /** 019：全站统一的左侧抽屉（菜单按钮 + 抽屉本体都在这里，切页不重挂载）。 */
  const navDrawer = useNavDrawer();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsVisited, setSettingsVisited] = useState(false);
  /** 地图显示风格：本地偏好；默认地貌，首帧后再读取已保存的纸纹偏好。 */
  const [mapStyle, setMapStyle] = useState<AtlasMapStyle>("terrain");
  const [mapStyleLoaded, setMapStyleLoaded] = useState(false);
  useEffect(() => {
    setMapStyle(readAtlasMapStyle());
    setMapStyleLoaded(true);
  }, []);
  useEffect(() => {
    if (mapStyleLoaded) saveAtlasMapStyle(mapStyle);
  }, [mapStyle, mapStyleLoaded]);
  useEffect(() => {
    if (!mapStyleLoaded) return;
    document.documentElement.dataset.atlasTheme = mapStyle;
  }, [mapStyle, mapStyleLoaded]);
  const changeMapStyle = useCallback((style: AtlasMapStyle) => setMapStyle(style), []);
  const [uiTheme, setUiTheme] = useState<UiTheme>("light");
  useEffect(() => { queueMicrotask(() => setUiTheme(readUiTheme())); }, []);
  const changeUiTheme = useCallback((theme: UiTheme) => {
    saveUiTheme(theme); setUiTheme(theme); document.documentElement.dataset.uiTheme = theme;
  }, []);
  const closeSettings = () => {
    setSettingsOpen(false);
    window.dispatchEvent(new Event("xingji-settings-changed"));
  };
  /** 016：首页全屏地图；记录页独立；两页共用 HomeCapture 的同一份草稿状态。 */
  const captureView = activeView === "record" ? "record" : "map";
  /** 地图页 ↔ 记录页：两个入口都是 AppView，映射在这里显式写死。 */
  const openCaptureView = (target: "open-record" | "open-map") =>
    void navigateTo(target === "open-record" ? "record" : "home");

  /**
   * 导航闸门：全局导航与「在 AI 工作台中打开」共用。依赖在动作发生时读取
   * （store 的当前视图 + 页面注册的守卫），所以用惰性 state 建一次即可。
   */
  const [navGate] = useState(() =>
    createNavigationGate({
      // 笔记本与工作台各有自己的待保存内容，共用同一个闸门，不建第二套守卫。
      needsLeaveGuard: () => ["notebook", "record"].includes(useAppStore.getState().activeView),
      leaveGuard: () =>
        useAppStore.getState().activeView === "record"
          ? getWorkbenchLeaveGuard()
          : getNotebookLeaveGuard()
    })
  );

  /**
   * 024-A：统一的全局导航入口。
   * - 离开笔记本页前调用页面注册的离页守卫，等待最新草稿落库；
   *   保存失败/冲突留在当前编辑区（不弹离页确认、不注册 beforeunload）；
   * - 导航序号：连续点击只让最后一次生效，丢弃迟到的旧切换回调。
   */
  /**
   * 统一导航入口：`after` 只在守卫通过、且这次导航没有被更新的意图取代后执行
   * （「在 AI 工作台中打开」用它带范围建会话，保存失败则不会建出空会话）。
   */
  const navigateTo = useCallback(
    async (view: AppView, after?: () => void) => {
      await navGate(() => {
        after?.();
        if (view === "settings") {
          setSettingsVisited(true);
          setSettingsOpen(true);
        } else {
          if (view === "record" || useAppStore.getState().activeView === "record")
            setWorkbenchVisited(true);
          setActiveView(view);
        }
      });
    },
    [navGate, setActiveView]
  );

  /**
   * 地图笔记详情 → 笔记本：先过离页守卫，再带着一次性目标篇切页。
   */
  const openNoteInNotebook = useCallback(
    (pageId: string) => {
      void navigateTo("notebook", () => {
        setOpenedPageId(null);
        setNotebookOpenRequest({ pageId, token: Date.now() });
      });
    },
    [navigateTo]
  );
  const consumeNotebookOpenRequest = useCallback(() => setNotebookOpenRequest(null), []);

  /** 笔记本 / 笔记「在 AI 工作台中打开」：先过离页守卫，再建会话并切页。 */
  const openWorkbenchWithScope = useCallback(
    (scope: WorkbenchScope) => {
      void navigateTo("record", () =>
        useWorkbenchStore.getState().createSession(scope, describeScope(scope))
      );
    },
    [navigateTo]
  );
  const immersive = activeView === "home";

  const {
    messages: captureMessages,
    media: captureMedia,
    mediaUrls: captureMediaUrls,
    error: captureError,
    addMessage,
    archiveMessages,
    deleteMessage: deleteCaptureMessage,
    updateMessage: updateCaptureMessage,
    reload: reloadCapture,
    repository: captureRepository,
    loadMediaView: captureLoadMediaView
  } = useCaptureArchive(native?.repositories.capture, namespace, { metadataOnly: !!native });
  const {
    archive,
    getArchive,
    media,
    mediaUrls,
    ready: notebookReady,
    migration: notebookMigration,
    storageError: notebookStorageError,
    addNotebook,
    updateNotebookTitle,
    addPage,
    updatePage,
    movePage,
    deletePage,
    deleteNotebook,
    restoreNotebook,
    restorePage,
    purgeTrash,
    setTrashAutoCleanup,
    inspectLegacy,
    linkLegacy,
    copyLegacy,
    setRegions,
    repository: notebookRepository,
    reload: reloadNotebook,
    readMediaBlob: notebookReadMediaBlob,
    loadMediaView: notebookLoadMediaView
  } = useNotebookArchive(native?.repositories.notebook, namespace, { metadataOnly: !!native });

  /**
   * P2-01：AI 依赖在整个应用生命周期内各创建一次（懒初始化、挂载期稳定）。
   * 不新建全局 store：AI 库随账号命名空间派生独立 IDB（T2a），与笔记本库互不依赖；
   * Gateway 请求函数只发同源 POST，密钥与配置解析全部留在服务端。
   */
  const [aiRepository] = useState(() => native?.repositories.ai ?? createIndexedDbAiRepository(undefined, namespace));
  const [aiGatewayCaller] = useState(() => native
    ? async () => ({ ok: false as const, code: "NATIVE_TASK_HOST_REQUIRED", detail: "手机任务服务尚未就绪，请稍后重试。", status: 503 })
    : createAiGatewayCaller());

  useEffect(() => {
    // 端到端测试只在 React 接管服务端 HTML 后执行交互，避免误测未水合页面。
    document.documentElement.dataset.xingjiHydrated = "true";
    return () => {
      delete document.documentElement.dataset.xingjiHydrated;
    };
  }, []);

  /**
   * 地图的显色/统计/封面/列表共用全部可见独立篇，不按旅行日期筛选。
   */
  const visibleArchive = useMemo(() => {
    const visibleNotebookIds = new Set(
      archive.notebooks
        .filter((notebook) => !notebook.archivedAt && !notebook.deletedAt)
        .map((notebook) => notebook.id)
    );
    const pages = archive.pages.filter(
      (page) =>
        visibleNotebookIds.has(page.notebookId) &&
        !isPageDeleted(page) &&
        page.source.kind !== "legacy-journal"
    );
    return { ...archive, pages };
  }, [archive]);

  /**
   * 014-C 地区统计视图：纯函数聚合当前可见独立篇，按逻辑篇去重；
   * 地图只渲染，不读 IndexedDB、不读媒体二进制。
   * 阶段三：封面改用降采样缩略图（coverThumbUrls），不解码全部原图。
   */
  const regionAggregate = useMemo(
    () => (notebookReady ? aggregateRegions(visibleArchive) : null),
    [visibleArchive, notebookReady]
  );

  /**
   * 按需封面缩略图（阶段三 + P2 收紧）：只为各地区**实际封面候选**按
   * selectRegionCover 的选择顺序生成降采样副本（成功即止），不再解码
   * 全部照片；生成即上报展示（不等整批）。缓存有界（≤100），
   * 在用封面钉住不淘汰，可丢弃可重建。
   */
  const [wallCoverPageIds, setWallCoverPageIds] = useState<string[]>([]);
  const requestWallCovers = useCallback(
    (ids: string[]) =>
      setWallCoverPageIds((previous) =>
        previous.length === ids.length && previous.every((id, index) => id === ids[index])
          ? previous
          : ids
      ),
    []
  );
  const coverThumbCacheRef = useRef<CoverThumbnailCache>(new Map());
  const [coverThumbUrls, setCoverThumbUrls] = useState<Record<string, string>>({});
  /** 各篇 photo 块引用的 mediaId（封面候选与选择共用同一份派生）。 */
  const photoMediaIdsByPage = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const page of archive.pages) {
      map.set(
        page.id,
        page.blocks.flatMap((block) => (block.type === "photo" ? [block.mediaId] : []))
      );
    }
    return map;
  }, [archive.pages]);
  /** 仅生成当前墙上普通卡及叠卡前三篇的展示图，翻组才读取下一组。 */
  const coverNeeds = useMemo<CoverThumbnailNeed[]>(
    () =>
      wallCoverPageIds.map((pageId) => ({
        key: pageId,
        candidateIds: photoMediaIdsByPage.get(pageId) ?? []
      })),
    [wallCoverPageIds, photoMediaIdsByPage]
  );
  /**
   * B4：封面候选已尝试过按需读取的 mediaId（缺失/失败不重复读）。
   * 账号切换时 XingjiWorkspace 按 actor 重挂载，本 ref 随之自然重置。
   */
  const coverReadTriedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    let cancelled = false;
    // 展示只保留当前各地区实际使用的封面，可见范围/封面变化不累积历史 URL。
    void Promise.resolve().then(() => {
      if (!cancelled)
        setCoverThumbUrls((current) => selectNeededThumbnailUrls(coverNeeds, current));
    });
    if (coverNeeds.length === 0) return;
    // F5：元数据视图下 blob 可选；缺 blob 的条目跳过缩略（封面显示既有占位，不伪造）。
    const blobById = new Map(media.flatMap((item) => (item.blob ? [[item.id, item.blob] as const] : [])));
    // B4：原生 metadataOnly 启动不预读全库，但封面候选逐张按需读取（有界：仅当前
    // 墙上需要的页）；读到的 blob 进入 media 视图后本效应重跑生成缩略图（迟到读取）。
    if (native && notebookReadMediaBlob) {
      const pending = coverNeeds
        .flatMap((need) => need.candidateIds)
        .filter((id) => !blobById.has(id) && !coverReadTriedRef.current.has(id));
      for (const id of pending) coverReadTriedRef.current.add(id);
      if (pending.length > 0) {
        void (async () => {
          for (const mediaId of pending) {
            if (cancelled) return;
            try {
              await notebookReadMediaBlob(mediaId);
            } catch {
              // 单张读取失败：该候选保持文字卡，不阻断其余候选。
            }
          }
        })();
      }
    }
    void ensureCoverThumbnails(coverNeeds, blobById, coverThumbCacheRef.current, {
      isCancelled: () => cancelled,
      onThumbnail: (mediaId, dataUrl) => {
        if (cancelled) return;
        setCoverThumbUrls((current) =>
          selectNeededThumbnailUrls(coverNeeds, { ...current, [mediaId]: dataUrl })
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [coverNeeds, media, native, notebookReadMediaBlob]);

  const regionCounts: AtlasRegionCounts | undefined = useMemo(() => {
    if (!notebookReady || !regionAggregate) return undefined;
    const aggregate = regionAggregate;
    const pagesByRegion = new Map<string, AtlasPageSummary[]>();
    for (const regionId of aggregate.pagesByRegion.keys()) {
      const detail = aggregate.pagesByRegionDetail.get(regionId) ?? [];
      pagesByRegion.set(
        regionId,
        detail.map((page) => ({
          pageId: page.pageId,
          title: page.title,
          capturedAt: page.capturedAt,
          notebookTitle: page.notebookTitle
        }))
      );
    }
    const mediaById = new Map(media.map((item) => [item.id, item]));
    const notebookTitles = new Map(archive.notebooks.map((item) => [item.id, item.title]));
    const notesById = new Map<string, MemoryNote>(
      visibleArchive.pages.map((page) => {
        const photoMediaIds = photoMediaIdsByPage.get(page.id) ?? [];
        return [
          page.id,
          {
            pageId: page.id,
            title: page.title,
            capturedAt: page.capturedAt,
            notebookTitle: notebookTitles.get(page.notebookId) ?? "笔记本",
            excerpt: page.blocks
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join(" ")
              .replace(/[#*_>`]/g, "")
              .slice(0, 120),
            photoMediaIds,
            coverUrl:
              selectRegionCover(
                [{ pageId: page.id, title: page.title, photoMediaIds }],
                coverThumbUrls
              )?.coverUrl ?? null,
            points: photoMediaIds.flatMap((id) => {
              const gps = mediaById.get(id)?.gps;
              return gps?.confirmedAt ? [wgs84ToGcj02({ lat: gps.lat, lng: gps.lng })] : [];
            })
          }
        ];
      })
    );
    return {
      ready: true,
      // 映射描述符：真实 sourceId 由加载到的数据集自报，这里只提供来源编号对照。
      boundarySource: {
        sourceId: "local-json",
        sourceVersion: "33cd37ab22628858654d839f5d88a2deec372463"
      },
      sourceRegionIdByRegionId: new Map(
        // 同一应用地区登记**全部**来源标识：014-C 数字编号 + 015 素材文件名（拼音）。
        // 广东 21 市的边界分片用拼音标识，只登记数字编号会让城市计数映射不到。
        REGION_CATALOG.regions.flatMap((region) => {
          const entries: [string, string][] = [[region.regionId, region.sourceRegionId]];
          if (region.sourceFile && region.sourceFile !== region.sourceRegionId) {
            entries.push([region.regionId, region.sourceFile]);
          }
          return entries;
        })
      ),
      pagesByRegion,
      pageCountByRegion: new Map(aggregate.countsByRegion),
      // 只关联省级、尚未细分城市的篇：省内列表单独分组，不塞进某个城市。
      provinceOnlyByProvince: new Map(
        listProvinces().map((province) => [
          province.regionId,
          listProvinceOnlyPages(aggregate, province.regionId).map((page) => ({
            pageId: page.pageId,
            title: page.title,
            capturedAt: page.capturedAt,
            notebookTitle: page.notebookTitle
          }))
        ])
      ),
      notesById,
      unlocatedPages: [
        ...aggregate.unsetPages,
        ...aggregate.needsMatchingPages.filter((page) => !page.regionIds.length)
      ].flatMap((page) => {
        const note = notesById.get(page.pageId);
        return note ? [note] : [];
      })
    } satisfies AtlasRegionCounts;
  }, [
    regionAggregate,
    notebookReady,
    coverThumbUrls,
    photoMediaIdsByPage,
    media,
    archive.notebooks,
    visibleArchive.pages
  ]);

  /**
   * 记忆地图 M1：笔记侧「在地图中查看」→ 首页地图显式定位。
   * 只传递一次请求（token 防重复）；地图层级切换由槽位内完成。
   */
  const [mapLocateRequest, setMapLocateRequest] = useState<{
    regionId: string;
    token: number;
  } | null>(null);
  const locateRegionOnMap = useCallback(
    (regionId: string) => {
      void navigateTo("home", () => {
        setOpenedPageId(null);
        setMapLocateRequest({ regionId, token: Date.now() });
      });
    },
    [navigateTo]
  );
  /** 地图槽位消费完定位请求即清除：重挂载/再次打开地图不得重放旧请求。 */
  const consumeMapLocateRequest = useCallback(() => setMapLocateRequest(null), []);

  const openedPage = openedPageId
    ? (archive.pages.find((page) => page.id === openedPageId) ?? null)
    : null;

  /**
   * 地图槽位元素：AtlasSlot 自身用 memo 包住（见该组件导出），
   * 因此这里每次渲染新建元素也不会重渲染，更不会重挂载——
   * 浏览会话、已加载几何与在途请求都留在组件实例里，篇数变化才提交新 props。
   */
  const atlasSlot = (
    <AtlasSlot
      dataScope="development-preview"
      onOpenPage={setOpenedPageId}
      regionCounts={regionCounts}
      locateRequest={mapLocateRequest}
      onLocateConsumed={consumeMapLocateRequest}
      onCoverPageIdsChange={requestWallCovers}
      mapStyle={mapStyle}
    />
  );

  /**
   * 工作台目录：笔记本 → 笔记（含正文文本，用于写入前的合并预览）。
   * 只读取现有档案，不新建存储。
   */
  const workbenchNotebooks: WorkbenchNotebook[] = useMemo(
    () =>
      listVisibleNotebooks(archive).map((notebook) => ({
        id: notebook.id,
        title: notebook.title,
        notes: archive.pages
          .filter((page) => page.notebookId === notebook.id && !isPageDeleted(page))
          .map((page) => ({
            id: page.id,
            title: page.title,
            images: page.blocks.flatMap((block) =>
              block.type === "photo"
                ? [
                    {
                      id: block.mediaId,
                      name:
                        block.caption ||
                        media.find((item) => item.id === block.mediaId)?.name ||
                        "笔记图片",
                      dataUrl: mediaUrls[block.mediaId]
                    }
                  ]
                : []
            ),
            body: page.blocks
              .filter((block) => block.type === "text")
              .map((block) => (block.type === "text" ? block.text : ""))
              .join("\n")
          }))
      })),
    [archive, media, mediaUrls]
  );

  /**
   * 随记新建：复用捕获归档（真实持久化），并回传写入后的条目，
   * 让随记面板的「新随记」槽位升级成同一条目，继续输入就是编辑而不是再建一条。
   */
  const createQuickNote = async (input: { text: string }) => {
    const message = await addMessage({ text: input.text });
    if (!message) throw new Error("随记未能写入本地素材库。");
    return message;
  };

  function renderWorkbench() {
    return (
      <WorkbenchConnected
        nativeMode={!!native}
        sessionApi={native?.workbench.sessionApi}
        memoryStore={native?.workbench.memoryStore}
        nativeTask={native ? { files: native.files, repositories: native.repositories, actor: native.actor, database: native.database, workbenchRef: native.workbench,
        skillsCatalog: async () => {
          try {
            const entries = await native.skills.catalog();
            return { ok: true, entries };
          } catch (error) {
            return { ok: false, entries: [], error: error instanceof Error ? error.message : "本机 Skill 目录不可读。" };
          }
        },
        skillSnapshots: async selection => {
          // R3/T9/B6：真实 catalog 门禁 + settings 文件清单（SKILL.md 与 references/*.md
          // 都进快照），每个文件循环续读直至 EOF；整个快照范围统一累计预算，超限明确失败。
          return collectSkillSnapshots(native.skills, selection);
        } } : undefined}
        onOpenSettings={() => void navigateTo("settings")}
        notebook={{ archive, getArchive, addPage, updatePage }}
        notebooks={workbenchNotebooks}
        quickNotes={{
          messages: captureMessages,
          mediaUrls: captureMediaUrls,
          archive,
          aiEnabled: true,
          busy: false,
          storeError: captureError,
          onCreate: createQuickNote,
          onUpdate: async ({ messageId, text, expectedUpdatedAt }) => {
            const current = captureMessages.find((message) => message.id === messageId);
            const result = await updateCaptureMessage({
              messageId,
              text,
              mediaIds: current?.mediaIds ?? [],
              expectedUpdatedAt
            });
            // 回传新的并发基线：连续编辑用回读到的 updatedAt，避免自我冲突。
            return {
              status: result.status,
              updatedAt: result.status === "updated" ? result.message.updatedAt : undefined
            };
          },
          onDelete: deleteCaptureMessage,
          onArchive: archiveMessages,
          onReload: reloadCapture,
          search: (query, notes) => Promise.resolve(scoreQuickNotes(query, notes))
        }}
      />
    );
  }

  function renderView() {
    if (activeView === "record") return null;

    if (activeView === "home") {
      return (
        <HomeCapture
          aiExecutionAllowed={!native}
          onAiSaved={reloadNotebook}
          atlasSlot={atlasSlot}
          view={captureView}
          recordLayout="chat"
          onNavigateView={openCaptureView}
          onUpdateMessage={async (input) => {
            const result = await updateCaptureMessage(input);
            return result.status === "updated"
              ? { status: "updated" as const }
              : result.status === "conflict"
                ? { status: "conflict" as const, current: result.current }
                : { status: result.status };
          }}
          messages={captureMessages}
          mediaUrls={captureMediaUrls}
          onLoadMediaView={native ? captureLoadMediaView : undefined}
          storageError={captureError}
          captureMedia={captureMedia}
          notebooks={listVisibleNotebooks(archive).map((notebook) => ({
            id: notebook.id,
            title: notebook.title
          }))}
          onAddMessage={addMessage}
          onArchiveMessages={archiveMessages}
          onDeleteMessage={deleteCaptureMessage}
          notebookArchive={archive}
          onAssignCaptures={async (input): Promise<CaptureAssignmentOutcome> => {
            // 同上：追加同样以最新档案为基线，避免用过期的目标篇/ revision。
            const latest = await notebookRepository.loadArchive();
            // F5：整理是用户动作——此刻按需取完整媒体（blob 必需），启动不预载。
            const fullMedia = await captureRepository.loadMedia();
            const assigned = await assignCapturesToPage(
              {
                ...input,
                messages: captureMessages.filter((m) => input.messageIds.includes(m.id))
              },
              {
                captureRepository: {
                  loadArchive: async () => ({ messages: captureMessages }),
                  saveArchive: async () => {}
                },
                notebookRepository,
                notebookArchive: latest,
                captureMedia: fullMedia
              }
            );
            if (assigned.status === "applied") await reloadNotebook();
            return assigned;
          }}
          onCreatePageFromCaptures={async (input): Promise<CaptureAssignmentOutcome> => {
            // 读取**最新**档案再提交：闭包里的 archive 可能早于最近一次建本，
            // 用过期副本会误报“目标笔记本不存在”，也会让 revision 比较失去意义。
            const latest = await notebookRepository.loadArchive();
            const fullMediaForCreate = await captureRepository.loadMedia();
            const created = await createNotebookPageFromCaptures(
              {
                ...input,
                messages: captureMessages.filter((m) => input.messageIds.includes(m.id))
              },
              {
                captureRepository: {
                  loadArchive: async () => ({ messages: captureMessages }),
                  saveArchive: async () => {}
                },
                notebookRepository,
                notebookArchive: latest,
                captureMedia: fullMediaForCreate
              }
            );
            if (created.status === "applied") await reloadNotebook();
            return created;
          }}
          onOpenPageDetail={
            openedPage
              ? () => (
                  <PageDetailPanel
                    page={openedPage}
                    notebookTitle={
                      archive.notebooks.find((item) => item.id === openedPage.notebookId)?.title ??
                      "笔记本"
                    }
                    mediaUrls={mediaUrls}
                    onOpenNote={() => openNoteInNotebook(openedPage.id)}
                    onClose={() => setOpenedPageId(null)}
                  />
                )
              : undefined
          }
          onCreateNotebook={async (title) => {
            const created = await addNotebook(title);
            return { id: created.id, title: created.title };
          }}
        />
      );
    }

    if (activeView === "notebook") {
      return (
        <NotebookPageView
          mobile={navDrawer.mobile}
          archive={archive}
          media={media}
          mediaUrls={mediaUrls}
          onLoadMediaView={native ? notebookLoadMediaView : undefined}
          openPageRequest={notebookOpenRequest}
          onOpenPageRequestConsumed={consumeNotebookOpenRequest}
          storage={{
            ready: notebookReady,
            migration: notebookMigration,
            error: notebookStorageError
          }}
          onOpenNotebookInWorkbench={(notebookId, notebookTitle) =>
            openWorkbenchWithScope({ kind: "notebook", notebookId, notebookTitle })
          }
          onOpenNoteInWorkbench={({ notebookId, notebookTitle, noteId, noteTitle }) =>
            openWorkbenchWithScope({ kind: "note", notebookId, notebookTitle, noteId, noteTitle })
          }
          onAddNotebook={addNotebook}
          onUpdateNotebookTitle={updateNotebookTitle}
          onInspectLegacy={inspectLegacy}
          onLinkLegacy={linkLegacy}
          onCopyLegacy={copyLegacy}
          onCreatePage={addPage}
          onUpdatePage={updatePage}
          onRegisterLeaveGuard={setNotebookLeaveGuard}
          onReloadArchive={reloadNotebook}
          aiRepository={aiRepository}
          aiGatewayCaller={aiGatewayCaller}
          notebookRepository={notebookRepository}
          onMovePage={movePage}
          onDeletePage={async (pageId) => {
            await deletePage(pageId);
          }}
          onDeleteNotebook={async (notebookId) => {
            await deleteNotebook(notebookId);
          }}
          onRestoreNotebook={async (notebookId) => {
            await restoreNotebook(notebookId);
          }}
          onRestorePage={async (pageId, targetNotebookId) => {
            await restorePage(pageId, targetNotebookId);
          }}
          onTrashAutoCleanupChange={setTrashAutoCleanup}
          onPurgeTrash={async (targets) => {
            const outcome = await purgeTrash(targets);
            return outcome.status === "purged"
              ? { status: "purged" as const }
              : outcome.status === "conflict"
                ? { status: "conflict" as const }
                : {
                    status: "skipped" as const,
                    reason:
                      outcome.reason === "no-targets"
                        ? "没有可永久删除的条目。"
                        : "条目已被恢复或改动，未执行永久删除。"
                  };
          }}
          onRegionsChange={async (pageId, regionIds, expectedRevision, options) => {
            try {
              const outcome = await setRegions(pageId, regionIds, expectedRevision, options);
              if (outcome.status === "saved" || outcome.status === "unchanged") {
                return {
                  ok: true,
                  revision: outcome.revision,
                  metaSignature: outcome.metaSignature
                };
              }
              // setRegions 在 revision 冲突时抛 RevisionConflictError（由 catch 统一处理）。
              return { ok: false, message: outcome.detail };
            } catch (error) {
              return {
                ok: false,
                message: error instanceof Error ? error.message : "地区未保存，草稿已保留。"
              };
            }
          }}
          onLocateRegionOnMap={locateRegionOnMap}
        />
      );
    }

    return renderSettings();
  }

  function renderSettings() {
    /*
     * 设置页只做展示与复用：数据概况来自同一份 archive，不复制第二套流程。
     */
    const visibleNotebooks = listVisibleNotebooks(archive);
    const visibleIds = new Set(visibleNotebooks.map((notebook) => notebook.id));
    const trash = listTrash(archive);
    return (
      <SettingsPage
        nativeMode={!!native}
        nativeSkills={native ? {
          view: async () => {
            const view = await native.skills.settings();
            return { ok: view.ok === true, revision: String(view.revision ?? "1"), skills: view.skills.map(skill => ({ id: skill.id, label: skill.label, summary: skill.summary, state: skill.state, source: skill.source ?? "installed", promptFiles: skill.promptFiles, ...(skill.remark ? { remark: skill.remark } : {}) })) };
          },
          setState: async (id, state, expectedRevision) => { await native.skills.setState(id, state as never, expectedRevision); },
          setRemark: async (id, remark, expectedRevision) => { await native.skills.setRemark(id, remark, expectedRevision); },
          removePermanently: async input => native.skills.removePermanently({ ids: input.ids, confirmed: true, revision: input.revision }),
          downloadUrl: async (url: string) => {
            // T9/B5：经认证临时端点下载（服务端 downloadSkillUrl 的 SSRF 防护：私网/
            // 重定向/DNS 复检/限额/取消都在服务端完成）；不在客户端直连外网。
            try {
              const response = await apiFetch("/api/ai/settings/skills/preview", {
                method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "url", url })
              });
              return await skillDownloadFromPreviewResponse(response);
            } catch (error) {
              return { ok: false, kind: "markdown" as const, filename: "", error: error instanceof Error ? error.message : "下载失败" };
            }
          },
          preview: async input => {
            const result = await native.skills.preview(input);
            return { ok: result.ok, revision: result.revision, warnings: result.warnings,
              items: result.items.map(item => ({ name: item.package.name, packageId: item.package.id, description: item.package.description, duplicate: item.duplicates.length > 0, canUpdate: item.conflict?.canUpdate ?? false, identical: item.conflict?.identical ?? false, expectedFingerprint: item.conflict?.fingerprint ?? null, package: item.package })) };
          },
          install: async input => {
            const view = await native.skills.install(input as never);
            return { ok: view.ok === true, revision: String(view.revision ?? "1"), skills: view.skills.map(skill => ({ id: skill.id, label: skill.label, state: skill.state, source: skill.source ?? "installed", promptFiles: skill.promptFiles, summary: skill.summary })) };
          }
        } : undefined}
        nativeBackup={native ? {
          export: async () => {
            try {
              // P1-2：导出事务内校验 actor 当前有效（stale 时 createNativeBackup 事务内 assertActor 抛错，不再产出旧 dataset 空包）。
              const bytes = await createNativeBackup(native.database, native.files, native.actor, { digest: bytes => digestBytes(bytes, resolveXingjiHostAdapter()) });
              const blob = new Blob([Uint8Array.from(bytes)], { type: "application/zip" });
              const { Filesystem, Directory } = await import("@capacitor/filesystem");
              const { Share } = await import("@capacitor/share");
              const fileName = `xingji-backup-${new Date().toISOString().slice(0, 10)}.zip`;
              const path = `share-${Date.now()}-${fileName}`;
              const data = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result).split(",")[1]!);
                reader.onerror = () => reject(new Error("BACKUP_ENCODE_FAILED"));
                reader.readAsDataURL(blob);
              });
              try {
                await Filesystem.writeFile({ path, directory: Directory.Cache, data });
                const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache });
                await Share.share({ title: "行迹备份", dialogTitle: "导出行迹备份", files: [uri] });
                return { ok: true, fileName };
              } finally {
                // 系统面板异步消费缓存副本；与图片分享共用 share- 启动清理规则。
                setTimeout(() => void Filesystem.deleteFile({ path, directory: Directory.Cache }).catch(() => undefined), 60_000);
              }
            } catch (error) {
              const reason = error instanceof Error ? error.message : "BACKUP_EXPORT_FAILED";
              return { ok: false, code: reason === "Share canceled" ? "BACKUP_EXPORT_CANCELLED" : reason };
            }
          },
          restore: async (file: File) => {
            const bytes = new Uint8Array(await file.arrayBuffer());
            const outcome = await restoreNativeBackup(bytes, native.database, native.files,
              { serverId: native.actor.serverId, userId: native.actor.userId },
              { digest: bytes2 => digestBytes(bytes2, resolveXingjiHostAdapter()) });
            if (outcome.status === "restored") {
              // P1-2：恢复切换 dataset 后旧 actor/仓储全部失效——受控重载（经 runtime 导航
              // 屏障冻结凭证 IO→drain→reload，重开 boot 以新指针重建全部资源）。
              try {
                await native.runtime.beginNavigation();
              } catch { /* 屏障失败也继续 reload：恢复已提交，投影以重开为准 */ }
              window.location.reload();
              return { ok: true, message: `恢复完成：${outcome.rows} 条业务记录、${outcome.files} 个原件。页面正在刷新。` };
            }
            const reasons: Record<string, string> = {
              BACKUP_CORRUPT: "备份包损坏，无法读取。", BACKUP_MANIFEST_MISSING: "备份缺少清单文件。",
              BACKUP_MANIFEST_INVALID: "备份清单无法解析。", BACKUP_VERSION_UNSUPPORTED: "备份格式版本不受支持。",
              BACKUP_OWNERSHIP_MISMATCH: "备份属于其他账号或服务，不能恢复到当前账号。",
              BACKUP_TARGET_NOT_EMPTY: "当前账号资料非空；请先自行导出并清空后再恢复。",
              BACKUP_FILE_MISSING: "备份缺少声明的原件文件。", BACKUP_SIZE_MISMATCH: "原件大小与清单不符。",
              BACKUP_DIGEST_MISMATCH: "原件摘要校验失败（备份可能已损坏）。",
              BACKUP_FILE_POSITION_FAILED: "原件就位失败；目标保持空，可重试。",
              BACKUP_DATASET_SWITCH_FAILED: "目标资料指针切换失败；目标保持空，可重试。",
              BACKUP_RESTORE_TX_FAILED: "业务数据恢复事务失败；目标保持可重试。"
            };
            return { ok: false, code: outcome.code, message: reasons[outcome.code] ?? `恢复被拒绝（${outcome.code}）。` };
          }
        } : undefined}
        nativeSignOut={native ? { signOut: async () => {
          // F8：按 logout 的明确结果行动——本地清除失败不导航冒充成功。
          const runtime = native.runtime;
          const outcome = await runtime.logout(async (credential: { token: string; serverBase: string }) => {
            const response = await fetch(`${credential.serverBase}/api/auth/logout`, {
              method: "POST", headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
              credentials: "omit", body: "{}"
            });
            if (!response.ok) throw new Error(`LOGOUT_HTTP_${response.status}`);
          });
          if (outcome === "local-clear-failed") {
            window.dispatchEvent(new CustomEvent("xingji:native-signout-failed", { detail: "安全存储清除失败，未退出登录；请重试。" }));
            return;
          }
          await nativeBackWithDrain();
        } } : undefined}
        nativeClear={native ? { clear: async () => {
          // 捕获发起 actor：清空始终按发起时的 dataset 执行（§8 清 B 保 A）。
          const actor = native.actor;
          try {
            const next = await native.repositories.clearCurrentData(await randomToken(16, resolveXingjiHostAdapter()));
            void next.cleanup().catch(() => undefined);
            // F9：刷新走受控导航屏障（冻结新凭证 IO→drain 在途→再 reload），不绕过 drain。
            void (async () => {
              await native.runtime.beginNavigation();
              window.location.reload();
            })();
            return { ok: true, message: "本机数据已清空；页面正在刷新。" };
          } catch (error) {
            void actor;
            return { ok: false, message: `清空未完成：${error instanceof Error ? error.message : "未知错误"}。数据保持不变，可重试。` };
          }
        } } : undefined}
        memoryStore={native?.workbench.memoryStore}
        dataStatus={{
          ready: notebookReady,
          notebooks: visibleNotebooks.length,
          pages: archive.pages.filter(
            (page) => visibleIds.has(page.notebookId) && !isPageDeleted(page)
          ).length,
          media: media.length,
          trashed: trash.notebooks.length + trash.pages.length,
          storageError: notebookStorageError
        }}
        mapStyle={mapStyle}
        onMapStyleChange={changeMapStyle}
        uiTheme={uiTheme}
        onUiThemeChange={changeUiTheme}
      />
    );
  }

  return (
    <div
      className={immersive ? "app-shell app-shell--immersive" : "app-shell"}
      data-native-storage={native ? "sqlite-filesystem-secure-storage" : undefined}
      data-native-dataset={native?.actor.datasetId}
      data-nav-open={navDrawer.open}
      data-atlas-theme={mapStyle}
      style={{ "--nav-width": `${navDrawer.width}px` } as CSSProperties}
    >
      <NavMenuButton
        open={navDrawer.open}
        onToggle={navDrawer.toggle}
        buttonRef={navDrawer.buttonRef}
        className="app-mobile-menu"
      />
      <NavDrawer
        width={navDrawer.width}
        onWidthChange={navDrawer.setWidth}
        mobile={navDrawer.mobile}
        open={navDrawer.open}
        onClose={navDrawer.close}
        onToggle={navDrawer.toggle}
        activeView={activeView}
        onNavigate={(view) => {
          // 切页后关闭抽屉；导航统一走 navigateTo（024-A 离页守卫 + 序号防迟到）。
          if (navDrawer.mobile) navDrawer.close();
          void navigateTo(view);
        }}
        drawerRef={navDrawer.drawerRef}
      />
      <main
        className={
          immersive
            ? "app-main app-main--immersive"
            : activeView === "record"
              ? "app-main app-main--workbench"
              : "app-main"
        }
      >
        {(workbenchVisited || activeView === "record") && (
          <div className="app-workbench-slot" hidden={activeView !== "record"}>
            {renderWorkbench()}
          </div>
        )}
        {renderView()}
      </main>
      {settingsVisited && (
        <SettingsDialog open={settingsOpen} onClose={closeSettings}>
          {renderSettings()}
        </SettingsDialog>
      )}
    </div>
  );
}
