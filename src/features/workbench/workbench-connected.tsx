"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Check, RefreshCw } from "lucide-react";
import { listAiConfigs, type AiConfigListResultWithFlags } from "@/features/ai/ai-gateway-client";
import { imageOutputFormats, type ImageOutputFormat, type ImageStyle } from "@/features/creation/creation-image-rules";
import { WorkbenchPage } from "./workbench-page";
import { streamAiGateway } from "@/features/ai/ai-gateway-client";
import { createWorkbenchAdapter, scopeMaterials, type WorkbenchAdapterOptions } from "./workbench-adapter";
import { createApiMemoryStore, type MemoryState, type MemoryStore } from "./workbench-memory";
import { createSessionApi, type SessionApi } from "./workbench-sessions";
import type { WorkbenchAdapter } from "./workbench-types";
import { commitSession, hydrateSessions, settleSession, useWorkbenchStore } from "./workbench-store";
import { setWorkbenchLeaveGuard } from "@/features/app/app-store";
import { WorkbenchNativeSearchStatus } from "./workbench-native-search-controls";
import { createMobileTaskClient, createNativeTaskWorkbenchAdapter, type NativeTaskWorkbenchPorts } from "@/features/mobile/mobile-task-client";
import { setNativeAttachmentSource, setNativeImageShare } from "./workbench-page";
import { digestBytes, randomToken, resolveXingjiHostAdapter } from "@/features/mobile/native-host";
import type { NativeActor, NativeDatabase } from "@/features/mobile/native-database";
import type { NativeFiles } from "@/features/mobile/native-files";

