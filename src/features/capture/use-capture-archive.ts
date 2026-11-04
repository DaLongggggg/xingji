"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** J5：模块级单调代数计数器（不复用）——每个 hook 实例的每个生命周期取唯一值。 */
let captureLifecycleCounter = 0;
import {
  createCaptureMessage,
  EMPTY_CAPTURE_ARCHIVE,
  listCaptureMessages,
  markMessagesArchived,
  removeCaptureMessage,
  updateCaptureMessage,
  type CaptureArchive,
  type CaptureMedia,
  type CaptureMessage
} from "./capture-model";
import { createIndexedDbCaptureRepository, type CaptureRepository } from "./capture-repository";

function getBrowserStorage(): Storage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("MEDIA_READ_FAILED"));
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("MEDIA_READ_FAILED"));
    reader.readAsDataURL(blob);
  });
}

/**
 * 原始记录入口。记录与笔记是不同实体：这里只维护记录流与记录媒体，
 * 归档只改状态，不改写或删除原始内容。
 *
 * T2a：提供 `namespace`（当前账号的 serverId/userId）时按账号派生独立 IDB，
 * 旧档案不自动继承。仓库实例与账号绑定：切号 = 应用树重挂载，迟到回调由
 * cancelled 守卫丢弃，只会写回原账号的仓库。
 */
