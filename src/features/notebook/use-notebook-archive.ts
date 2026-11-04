"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { loadAllJournals } from "@/features/journal/journal-storage";

/** J5：模块级单调代数计数器（不复用）——每个 hook 实例的每个生命周期取唯一值。 */
let notebookLifecycleCounter = 0;
import {
  copyLegacyJournal,
  inspectLegacyData,
  linkLegacyJournals,
  type LegacyInspection,
  type LegacyJournalCandidate
} from "./legacy-compat";
import {
  createNotebook,
  createPage,
  listTrash,
  movePage as moveNotebookPage,
  renameNotebook,
  restoreNotebook as restoreNotebookEntry,
  restorePage as restoreNotebookPage,
  softDeleteNotebook,
  softDeletePage,
  updatePage as updateNotebookPage,
  type NotebookMedia,
  type NotebookPageBlock,
  type PageEditBaseline,
  type PurgeTarget
} from "./notebook-model";
import { migrateLegacyLocalStorage, type MigrationReport } from "./notebook-migration";
import { setPageRegions } from "./page-regions-command";
import type { NotebookRevision } from "./notebook-model";
import {
  checkBatchSize,
  checkSingleAssetSize,
  formatCapacityViolation,
  PAGE_CAPACITY_LIMITS
} from "./notebook-capacity";
import {
  assertCapacityForChange,
  assertChangedPagesMediaResolvableSync,
  resolvableMediaIds
} from "./notebook-write-guards";
import {
  createIndexedDbRepository,
  EMPTY_ARCHIVE_CORE,
  RevisionConflictError,
  type ArchiveCore,
  type NotebookMediaMeta,
  type NotebookRepository
} from "./notebook-repository";

/**
 * 写入边界校验：只校验本次图片引用发生变化的页面，规则与 AI 安全提交共用
 * （`notebook-write-guards.ts`），避免两条写路径各有一套保护。
 *
 * 媒体可解析性依据**实际媒体存储记录**（且带可用二进制），不是只看 id 或元数据。
 */
async function assertChangedPagesMediaResolvable(
  repository: NotebookRepository,
  next: ArchiveCore,
  pendingMedia: NotebookMedia[],
  allowedMissingMediaIds: string[]
): Promise<{ checkedPageIds: string[] }> {
  const stored = await repository.loadArchive();
  const mediaRecords = (await repository.loadMedia()) as unknown[];
  return assertChangedPagesMediaResolvableSync({
    stored,
    next,
    pendingMedia,
    storedResolvableIds: resolvableMediaIds(mediaRecords),
    allowedMissingMediaIds
  });
}

function getBrowserStorage(): Storage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}

function assertPendingMediaLimits(pendingMedia: NotebookMedia[]): void {
  const batchViolation = checkBatchSize(pendingMedia.length, PAGE_CAPACITY_LIMITS);
  if (batchViolation) throw new Error(formatCapacityViolation(batchViolation));
  for (const item of pendingMedia) {
    const violation = checkSingleAssetSize(
      { assetId: item.id, name: item.name, size: item.size },
      PAGE_CAPACITY_LIMITS
    );
    if (violation) throw new Error(formatCapacityViolation(violation));
  }
}

/** 并发预检的上限：不在事务内等待，也不把整篇二进制读进内存。 */
const MEDIA_PREVIEW_CONCURRENCY = 2;

/**
 * 笔记本地入口：结构化数据与媒体分别存放在独立 IndexedDB 存储中，
 * 统一经 NotebookRepository 访问，UI 不接触底层存储实现。
 *
 * T2a：提供 `namespace`（当前账号的 serverId/userId）时——
 * - 仓库按账号派生新 IDB 名，旧档案不自动继承；
 * - localStorage/旧版迁移入口关闭（beta/原生模式下不再读取旧私人档案）。
 * 仓库实例与账号绑定：切号 = 整棵应用树重挂载，迟到回调由各自的 cancelled
 * 守卫丢弃，且只会写回**原账号**的仓库，不会写进新账号的库。
 */