type PageProps = Parameters<typeof WorkbenchPage>[0];
export function WorkbenchConnected({
  notebook,
  streamGateway = streamAiGateway,
  quickNotes,
  sessionApi: injectedSessionApi,
  memoryStore: injectedMemoryStore,
  nativeMode = false,
  taskAdapter,
  nativeTask,
  ...props
}: Omit<PageProps, "adapter"> & {
  notebook: WorkbenchAdapterOptions["notebook"];
  /** 流式调用注入点：生产用同源 NDJSON，隔离测试喂受控分块。 */
  streamGateway?: WorkbenchAdapterOptions["streamGateway"];
  sessionApi?: SessionApi;
  memoryStore?: MemoryStore;
  nativeMode?: boolean;
  /** Native multi-step tasks must use the durable service host; no browser runner fallback. */
  taskAdapter?: WorkbenchAdapter;
  /** T6a：原生交付端口（任务客户端之外的文件/仓储/actor 绑定），缺省时明确停留不可发送。 */
  nativeTask?: {
    files: NativeFiles;
    repositories: NativeTaskWorkbenchPorts["repositories"];
    actor: NativeActor;
    database?: NativeDatabase;
    /** T9/P1-5：本机 Skill 目录（catalog 形状直通；手机端优先于服务端）。 */
    skillsCatalog?: () => Promise<{ ok: boolean; entries: import("@/features/ai/skill-knowledge").SkillCatalogEntry[]; error?: string }>;
    /** T9：本机 Skill 受控快照出口（选择→快照；由 xingji-app 经 snapshotForTask 适配）。 */
    skillSnapshots?: (selection: readonly { id: string; name: string }[]) => Promise<Array<{ id: string; name: string; windows: { path: string; text: string }[] }>>;
    /** native 工作台 store（附件发布/提交与原字节按需读取出口）。 */
    workbenchRef?: {
      attachmentBlob(attachment: never): Promise<Blob | undefined>;
      prepareAttachment(media: { id: string; name: string; type: string; size: number; blob: Blob }): Promise<{ attachment: unknown; prepared: unknown }>;
      commitAttachments(prepared: readonly unknown[]): Promise<void>;
      commitSessionWithAttachments?(input: { id: string; baseRevision?: number; title?: string; payload: import("./workbench-sessions").SessionPayload }, prepared: readonly unknown[]): Promise<import("./workbench-sessions").SessionRecord>;
    };
  };
}) {
  const [configs, setConfigs] = useState<AiConfigListResultWithFlags>();
  const [version, setVersion] = useState(0);
  const [textId, setTextId] = useState("");
  const textModelGroupName = useId();
  const [imageId, setImageId] = useState("");
  const [imageSize, setImageSize] = useState<string>();
  const [imageStyle, setImageStyle] = useState<ImageStyle>("none");
  const [imageOutputFormat, setImageOutputFormat] = useState<ImageOutputFormat>("png");
  /*
   * 发送授权已取消（用户指令：永久允许）：选好可用模型即可发送。
   * 模型选择仍然只是选择——它决定发到哪个端点，不再是"每次都要点的许可"。
   */
  /** 会话持久化：本机 SQLite；刷新/重启后恢复会话、消息与模型选择。 */
  const [sessionApi] = useState(() => { if (nativeMode && !injectedSessionApi) throw new Error("NATIVE_SESSION_STORE_REQUIRED"); return injectedSessionApi ?? createSessionApi(); });
  const nativeBridge = resolveXingjiHostAdapter();
  /** T6a/H6 任务客户端：全进程一个实例；摘要走原生桥受控出口——结果文件下载
   * 的字节摘要核验也在 client 内进行（WebView 非安全上下文无 WebCrypto，
   * 缺省出口会 DIGEST_UNAVAILABLE，含产物交付全部失败）。 */
  const [taskClient] = useState(() => createMobileTaskClient({
    digest: bytes => digestBytes(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes, nativeBridge)
  }));
  // T8：原生分享出口（@capacitor/share 官方插件；blob 经 Cache 副本转 file URI，分享面板读取后清理）。
  // P2-d：受控前缀 share- + 启动时清理过期副本（force-stop 后 60s 定时器丢失的兜底）。
  const SHARE_CACHE_PREFIX = "share-";
  const SHARE_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
  useEffect(() => {
    if (!nativeTask?.workbenchRef) return;
    let cancelled = false;
    void import("@capacitor/share").then(async ({ Share }) => {
      const { Filesystem, Directory } = await import("@capacitor/filesystem");
      // P2-d：启动清理——列出 Cache 内 share- 前缀副本，删除创建超 24h 的（近期副本
      // 可能正被分享面板读取，保留）。删除失败静默（下次启动再试）。
      void Filesystem.readdir({ directory: Directory.Cache, path: "" }).then(entries => {
        for (const entry of entries.files) {
          if (!entry.name.startsWith(SHARE_CACHE_PREFIX)) continue;
          void Filesystem.stat({ directory: Directory.Cache, path: entry.name }).then(info => {
            if (Date.now() - info.mtime > SHARE_CACHE_MAX_AGE_MS) {
              void Filesystem.deleteFile({ directory: Directory.Cache, path: entry.name }).catch(() => undefined);
            }
          }).catch(() => undefined);
        }
      }).catch(() => undefined);
      setNativeImageShare(async input => {
        const cacheName = `${SHARE_CACHE_PREFIX}${Date.now()}-${input.fileName}`;
        const bytes = input.blob ? new Uint8Array(await input.blob.arrayBuffer()) : null;
        try {
          let fileUrl: string | undefined;
          if (bytes) {
            const base64 = await arrayBufferToBase64(input.blob!);
            await Filesystem.writeFile({ path: cacheName, directory: Directory.Cache, data: base64 });
            const uri = await Filesystem.getUri({ path: cacheName, directory: Directory.Cache });
            fileUrl = uri.uri;
          }
          await Share.share({ title: input.title, text: input.text, dialogTitle: "分享图片", ...(fileUrl ? { url: fileUrl } : {}) });
        } finally {
          // 分享面板读取由系统异步进行；延迟清理（1 分钟）避免接收端读不到文件。
          // 删除失败不吞：记录后由启动清理兜底（P2-d）。
          if (bytes) setTimeout(() => void Filesystem.deleteFile({ path: cacheName, directory: Directory.Cache }).catch(() => undefined), 60_000);
        }
        void cancelled;
      });
    }).catch(() => undefined);
    return () => { setNativeImageShare(undefined); cancelled = true; };
  }, [nativeTask?.workbenchRef]);
  // F1/F6：native 附件按需读取出口（readVerified 核对大小与摘要后返回原件 Blob），
  // 生命周期绑定 actor 三元组——切号/清空时以新生命周期重设即撤销全部视图。
  const nativeWorkbenchRef = useRef(nativeTask?.workbenchRef);
  nativeWorkbenchRef.current = nativeTask?.workbenchRef;
  const nativeActorLifecycle = nativeTask ? `${nativeTask.actor.serverId}/${nativeTask.actor.userId}/${nativeTask.actor.datasetId}` : "";
function arrayBufferToBase64(blob: Blob): Promise<string> {
  return blob.arrayBuffer().then(buffer => {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    return btoa(binary);
  });
}
  useEffect(() => {
    if (!nativeTask?.workbenchRef || !nativeActorLifecycle) return;
    setNativeAttachmentSource(attachment => nativeWorkbenchRef.current!.attachmentBlob(attachment as never), nativeActorLifecycle);
    return () => setNativeAttachmentSource(null, `${nativeActorLifecycle}#teardown`);
  }, [nativeTask?.workbenchRef, nativeActorLifecycle]);
  const [sessionStatus, setSessionStatus] = useState<"loading" | "ready" | "error">("loading");
  const [sessionError, setSessionError] = useState<string>();
  /** 恢复时的中断提示与模型失效提示。 */
  const [restoreNotice, setRestoreNotice] = useState<string>();
  /** 恢复的模型选择：等配置列表到达后再决定是否可用。 */
  const [pendingModel, setPendingModel] = useState<string>();
  const [pendingImageModel, setPendingImageModel] = useState<string>();

  /** 记忆：生产走本机 SQLite API store，面板与请求共用同一份状态。 */
  const [memoryStore] = useState<MemoryStore>(() => { if (nativeMode && !injectedMemoryStore) throw new Error("NATIVE_MEMORY_STORE_REQUIRED"); return injectedMemoryStore ?? createApiMemoryStore(); });
  const [memory, setMemory] = useState<MemoryState>();
  const memoryRevisionRef = useRef<number | undefined>(undefined);
  /** 读取状态必须显式：不能把「读不到」静默当成「没有记忆」继续发送。 */
  const [memoryStatus, setMemoryStatus] = useState<"loading" | "ready" | "error">("loading");
  const [memoryEpoch, setMemoryEpoch] = useState(0);
  /** 权威重读：每个外发点调用；失败向上抛，让本轮失败而不是按空记忆发送。 */
  const ensureMemory = useCallback(async () => {
    try {
      const next = await memoryStore.load();
      memoryRevisionRef.current = next.revision;
      setMemory(next);
      setMemoryStatus("ready");
      return next;
    } catch (error) {
      setMemoryStatus("error");
      throw error;
    }
  }, [memoryStore]);

  /** 设置关闭时重读：只在 revision 改变或读取失败时撤销在途回合。 */
  const refreshMemory = useCallback(() => {
    setMemoryStatus("loading");
    void memoryStore
      .load()
      .then(next => {
        // 关闭设置弹窗不等于撤销记忆许可；只有真实变化才中止在途回合。
        if (memoryRevisionRef.current !== undefined && memoryRevisionRef.current !== next.revision)
          setMemoryEpoch(value => value + 1);
        memoryRevisionRef.current = next.revision;
        setMemory(next);
        setMemoryStatus("ready");
      })
      .catch(() => {
        // 无法核实许可时继续沿用旧快照不安全，仍按原边界中止。
        setMemoryEpoch(value => value + 1);
        memoryRevisionRef.current = undefined;
        setMemory(undefined);
        setMemoryStatus("error");
      });
  }, [memoryStore]);
  useEffect(() => {
    let active = true;
    void hydrateSessions(sessionApi)
      .then(() => {
        if (!active) return;
        setSessionStatus("ready");
        const state = useWorkbenchStore.getState();
        const id = state.activeId;
        const interrupted = id ? state.interrupted[id] : undefined;
        if (interrupted) setRestoreNotice(`${interrupted} 条回答在未运行时被中断，已保留已保存正文（不会自动续跑）。`);
        /*
         * 恢复模型选择只用于显示：模型已被删除/禁用时提示重新选择，不暗中换模型。
         */
        const restored = id ? state.sessions.find(item => item.id === id) : undefined;
        const restoredModel = restored?.textModelId;
        if (restoredModel) {
          setPendingModel(restoredModel);
        }
      })
      .catch((error: unknown) => {
        if (!active) return;
        // 读取失败不能当空库：明确报错，且不创建新会话覆盖。
        setSessionStatus("error");
        setSessionError(error instanceof Error ? error.message : "读取会话失败。");
      });
    return () => {
      active = false;
    };
  }, [sessionApi]);

  /*
   * SP6：切换会话时恢复该会话的模型；失效模型明确要求重选（不暗中换模型）。
   * 授权已取消，因此这里不再有任何"撤销许可"的动作。
   */
  const activeId = useWorkbenchStore(state => state.activeId);
  useEffect(() => {
    const session = activeId ? useWorkbenchStore.getState().sessions.find(item => item.id === activeId) : undefined;
    // 放到微任务里落地，避免在 effect 中同步触发级联渲染。
    queueMicrotask(() => {
      if (session?.textModelId) setPendingModel(session.textModelId);
      if (session?.imageModelId) setPendingImageModel(session.imageModelId);
      else {
        setImageId("");
        setImageSize(undefined);
        setImageStyle("none");
      }
    });
  }, [activeId]);

  /*
   * 应用内离页：先提交未保存内容，失败就不离开（复用全局导航闸门，不建第二套守卫）。
   */
  useEffect(() => {
    setWorkbenchLeaveGuard(async () => {
      const state = useWorkbenchStore.getState();
      const dirty = Object.entries(state.saveStates).filter(([, value]) => value !== "saved").map(([id]) => id);
      for (const id of dirty) {
        const saved = await commitSession(sessionApi, id);
        if (!saved) return false;
      }
      for (const id of Object.keys(state.saveStates)) await settleSession(id);
      return true;
    });
    return () => setWorkbenchLeaveGuard(null);
  }, [sessionApi]);

  useEffect(() => {
    let active = true;
    void memoryStore
      .load()
      .then(next => {
        if (!active) return;
        memoryRevisionRef.current = next.revision;
        setMemory(next);
        setMemoryStatus("ready");
      })
      .catch(() => {
        if (!active) return;
        setMemory(undefined);
        setMemoryStatus("error");
      });
    return () => {
      active = false;
    };
  }, [memoryStore]);
  useEffect(() => {
    let active = true;
    void listAiConfigs().then(result => { if (active) setConfigs(result); });
    return () => { active = false; };
  }, [version]);
  useEffect(() => {
    const refresh = () => { setVersion(v => v + 1); refreshMemory(); };
    window.addEventListener("xingji-settings-changed", refresh);
    return () => window.removeEventListener("xingji-settings-changed", refresh);
  }, [refreshMemory]);
  const textConfigs = configs?.status === "available" ? configs.configs.filter(item => item.usable !== false) : [];
  const textConfig = textConfigs.find(item => item.id === textId);
  // 恢复的模型选择：配置列表到达后套用一次；不可用则提示重新选择（不暗中换模型）。
  useEffect(() => {
    if (!pendingImageModel || configs?.status !== "available") return;
    const model = pendingImageModel;
    const available = (configs.imageConfigs ?? []).some(item => item.id === model);
    queueMicrotask(() => {
      if (available) setImageId(model);
      else {
        setImageId("");
        setRestoreNotice(`上次使用的制图模型已不可用（${model}），请重新选择。`);
      }
      setPendingImageModel(undefined);
    });
  }, [pendingImageModel, configs]);

  useEffect(() => {
    if (!pendingModel || configs?.status !== "available") return;
    const model = pendingModel;
    const available = textConfigs.some(item => item.id === model);
    // 放到微任务里落地，避免在 effect 中同步触发级联渲染。
    queueMicrotask(() => {
      if (available) setTextId(model);
      else setRestoreNotice(`上次使用的模型已不可用（${model}），请重新选择。`);
      setPendingModel(undefined);
    });
  }, [pendingModel, configs, textConfigs]);
  /*
   * 生图芯片始终显示一个模型（参考形态如此）：配置到位、又没有会话里恢复的选择时，
   * 默认选中第一条可用制图模型。这只是默认值——真正出图仍要用户点发送，且随时可换。
   */
  useEffect(() => {
    if (imageId || pendingImageModel || configs?.status !== "available") return;
    const first = (configs.imageConfigs ?? [])[0];
    if (!first) return;
    queueMicrotask(() => setImageId(first.id));
  }, [configs, imageId, pendingImageModel]);

  const imageConfig = configs?.imageConfigs?.find(item => item.id === imageId);
  /*
   * 阶段B：Skill 改为按需加载的 Agent 知识——发现/启停由服务端目录与读取端点权威处理，
   * 适配器经同源 /api/ai/skills* 自取；页面不再下发停用清单。
   */
  const desktopAdapter = createWorkbenchAdapter({ notebook, textConfig, imageConfig, imageConfigs: configs?.imageConfigs, streamGateway,
    // 检索工具只拿随记文本（不含图片字节）。
    quickNotes: quickNotes.messages.map(message => ({ id: message.id, text: message.text, createdAt: message.capturedAt })),
    imageEnabled: configs?.imageEnabled === true });
  const unavailable = async (): Promise<never> => { throw new Error("手机任务服务尚未就绪，请稍后重试。"); };
  /*
   * T6a：native 模式的多步任务走服务端宿主（不保留浏览器第二套任务循环）。
   * 交付粘合在此装配：任务客户端（apiFetch 单一 Bearer 接缝）+ 原生桥摘要
   * （HTTP 非安全上下文没有 crypto.subtle）+ 交付端口（files/repositories/actor）。
   * 冻结配置在发送时读取：configId + 当前 settings revision 漂移会被服务端拒绝。
   */
  const builtTaskAdapter = nativeMode && nativeTask ? createNativeTaskWorkbenchAdapter(desktopAdapter, {
    files: nativeTask.files,
    repositories: nativeTask.repositories,
    actor: nativeTask.actor,
    datasetId: nativeTask.actor.datasetId,
    client: taskClient,
    digest: bytes => digestBytes(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes, nativeBridge),
    randomId: () => randomToken(16, nativeBridge),
    scopeDocuments: request => scopeMaterials(request, notebook.getArchive?.() ?? notebook.archive).docs,
    sessionApi,
    attachmentBlobOf: attachment => nativeTask.workbenchRef
      ? nativeTask.workbenchRef.attachmentBlob(attachment as never)
      : Promise.resolve(undefined),
    prepareUnderstandingCopies: async (attachments: readonly { fileRef?: unknown; id?: string; name?: string }[]) => {
      const { prepareVisionImages, createBrowserImagePort } = await import("@/features/creation/creation-media");
      const port = createBrowserImagePort();
      const blobs = await Promise.all(attachments.map(async attachment => {
        const blob = await nativeWorkbenchRef.current!.attachmentBlob(attachment as never);
        if (!blob) throw new Error(`附件原件不可读：${attachment.name ?? ""}`);
        return { id: String(attachment.id ?? ""), blob };
      }));
      const prepared = await prepareVisionImages(blobs, port);
      return Promise.all(prepared.map(async ({ image }) => {
        const bytes = new Uint8Array(await image.blob.arrayBuffer());
        return { sha256: await digestBytes(bytes, nativeBridge), mime: image.blob.type, bytes: image.blob.size, upload: bytes };
      }));
    },
    imageConfigRef: () => imageId && imageConfig && configs?.status === "available" && configs.revision
      ? { configId: imageId, revision: configs.revision }
      : null,
    skillSnapshots: nativeTask.skillSnapshots,
    configRef: () => textConfig && configs?.status === "available" && configs.revision
      ? { configId: textConfig.id, revision: configs.revision }
      : null,
    onDelivered: (sessionId, revision, message) => {
      const state = useWorkbenchStore.getState();
      if (state.accountId !== nativeTask.actor.userId) return;
      // R2：权威交付消息（含 fileRef 附件）先入投影，再同步 revision——页面在收尾
      // 保存前已能看到附件；收尾保存把同一消息持久化（与 SQLite 一致）。
      state.updateMessage(sessionId, message.id, { text: message.text, status: message.status,
        ...(message.calls ? { calls: message.calls } : {}), ...(message.attachments ? { attachments: message.attachments } : {}) });
      state.setRevision(sessionId, revision);
    }
  }) : undefined;
  const adapter = nativeMode ? taskAdapter ?? builtTaskAdapter ?? { ...desktopAdapter, send: unavailable, stream: unavailable } : desktopAdapter;
  const executionReady = !nativeMode || !!taskAdapter || !!builtTaskAdapter;
  const controls = (
    <div className="wb-connection">
      <header className="wb-model-heading">
        <div><h3>对话模型</h3></div>
        <button type="button" className="wb-icon-button wb-model-refresh" aria-label="刷新模型" title="刷新模型"
          disabled={!configs}
          onClick={() => { setConfigs(undefined); setVersion(value => value + 1); }}>
          <RefreshCw size={16} aria-hidden />
        </button>
      </header>
      <div className="wb-model-options" role="radiogroup" aria-label="对话模型">
        {textConfigs.map(config => (
          <label key={config.id} className="wb-model-option" data-selected={textId === config.id}>
            <span className="wb-model-option-name" title={config.label}>{config.label}</span>
            <input
              type="radio"
              name={textModelGroupName}
              value={config.id}
              checked={textId === config.id}
              onChange={event => setTextId(event.target.value)}
            />
            <Check size={16} className="wb-model-option-check" aria-hidden="true" />
          </label>
        ))}
      </div>
      {!executionReady ? <p role="status">手机任务服务尚未就绪；本地笔记和会话仍可使用。</p> : null}
      {configs?.status === "available" && !textConfig ? <p className="wb-model-state" data-ready={false}>请选择对话模型后使用图像工具</p> : null}
      {configs?.status !== "available" ? (
        <p role="status">{configs && "detail" in configs ? configs.detail : "正在读取模型配置…"}</p>
      ) : null}
    </div>
  );
  return (
    <WorkbenchPage
      {...props}
      nativeSkillCatalog={nativeTask?.skillsCatalog}
      nativeAttachments={nativeTask?.workbenchRef ? {
        prepare: async media => {
          const result = await nativeTask.workbenchRef!.prepareAttachment(media as never) as { attachment: import("./workbench-types").MessageAttachment; prepared: { release: () => void } };
          const source = result.prepared as unknown as import("@/features/mobile/native-files").PreparedNativeFile;
          return { attachment: result.attachment, prepared: { ...source, release: () => nativeTask.files.releasePrepared([source]) } };
        },
        commit: prepared => nativeTask.workbenchRef!.commitAttachments(prepared as never),
        commitSession: nativeTask.workbenchRef.commitSessionWithAttachments ? (input, prepared) => nativeTask.workbenchRef!.commitSessionWithAttachments!(input, prepared) : undefined
      } : undefined}
      quickNotes={quickNotes}
      adapter={adapter}
      controls={controls}
      modelLabel={textConfig?.label ?? "选择模型"}
      modelStatus={<WorkbenchNativeSearchStatus mode={textConfig?.nativeSearch} modelSelected={!!textConfig} />}
      requestAllowed={!!textConfig && executionReady}
      memory={memory}
      memoryStore={memoryStore}
      onMemoryChanged={refreshMemory}
      memoryEpoch={memoryEpoch}
      memoryStatus={memoryStatus}
      onMemoryRetry={refreshMemory}
      ensureMemory={ensureMemory}
      sessionApi={sessionApi}
      sessionStatus={sessionStatus}
      sessionError={sessionError}
      restoreNotice={restoreNotice}
      models={{
        ...(textId ? { textModelId: textId } : {}),
        ...(imageId ? { imageModelId: imageId } : {})
      }}
      imageTool={{
        enabled: configs?.imageEnabled === true && executionReady,
        reason: configs?.status !== "available" && configs && "detail" in configs ? configs.detail : "图片功能暂不可用，请检查图片许可与制图模型配置。",
        modelId: imageId,
        size: imageSize,
        style: imageStyle,
        outputFormat: imageOutputFormats(imageConfig?.model ?? "").includes(imageOutputFormat) ? imageOutputFormat : undefined,
        models: configs?.imageConfigs ?? [],
        onModelChange: setImageId,
        onSizeChange: setImageSize,
        onStyleChange: setImageStyle,
        onOutputFormatChange: setImageOutputFormat
      }}
    />
  );
}