export function useCaptureArchive(
  repository?: CaptureRepository,
  namespace?: { serverId: string; userId: string },
  /** T5 原生模式：附件按需取原件，不整批载入内存。 */
  options?: { metadataOnly?: boolean }
) {
  const [repo] = useState<CaptureRepository>(
    () => repository ?? createIndexedDbCaptureRepository(undefined, undefined, namespace)
  );
  const [archive, setArchive] = useState<CaptureArchive>(EMPTY_CAPTURE_ARCHIVE);
  /** F5：元数据视图（blob 可选）——metadataOnly 启动不读原件，URL 按需取。 */
  const [media, setMedia] = useState<(Omit<CaptureMedia, "blob"> & { blob?: Blob })[]>([]);
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const metadataOnly = options?.metadataOnly === true;
  const objectUrlsRef = useRef<Set<string>>(new Set());
  useEffect(() => () => { for (const url of objectUrlsRef.current) URL.revokeObjectURL(url); objectUrlsRef.current.clear(); }, []);
  const refreshMedia = useCallback(
    () => (metadataOnly ? repo.loadMediaMetadata!().then(entries => setMedia(entries)) : repo.loadMedia().then(entries => setMedia(entries))),
    [repo, metadataOnly]
  );

  /**
   * 受保护的整档修改：新增 / 编辑 / 归档 / 删除**共用同一条串行的读写边界**。
   *
   * 一次修改的完整过程都在边界内、按顺序执行：
   * 「读权威状态 → 纯函数修改 → 落盘 → 落盘成功后才提交权威状态」。
   *
   * 两条硬规则：
   * - **计算完成 ≠ 保存成功**：只有 `saveArchive` 成功才更新权威状态并向调用方返回成功；
   *   落盘失败会把错误抛给调用方（面板据此保留草稿），并在 `error` 里留下可见提示。
   * - **失败不堵队列**：写入失败的这一笔被丢弃，权威状态保持落盘内容，后续修改照常继续。
   *
   * 边界：跨标签页仍是整档「最后写入者胜」，未做多标签事务（与既有实现一致）。
   */
  const archiveRef = useRef<CaptureArchive>(EMPTY_CAPTURE_ARCHIVE);
  /** 初次载入是否已完成：没完成前不允许在空档案上做整档写入（会丢已有内容）。 */
  const loaded = useRef(false);
  const mutationChain = useRef<Promise<unknown>>(Promise.resolve());

  const applyMutation = useCallback(
    <T,>(mutate: (current: CaptureArchive) => { next: CaptureArchive; value: T }): Promise<T> => {
      const run = mutationChain.current.then(async () => {
        // 首屏还没载入完就发生写入：先读一次权威档案，避免用空档案覆盖已有内容。
        const current = loaded.current ? archiveRef.current : await repo.loadArchive();
        const { next, value } = mutate(current);
        if (next === current) return value;
        try {
          await repo.saveArchive(next);
        } catch (writeError) {
          // 失败必须传播：调用方要保留草稿，不能按成功处理。
          setError(writeError instanceof Error ? writeError.message : "记录写入失败。");
          throw writeError instanceof Error ? writeError : new Error("CAPTURE_SAVE_FAILED");
        }
        // 落盘成功才提交权威状态。
        archiveRef.current = next;
        setArchive(next);
        return value;
      });
      // 链条只传递“完成”信号：单次失败由调用方感知，后续修改照常排队。
      mutationChain.current = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    },
    [repo]
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // F5：metadataOnly 启动只读档案与媒体元数据（单张坏图不再阻断正文恢复）；
        // 原件按需经 loadMediaBlob 逐张读取，失败仅影响该条目。
        const [nextArchive, nextMedia] = metadataOnly && repo.loadMediaMetadata
          ? await Promise.all([repo.loadArchive(), repo.loadMediaMetadata()])
          : await Promise.all([repo.loadArchive(), repo.loadMedia()]);
        if (cancelled) return;
        archiveRef.current = nextArchive;
        loaded.current = true;
        setArchive(nextArchive);
        setMedia(nextMedia);
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "记录存储不可用。");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repo, metadataOnly]);

  useEffect(() => {
    let cancelled = false;
    // P2-b：metadataOnly 不自动全量补齐 URL——显示消费方走统一按需出口
    // （peek/load 显式读取）；此处只服务已有 blob 的桌面路径。
    const missing = metadataOnly ? media.filter((item) => item.blob && !(item.id in mediaUrls)) : media.filter((item) => !(item.id in mediaUrls));
    if (missing.length === 0) return;
    (async () => {
      const entries: Record<string, string> = {};
      for (const item of missing) {
        try {
          if (item.blob) entries[item.id] = await blobToDataUrl(item.blob);
          else if (!metadataOnly) {
            const blob = await repo.loadMediaBlob(item.id);
            if (!blob) entries[item.id] = "";
            else {
              const url = URL.createObjectURL(blob);
              objectUrlsRef.current.add(url);
              entries[item.id] = url;
            }
          } else entries[item.id] = "";
        } catch {
          entries[item.id] = "";
        }
      }
      if (!cancelled) setMediaUrls((current) => ({ ...current, ...entries }));
    })();
    return () => {
      cancelled = true;
    };
  }, [media, mediaUrls]);

  /**
   * 保存一条记录：先写媒体、再写消息。任一步失败都不产生半条记录，
   * 由调用方保留用户输入。
   */
  const addMessage = useCallback(
    async (input: { text: string; media?: CaptureMedia[] }) => {
      const pendingMedia = input.media ?? [];
      try {
        // 媒体先落库：消息一旦引用它就必须已经存在（不会留下缺图记录）。
        if (pendingMedia.length > 0) await repo.saveMedia(pendingMedia);
        const message = await applyMutation((current) => {
          const created = createCaptureMessage(current, {
            text: input.text,
            mediaIds: pendingMedia.map((item) => item.id)
          });
          return { next: created.archive, value: created.message };
        });
        if (pendingMedia.length > 0) await refreshMedia();
        return message;
      } catch (saveError) {
        throw saveError instanceof Error ? saveError : new Error("CAPTURE_SAVE_FAILED");
      }
    },
    [applyMutation, repo]
  );

  /**
   * 020-C：编辑已有记录。
   *
   * 顺序很重要：**先保存新媒体，再原地更新消息**。
   * - 消息更新失败（冲突/存储错误）时，旧记录保持原样，草稿由调用方保留；
   * - 新媒体的二进制先落库，但不引用它的消息不会被提交，因此不会出现“缺图记录”；
   * - 不物理删除任何既有媒体（移除只是从本条记录的引用里去掉）。
   */
  const updateMessage = useCallback(
    async (input: {
      messageId: string;
      text: string;
      mediaIds: string[];
      expectedUpdatedAt: string;
      newMedia?: CaptureMedia[];
    }) => {
      const pendingMedia = input.newMedia ?? [];
      if (pendingMedia.length > 0) await repo.saveMedia(pendingMedia);
      // CAS 在保护边界内对权威状态判定；落盘成功才返回 updated。
      const result = await applyMutation<ReturnType<typeof updateCaptureMessage>>((current) => {
        const outcome = updateCaptureMessage(
          current,
          input.messageId,
          { text: input.text, mediaIds: input.mediaIds },
          input.expectedUpdatedAt
        );
        return outcome.status === "updated"
          ? { next: outcome.archive, value: outcome }
          : { next: current, value: outcome };
      });
      if (result.status === "updated" && pendingMedia.length > 0) await refreshMedia();
      return result;
    },
    [applyMutation, repo]
  );

  const archiveMessages = useCallback(
    async (messageIds: string[]) => {
      await applyMutation((current) => ({
        next: markMessagesArchived(current, messageIds),
        value: undefined
      }));
    },
    [applyMutation]
  );

  const deleteMessage = useCallback(
    async (messageId: string) => {
      // 只解除消息与媒体的引用；媒体原件保留（本阶段不做回收）。
      await applyMutation((current) => ({
        next: removeCaptureMessage(current, messageId),
        value: undefined
      }));
    },
    [applyMutation]
  );

  const reload = useCallback(async () => {
    const [nextArchive, nextMedia] = metadataOnly && repo.loadMediaMetadata
      ? await Promise.all([repo.loadArchive(), repo.loadMediaMetadata()])
      : await Promise.all([repo.loadArchive(), repo.loadMedia()]);
    archiveRef.current = nextArchive;
    loaded.current = true;
    setArchive(nextArchive);
    setMedia(nextMedia);
  }, [repo, metadataOnly]);

  /**
   * B4/G5/J5/K4：单图按需读取的统一出口（metadataOnly 启动不预读全库的配套）。
   * 读到原件即建 objectURL 并并入 mediaUrls（其他展示位随之可用）；
   * 返回 null 表示该媒体不存在；读取异常原样抛出（missing ≠ error）。
   * J5/K4 生命周期代数不复用且按实例失效：setup 捕获本次自己的单调身份；
   * cleanup 无条件把本实例代数失效（置 0，永不与有效代数重合）——同类实例
   * 重叠卸载 A 时 A 的旧读取随 A 卸载失效，不受 B 代数影响。
   */
  const lifecycleRef = useRef(0);
  useEffect(() => {
    const identity = ++captureLifecycleCounter;
    lifecycleRef.current = identity;
    return () => {
      if (lifecycleRef.current === identity) lifecycleRef.current = 0;
    };
  }, []);
  const loadMediaView = useCallback(
    async (mediaId: string): Promise<string | null> => {
      const generation = lifecycleRef.current;
      // J5/K4：generation ≤ 0 表示生命周期已失效（卸载/封存）——入口即拒绝。
      if (generation <= 0) return null;
      const blob = await repo.loadMediaBlob(mediaId);
      if (!blob || lifecycleRef.current !== generation) return null;
      const url = URL.createObjectURL(blob);
      objectUrlsRef.current.add(url);
      setMediaUrls((current) => ({ ...current, [mediaId]: url }));
      return url;
    },
    [repo]
  );

  return {
    messages: listCaptureMessages(archive),
    archive,
    media,
    mediaUrls,
    error,
    repository: repo,
    addMessage,
    updateMessage,
    archiveMessages,
    deleteMessage,
    reload,
    loadMediaView,
    storage: getBrowserStorage()
  };
}