export function useNotebookArchive(
  repository?: NotebookRepository,
  namespace?: { serverId: string; userId: string },
  /** T5 原生模式：媒体按需取原件，不整批载入内存。 */
  options?: { metadataOnly?: boolean }
) {
  // 仓库实例在挂载期内稳定；用 state 懒初始化，避免渲染期读取 ref。
  const [repo] = useState<NotebookRepository>(() =>
    repository ?? (namespace ? createIndexedDbRepository(undefined, undefined, namespace) : createIndexedDbRepository())
  );
  const [archive, setArchive] = useState<ArchiveCore>(EMPTY_ARCHIVE_CORE);
  const archiveRef = useRef<ArchiveCore>(EMPTY_ARCHIVE_CORE);
  /** 工作台回合内现读同一本地实例，沿用加载/提交/重读已更新的引用。 */
  const getArchive = useCallback(() => archiveRef.current, []);
  /** F5：媒体视图（blob 可选）——metadataOnly 下为元数据条目，按需补原件。 */
  const [media, setMedia] = useState<(Omit<NotebookMedia, "blob"> & { blob?: Blob })[]>([]);
  /**
   * 媒体展示 URL（objectURL，指向存储的原件 Blob）。
   * 旧实现把每个原件转成完整 dataURL 常驻内存（base64 膨胀 ~33%）；objectURL 只保留
   * 一个 Blob 引用，展示像素不变，卸载/删除时释放。需要 dataURL 的消费方（如工作台
   * 附件）在选中时按需 fetch 回 Blob 再编码。
   */
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({});
  /** 本 hook 创建、待释放的 objectURL；跨渲染累记，卸载统一 revoke。 */
  const objectUrlsRef = useRef<Set<string>>(new Set());
  const [ready, setReady] = useState(false);
  const [migration, setMigration] = useState<MigrationReport>();
  const [storageError, setStorageError] = useState<string>();
  /** 篇级媒体元数据：容量计量与计数走这里，不读二进制。 */
  const [mediaMeta, setMediaMeta] = useState<NotebookMediaMeta[]>([]);
  /** F5：metadataOnly（原生）——启动只读元数据，原件按需取；blob 可选的媒体视图。 */
  const metadataOnly = options?.metadataOnly === true;
  /** 乐观并发冲突（另一实例已提交更新）：保留草稿，不自动覆盖。 */
  const [revisionConflict, setRevisionConflict] = useState<
    { expectedRevision: number; actualRevision: number } | undefined
  >();

  useEffect(() => {
    let cancelled = false;
    if (!repo) return;
    (async () => {
      try {
        // T2a：beta（按账号命名空间）下关闭 localStorage 迁移入口，不读取旧私人档案。
        const storage = namespace ? undefined : getBrowserStorage();
        if (storage) {
          const report = await migrateLegacyLocalStorage(repo, storage);
          if (!cancelled && report.status !== "skipped-empty") setMigration(report);
        }
        // F5：metadataOnly 启动不读原件（单张坏图不阻断正文恢复）；URL 按需取。
        const [nextArchive, nextMedia, nextMeta] = metadataOnly
          ? await Promise.all([repo.loadArchive(), repo.loadMediaMetadata().then(meta => meta as (Omit<NotebookMedia, "blob"> & { blob?: Blob })[]), repo.loadMediaMetadata()])
          : await Promise.all([
              repo.loadArchive(),
              repo.loadMedia(),
              repo.loadMediaMetadata()
            ]);
        if (cancelled) return;
        archiveRef.current = nextArchive;
        setArchive(nextArchive);
        setMedia(nextMedia);
        setMediaMeta(nextMeta);
      } catch (error) {
        if (!cancelled) {
          setStorageError(error instanceof Error ? error.message : "本地存储不可用。");
        }
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repo, namespace]);

  // 媒体 Blob 按需转成可渲染的 objectURL，失败时留空而不是伪造图片；
  // 媒体消失（删除）时释放对应 URL，不滞留 Blob 引用。
  useEffect(() => {
    const live = new Set(media.map((item) => item.id));
    const stale = Object.entries(mediaUrls).filter(([id]) => !live.has(id));
    if (stale.length > 0) {
      for (const [, url] of stale) {
        if (url) URL.revokeObjectURL(url);
        objectUrlsRef.current.delete(url);
      }
      setMediaUrls((current) => Object.fromEntries(Object.entries(current).filter(([id]) => live.has(id))));
    }
    // P2-b：metadataOnly 不自动全量读取原件——显示消费方按需取（统一出口）。
    const missing = metadataOnly ? media.filter((item) => item.blob && !(item.id in mediaUrls)) : media.filter((item) => !(item.id in mediaUrls));
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      // F5：逐张生成，单张失败只置空占位（不影响其他条目）；元数据视图按需取原件。
      const entries: Record<string, string> = {};
      for (const item of missing) {
        if (cancelled) return;
        try {
          const blob = item.blob ?? (metadataOnly ? undefined : await repo.loadMediaBlob(item.id));
          if (!blob) { entries[item.id] = ""; continue; }
          const url = URL.createObjectURL(blob);
          objectUrlsRef.current.add(url);
          entries[item.id] = url;
        } catch {
          entries[item.id] = "";
        }
      }
      if (!cancelled) setMediaUrls((current) => ({ ...current, ...entries }));
    })();
    return () => { cancelled = true; };
  }, [media, mediaUrls, repo]);

  // 卸载时释放全部 objectURL：组件销毁后 Blob 引用不再滞留。
  useEffect(
    () => () => {
      for (const url of objectUrlsRef.current) URL.revokeObjectURL(url);
      objectUrlsRef.current.clear();
    },
    []
  );

  /**
   * 串行化的写入口：每次改动都基于“最新”档案，而不是组件渲染时的闭包快照。
   * 否则“先创建笔记本、再创建页面”这类连续操作会读到过期档案，
   * 导致新页面因笔记本缺失而在规范化时被当作孤儿丢弃（已由浏览器验收发现）。
   *
   * `media` 会在写入档案之前先落库：媒体写入失败就整体失败，
   * 因此不会出现“页面已保存但图片缺失”的已完成记录。
   */
  /**
   * 写操作串行队列：并发/交错调用会依次执行，每个改动都基于前一个改动之后的最新档案。
   * 队列只保证**本实例**内的顺序；跨实例/跨标签的正确性由 Repository 的
   * `commitJournalChange`（事务内比较 revision）保证，见 014-A 契约。
   */
  const writeQueue = useRef<Promise<unknown>>(Promise.resolve());
  /** 上次写入是否因 revision 冲突失败：冲突后不自动重试，等用户确认最新状态。 */
  const conflictReported = useRef(false);

  const mutate = useCallback(
    async <T>(
      change: (current: ArchiveCore) => {
        archive: ArchiveCore;
        result: T;
        media?: NotebookMedia[];
        /** 编辑前已存在、允许保留的缺失媒体引用。 */
        allowedMissingMediaIds?: string[];
      }
    ): Promise<T> => {
      if (!repo) throw new Error("NOTEBOOK_STORAGE_UNAVAILABLE");
      const run = async (): Promise<T> => {
        const current = await repo.loadArchive();
        archiveRef.current = current;
        // 队列保证每次改动都基于最新档案；提交时以刚读到的 revision 做事务内比较，
        // 读取之后被其他实例改动就会明确冲突，而不是静默覆盖。
        const expectedRevision = current.revision;
        const {
          archive: next,
          result,
          media: pendingMedia,
          allowedMissingMediaIds
        } = change(current);
        // 0) 媒体自身的单张/批次上限（在写库之前拒绝，避免留下无用资产）。
        if (pendingMedia && pendingMedia.length > 0) assertPendingMediaLimits(pendingMedia);
        // 1) 写入边界校验：只校验本次图片引用发生变化的页面。
        await assertChangedPagesMediaResolvable(
          repo,
          next,
          pendingMedia ?? [],
          allowedMissingMediaIds ?? []
        );
        // 2) 容量校验：提交后的最终引用集，超限整次拒绝并保留草稿。
        const assetSizes = new Map<string, number>(
          (await repo.loadMediaMetadata()).map((item) => [item.id, item.size] as const)
        );
        assertCapacityForChange(current, next, pendingMedia ?? [], assetSizes);
        // 3) 事务内“读最新档案 → 校验 revision → 写入媒体与档案”：
        //    任一步失败整体回滚，不留下本次新增的孤儿媒体。
        // 事务内以“读取时的 revision”比较：读取之后、提交之前被其他实例改动时明确冲突，
        // 而不是用事务内的最新值静默覆盖（那会丢失其他实例的提交）。
        const committed = await repo.commitJournalChange(() => next, {
          expectedRevision,
          ...(pendingMedia && pendingMedia.length > 0 ? { media: pendingMedia } : {})
        });
        archiveRef.current = committed.archive;
        conflictReported.current = false;
        setArchive(committed.archive);
        setRevisionConflict(undefined);
        if (pendingMedia && pendingMedia.length > 0) {
          setMedia(await repo.loadMedia());
          // 新写入的媒体以重读后的 Blob 建 URL；旧 URL（若有）先释放。
          setMediaUrls((current) => {
            const keys = new Set(pendingMedia.map((item) => item.id));
            const next: Record<string, string> = {};
            for (const [mediaId, url] of Object.entries(current)) {
              if (keys.has(mediaId)) {
                if (url) URL.revokeObjectURL(url);
                objectUrlsRef.current.delete(url);
              } else next[mediaId] = url;
            }
            return next;
          });
        }
        return result;
      };
      const queued = writeQueue.current.then(run, run);
      // 队列本身不能因单个操作失败而中断。
      writeQueue.current = queued.catch(() => undefined);
      return queued.catch((error: unknown) => {
        if (error instanceof RevisionConflictError) {
          // 冲突不自动覆盖：保留草稿，并把真实冲突原因交给界面显示。
          conflictReported.current = true;
          setRevisionConflict({
            expectedRevision: error.expectedRevision,
            actualRevision: error.actualRevision
          });
        }
        throw error;
      });
    },
    [repo]
  );

  const addNotebook = useCallback(
    async (title: string) =>
      mutate((current) => {
        const { archive: next, notebook } = createNotebook(current, title);
        return { archive: next, result: notebook };
      }),
    [mutate]
  );

  const updateNotebookTitle = useCallback(
    async (notebookId: string, title: string) => {
      await mutate((current) => ({
        archive: renameNotebook(current, notebookId, title),
        result: undefined
      }));
    },
    [mutate]
  );

  /** 保存页面：媒体与页面一起提交，任一步失败都不留下引用缺失媒体的页面。 */
  const addPage = useCallback(
    async (input: {
      notebookId: string;
      title: string;
      blocks: NotebookPageBlock[];
      media?: NotebookMedia[];
    }) => {
      const { media: pendingMedia, ...pageInput } = input;
      return mutate((current) => {
        const { archive: next, page } = createPage(current, pageInput);
        return { archive: next, result: page, media: pendingMedia };
      });
    },
    [mutate]
  );

  /**
   * 更新已保存页面（标题/正文/图片引用）。界面不直接接触存储。
   * 新图片与页面一起提交；失败时原页面保持完整。
   */
  const updatePage = useCallback(
    async (
      pageId: string,
      changes: {
        title?: string;
        blocks?: NotebookPageBlock[];
        media?: NotebookMedia[];
        allowedMissingMediaIds?: string[];
        /** 024：打开编辑时的页级基线；不符时抛 PageBaselineConflictError。 */
        baseline?: PageEditBaseline;
      }
    ) => {
      const { media: pendingMedia, allowedMissingMediaIds, ...pageChanges } = changes;
      return mutate((current) => {
        const { archive: next, page } = updateNotebookPage(current, pageId, pageChanges);
        return {
          archive: next,
          result: page,
          media: pendingMedia,
          allowedMissingMediaIds
        };
      });
    },
    [mutate]
  );

  /**
   * 移动笔记到另一个笔记本：只改归属，不动内容与媒体。
   * 同一本返回 moved:false（无操作）；失败时保持原归属。
   */
  const movePage = useCallback(
    async (pageId: string, targetNotebookId: string) => {
      const outcome = await mutate((current) => {
        const result = moveNotebookPage(current, pageId, targetNotebookId);
        return { archive: result.archive, result };
      });
      return { moved: outcome.moved, page: outcome.page };
    },
    [mutate]
  );

  /**
   * 024：删除页面 = 进入垃圾桶（软删除）。
   * 保留原归属与全部内容，便于恢复；不物理删除媒体。
   */
  const deletePage = useCallback(
    async (pageId: string) => {
      return mutate((current) => {
        const outcome = softDeletePage(current, pageId);
        return { archive: outcome.archive, result: outcome };
      });
    },
    [mutate]
  );

  /** 024：删除整本（只标记本，子页状态不变）。 */
  const deleteNotebook = useCallback(
    async (notebookId: string) => {
      return mutate((current) => {
        const outcome = softDeleteNotebook(current, notebookId);
        return { archive: outcome.archive, result: outcome };
      });
    },
    [mutate]
  );

  /** 024：恢复本（不复活此前单独删除的子页）。 */
  const restoreNotebook = useCallback(
    async (notebookId: string) => {
      return mutate((current) => {
        const outcome = restoreNotebookEntry(current, notebookId);
        return { archive: outcome.archive, result: outcome.notebook };
      });
    },
    [mutate]
  );

  /**
   * 024：恢复页。原归属失效时必须显式指定有效目标本，
   * 否则抛 `PAGE_RESTORE_TARGET_REQUIRED`（界面据此提示选择目标）。
   */
  const restorePage = useCallback(
    async (pageId: string, targetNotebookId?: string) => {
      return mutate((current) => {
        const outcome = restoreNotebookPage(current, pageId, targetNotebookId);
        return { archive: outcome.archive, result: outcome.page };
      });
    },
    [mutate]
  );

  /**
   * 024：永久删除垃圾桶条目。
   * 目标由确认时冻结，Repository 在事务内重新核对身份与 revision；
   * 媒体只回收本次待删页引用且删除后无人引用者。
   */
  const purgeTrash = useCallback(
    async (targets: PurgeTarget[] | "expired") => {
      if (!repo) throw new Error("NOTEBOOK_STORAGE_UNAVAILABLE");
      const run = async (): Promise<Awaited<ReturnType<NotebookRepository["purgeTrash"]>>> => {
        const current = await repo.loadArchive();
        const expectedRevision = current.revision;
        let frozenTargets: PurgeTarget[] = targets === "expired" ? [] : targets;
        if (targets === "expired") {
          const trash = listTrash(current);
          frozenTargets = Number.isFinite(Date.parse(current.trashConfirmedAt ?? ""))
            ? [
                ...trash.notebooks.filter((entry) => entry.expired).map((entry) => ({
                  kind: "notebook" as const, id: entry.notebook.id, deletedAt: entry.deletedAt
                })),
                ...trash.pages.filter((entry) => entry.expired).map((entry) => ({
                  kind: "page" as const, id: entry.page.id, deletedAt: entry.deletedAt
                }))
              ]
            : [];
        }
        if (frozenTargets.length === 0) {
          return { status: "skipped", archive: current, reason: "no-targets", skipped: [] };
        }
        const outcome = await repo.purgeTrash({ targets: frozenTargets, expectedRevision });
        if (outcome.status === "purged") {
          archiveRef.current = outcome.archive;
          setArchive(outcome.archive);
          const [nextMedia, nextMeta] = metadataOnly
            ? await Promise.all([repo.loadMediaMetadata().then(meta => meta as (Omit<NotebookMedia, "blob"> & { blob?: Blob })[]), repo.loadMediaMetadata()])
            : await Promise.all([repo.loadMedia(), repo.loadMediaMetadata()]);
          setMedia(nextMedia);
          setMediaMeta(nextMeta);
          return outcome;
        }
        if (outcome.status === "conflict") {
          // 冲突：不写、不重试，界面提示后由用户确认最新状态。
          archiveRef.current = current;
          setArchive(current);
        }
        return outcome;
      };
      const queued = writeQueue.current.then(run, run);
      writeQueue.current = queued.catch(() => undefined);
      return queued;
    },
    [repo]
  );

  const setTrashAutoCleanup = useCallback(async (enabled: boolean) => {
    await mutate((current) => ({
      archive: { ...current, trashConfirmedAt: enabled ? new Date().toISOString() : null },
      result: undefined
    }));
  }, [mutate]);

  useEffect(() => {
    if (!ready) return;
    let pending = false;
    let cancelled = false;
    const check = async () => {
      if (pending || cancelled || document.visibilityState === "hidden") return;
      pending = true;
      try {
        const outcome = await purgeTrash("expired");
        if (!cancelled && outcome.status === "conflict")
          setStorageError("垃圾桶在别处已变化，本次自动清理未执行。");
      } catch (error) {
        if (!cancelled) setStorageError(error instanceof Error ? error.message : "垃圾桶自动清理失败。");
      } finally {
        pending = false;
      }
    };
    void check();
    // 只在应用打开期间检查；回到前台重新读取持久化许可和删除时间。
    const timer = window.setInterval(() => void check(), 60 * 60 * 1000);
    const onVisible = () => void check();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [ready, archive.trashConfirmedAt, purgeTrash]);

  // T2a：beta（按账号命名空间）下旧档案迁移入口整体关闭——inspect 恒为空、
  // link/copy 明确失败，不读取也不落任何旧 localStorage 资料。
  const inspectLegacy = useCallback((): LegacyInspection => {
    if (namespace) return { journals: [], trips: [] };
    const storage = getBrowserStorage();
    if (!storage) return { journals: [], trips: [] };
    return inspectLegacyData(archive, storage);
  }, [archive, namespace]);

  /** 旧版关联查看：只建立引用页与来源映射，不复制正文与图片。 */
  const linkLegacy = useCallback(async () => {
    if (namespace) return { linkedCount: 0, skippedAlreadyLinked: 0 };
    const storage = getBrowserStorage();
    if (!storage) return { linkedCount: 0, skippedAlreadyLinked: 0 };
    return mutate((current) => {
      const inspection = inspectLegacyData(current, storage);
      const result = linkLegacyJournals(current, inspection.journals);
      return {
        archive: result.archive,
        result: {
          linkedCount: result.linkedCount,
          skippedAlreadyLinked: result.skippedAlreadyLinked
        }
      };
    });
  }, [mutate]);

  /**
   * 独立复制：媒体事务前落库、结构化数据在事务内提交。
   * 任一步失败都不写入复制结果，因此不会出现“标记成功但图片缺失”的状态，界面保持未复制且可重试。
   */
  const copyLegacy = useCallback(
    async (candidate: LegacyJournalCandidate, options: { force?: boolean } = {}) => {
      if (namespace) {
        return {
          status: "failed" as const,
          issues: ["当前为按账号隔离的资料库，旧资料迁移入口已关闭。"],
          copiedMediaCount: 0
        };
      }
      const storage = getBrowserStorage();
      if (!repo || !storage) {
        return {
          status: "failed" as const,
          issues: ["本地存储不可用，未复制。"],
          copiedMediaCount: 0
        };
      }
      const journal = loadAllJournals(storage)[candidate.spotId];
      try {
        const outcome = await mutate((current) => {
          const result = copyLegacyJournal(current, candidate, {
            spotId: candidate.spotId,
            journal,
            force: options.force
          });
          return { archive: result.archive, result, media: result.media };
        });
        if (!outcome.copied) {
          return {
            status: outcome.status,
            issues: outcome.issues,
            copiedMediaCount: outcome.copiedMediaCount
          };
        }
        return {
          status: outcome.status,
          issues: outcome.issues,
          copiedMediaCount: outcome.copiedMediaCount
        };
      } catch (error) {
        return {
          status: "failed" as const,
          issues: [
            error instanceof Error
              ? `写入本地存储失败：${error.message}`
              : "写入本地存储失败，未标记为已复制。"
          ],
          copiedMediaCount: 0
        };
      }
    },
    [mutate, repo, namespace]
  );

  const reload = useCallback(async () => {
    if (!repo) return;
    const [nextArchive, nextMedia, nextMeta] = await Promise.all([
      repo.loadArchive(),
      repo.loadMedia(),
      repo.loadMediaMetadata()
    ]);
    archiveRef.current = nextArchive;
    setArchive(nextArchive);
    setMedia(nextMedia);
    setMediaMeta(nextMeta);
  }, [repo]);

  /**
   * 014-C 地区命令：校验目录/可编辑 → revision 比较事务写入。
   * `expectedRevision` 由**打开编辑时的基线**传入：期间其他实例提交过就明确冲突，
   * 不会用最新 revision 覆盖对方的修改；未传时回退到读取当前 revision。
   * 只改该篇 meta.regions 与 updatedAt，不动正文、媒体、来源关联与收据。
   */
  const setRegions = useCallback(
    async (
      pageId: string,
      regionIds: string[],
      expectedRevision?: NotebookRevision,
      options?: Parameters<typeof setPageRegions>[0]["sources"] & {
        tripDateRange?: import("./notebook-model").TripDateRange | null;
      }
    ) => {
      if (!repo) throw new Error("NOTEBOOK_STORAGE_UNAVAILABLE");
      const repository = repo;
      const run = async () => {
        const baseline = expectedRevision ?? (await repository.loadArchive()).revision;
        const outcome = await setPageRegions(
          {
            pageId,
            regionIds,
            expectedRevision: baseline,
            sources: options
              ? {
                  add: options.add,
                  removeIds: options.removeIds,
                  manualReaffirm: options.manualReaffirm
                }
              : undefined,
            tripDateRange: options?.tripDateRange
          },
          { repository }
        );
        if (outcome.status === "conflict") {
          setRevisionConflict({
            expectedRevision: outcome.expectedRevision,
            actualRevision: outcome.actualRevision
          });
          throw new RevisionConflictError(outcome.expectedRevision, outcome.actualRevision);
        }
        if (outcome.status === "saved") {
          setRevisionConflict(undefined);
          await reload();
        }
        return outcome;
      };
      // 与其它写入口共用同一队列，避免本实例内交错覆盖。
      const queued = writeQueue.current.then(run, run);
      writeQueue.current = queued.catch(() => undefined);
      return queued;
    },
    [reload, repo]
  );

  /**
   * 按需读取媒体二进制（有限并发）。预览不预读全库，退出时由调用方释放对象 URL。
   */
  const loadMediaPreview = useCallback(
    async (mediaIds: string[]): Promise<Record<string, Blob | undefined>> => {
      if (!repo) return {};
      const result: Record<string, Blob | undefined> = {};
      for (let index = 0; index < mediaIds.length; index += MEDIA_PREVIEW_CONCURRENCY) {
        const slice = mediaIds.slice(index, index + MEDIA_PREVIEW_CONCURRENCY);
        const blobs = await repo.loadMediaBlobs(slice);
        slice.forEach((mediaId, offset) => {
          result[mediaId] = blobs[offset];
        });
      }
      return result;
    },
    [repo]
  );

  /**
   * 单张下载原图：字节 = 存储的原件 Blob，不经任何重编码；
   * 文件名用媒体原名（缺扩展名时按真实 MIME 补齐）。供详情面板等入口调用。
   */
  const downloadMedia = useCallback(
    async (mediaId: string): Promise<{ ok: boolean; message?: string }> => {
      const target = media.find((item) => item.id === mediaId);
      if (!target) return { ok: false, message: "这张图片已不在本地存储中。" };
      const extension =
        target.type === "image/png" ? "png" : target.type === "image/webp" ? "webp" : "jpg";
      // F5：元数据视图下按需取原件；取不到如实失败，不用空 Blob 冒充。
      const blob = target.blob ?? await repo.loadMediaBlob(mediaId);
      if (!blob) return { ok: false, message: "原图暂不可读，请稍后重试。" };
      const link = document.createElement("a");
      link.href = mediaUrls[mediaId] ?? URL.createObjectURL(blob);
      link.download = /\.[a-z0-9]{2,5}$/i.test(target.name) ? target.name : `${target.name}.${extension}`;
      link.rel = "noopener";
      link.click();
      if (!mediaUrls[mediaId]) URL.revokeObjectURL(link.href);
      return { ok: true, message: "已下载原图（与笔记中保存的字节一致）。" };
    },
    [media, mediaUrls]
  );

  /**
   * B4/G5/J5/K4：单图按需读取二进制（metadataOnly 的统一出口，封面缩略图等派生管线共用）。
   * 读到的 blob 同时补进 media 视图（内存中的候选随之可解码，不重读库）；
   * 返回 undefined 表示不存在；读取异常原样抛出（missing ≠ error）。
   * J5/K4 生命周期代数不复用且按实例失效：setup 捕获本次自己的单调身份并写入
   * 实例 ref；cleanup 无条件把**本实例**代数失效（置 0，永不与任何有效代数重合）
   * ——同类实例重叠（A 挂载→B 挂载→A 卸载）时 A 的旧读取随 A 卸载失效，不受
   * B 的代数影响；StrictMode 重放产生新代数，读取照常。
   */
  const lifecycleRef = useRef(0);
  useEffect(() => {
    const identity = ++notebookLifecycleCounter;
    lifecycleRef.current = identity;
    return () => {
      if (lifecycleRef.current === identity) lifecycleRef.current = 0;
    };
  }, []);
  const readMediaBlob = useCallback(
    async (mediaId: string): Promise<Blob | undefined> => {
      if (!repo) return undefined;
      const generation = lifecycleRef.current;
      // L3：入口即拒绝无效生命周期（卸载/封存）——不触碰 Repository（读取
      // 异常不外泄），await 后继续复核代数（期间失效同样返回 undefined）。
      if (generation <= 0 || lifecycleRef.current !== generation) return undefined;
      const blob = await repo.loadMediaBlob(mediaId);
      // J5/K4：generation ≤ 0 表示生命周期已失效（卸载/封存）——入口即拒绝。
      if (!blob || generation <= 0 || lifecycleRef.current !== generation) return undefined;
      setMedia((current) =>
        current.some((item) => item.id === mediaId && !item.blob)
          ? current.map((item) => (item.id === mediaId ? { ...item, blob } : item))
          : current
      );
      return blob;
    },
    [repo]
  );

  /** B4：单图按需读取并建展示 objectURL（与随记 loadMediaView 同契约）。 */
  const loadMediaView = useCallback(
    async (mediaId: string): Promise<string | null> => {
      const generation = lifecycleRef.current;
      // L3：入口即拒绝无效生命周期（卸载/封存）。
      if (generation <= 0 || lifecycleRef.current !== generation) return null;
      const blob = await readMediaBlob(mediaId);
      // G5/H5/J5/K4：挂载生命周期已结束（卸载/封存，generation ≤ 0 或代数漂移）
      // ——不创建无人回收的 objectURL。
      if (!blob || generation <= 0 || lifecycleRef.current !== generation) return null;
      const url = URL.createObjectURL(blob);
      objectUrlsRef.current.add(url);
      setMediaUrls((current) => ({ ...current, [mediaId]: url }));
      return url;
    },
    [readMediaBlob]
  );

  return {
    archive,
    getArchive,
    revision: archive.revision,
    media,
    mediaMeta,
    revisionConflict,
    mediaUrls,
    downloadMedia,
    readMediaBlob,
    loadMediaView,
    ready,
    migration,
    storageError,
    repository: repo,
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
    loadMediaPreview,
    reload
  };
}


/**
 * B4：笔记图片显示分态（与随记 useNativeCaptureImage 同契约）。
 * mediaUrls 已有 URL 直接 ready（不重复读取）；否则经 load 单图读取：
 * null→missing、异常→error，显式重试会再读一次。有效图片不会因
 * mediaUrls 为空被误报不可用——显示组件先呈现 loading 再转 ready。
 */
export function useNativeNotebookImage(
  mediaId: string | null,
  mediaUrls: Record<string, string>,
  load?: (mediaId: string) => Promise<string | null>
): { state: "idle" | "loading" | "ready" | "missing" | "error"; url: string | undefined; retry: () => void } {
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