export type NativeArchiveImageState = {
  state: "idle" | "loading" | "ready" | "missing" | "error";
  url: string | undefined;
  retry: () => void;
};

/**
 * B4：随记图片显示分态。mediaUrls 已有 URL 直接 ready（不重复读取）；
 * 否则经 load 单图读取：null→missing、异常→error，显式重试会再读一次。
 * 有效图片不会因 mediaUrls 为空被误报不可用——显示组件先呈现 loading 再转 ready。
 */
export function useNativeCaptureImage(
  mediaId: string | null,
  mediaUrls: Record<string, string>,
  load?: (mediaId: string) => Promise<string | null>
): NativeArchiveImageState {
  const [attempt, setAttempt] = useState(0);
  const [outcome, setOutcome] = useState<{ state: "loading" | "ready" | "missing" | "error"; url?: string }>({ state: "loading" });
  const existing = mediaId ? mediaUrls[mediaId] : undefined;
  useEffect(() => {
    if (!mediaId || !load || existing) return;
    let cancelled = false;
    setOutcome({ state: "loading" });
    void load(mediaId)
      .then((url) => { if (!cancelled) setOutcome(url ? { state: "ready", url } : { state: "missing" }); })
      .catch(() => { if (!cancelled) setOutcome({ state: "error" }); });
    return () => { cancelled = true; };
  }, [mediaId, load, attempt, existing]);
  if (!mediaId) return { state: "idle", url: undefined, retry: () => undefined };
  if (existing) return { state: "ready", url: existing, retry: () => undefined };
  // 非原生（无按需出口）：保持既有语义，缺 URL 即显示不可用，不挂“读取中”。
  if (!load) return { state: "missing", url: undefined, retry: () => undefined };
  return { state: outcome.state, url: outcome.url, retry: () => setAttempt((current) => current + 1) };
}

export type { CaptureMessage };
