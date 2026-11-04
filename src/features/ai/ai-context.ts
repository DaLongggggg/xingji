/**
 * P1-01：AI Context DTO 与只读读取路径（Phase 1）。
 *
 * 数据流：现有领域快照（ArchiveCore）→ 可见性与任务范围过滤 → 预算内组装 DTO。
 * 任务不遍历 Archive、不触碰 IndexedDB；Provider 只拿一份快照 + 媒体元数据查询。
 * 全部方法只读：不改传入对象、不写任何存储、不调用模型。
 */
import {
  findTripJournal,
  listActiveNotebookPages,
  listActiveNotebooks,
  type Notebook,
  type NotebookMedia,
  type NotebookPage,
  type NotebookPageBlock,
  type NotebookRegionRef
} from "../notebook/notebook-model";
import { getPageText } from "../notebook/notebook-query";
import type { ArchiveCore } from "../notebook/notebook-repository";

/** 缺失原因：明确区分“不存在/不可用”与“存在但正文为空”。 */
export type AiMissingReason = "not-found" | "deleted" | "out-of-scope" | "over-budget";

export type AiRegionContext = {
  regionId: string;
  parentRegionId: string | null;
  level: NotebookRegionRef["level"];
  name: string;
  catalogVersion: string;
};

export type AiMediaContext = {
  id: string;
  name: string;
  type: string;
  size: number;
  /** 来源引用（本地上传 / 旧游记 / 记录箱）。只描述来源，不读取二进制。 */
  origin: NotebookMedia["origin"];
  availability: "available" | "missing";
};

/**
 * 有序块投影。`text` 保留完整正文（不截断）；`photo` 只保留 mediaId/caption，
 * 不携带 Blob 或 URL；`unsupported-image` 原样保留原文并显式标记为不可修改。
 */
export type AiBlockContext =
  | { blockId: string; kind: "text"; text: string }
  | { blockId: string; kind: "photo"; mediaId: string; caption: string; immutable: true }
  | { blockId: string; kind: "unsupported-image"; markdown: string; immutable: true };

export type AiPageContext = {
  id: string;
  notebookId: string;
  notebookTitle: string;
  title: string;
  /** 完整 text block 正文（按块顺序、块间换行）；不使用摘要或截断结果代替。 */
  text: string;
  blocks: AiBlockContext[];
  /** 空字符串表示这篇确实没有文字块，与不可用（getPage 返回 null）不同。 */
  capturedAt: string;
  createdAt: string;
  updatedAt: string;
  regions: AiRegionContext[];
  /** 仅元数据：不读取 Blob、不生成 Data URL、不下载图片。 */
  media: AiMediaContext[];
  sourceDigest: string;
};

export type AiNotebookContext = { id: string; title: string };

/** 任务允许读取的范围；`notebookIds: null` 表示不额外限制（仍受可见性过滤）。 */
export type AiReadScope = {
  notebookIds: string[] | null;
  /**
   * 正文读取预算（字符）。预算是**读入门槛**：超出的页整页不读并报 over-budget，
   * 绝不把正文截断后当作完整内容返回——部分正文对“整理”类任务就是错误输入。
   */
  maxTotalTextChars: number;
  maxPages: number;
  /** 默认 false：legacy 关联查看页（依赖旧游记存储）不进 AI 上下文。 */
  allowLegacyLinkedPages: boolean;
};

export const DEFAULT_AI_READ_SCOPE: AiReadScope = {
  notebookIds: null,
  maxTotalTextChars: 200_000,
  maxPages: 20,
  allowLegacyLinkedPages: false
};

export function createAiReadScope(overrides: Partial<AiReadScope> = {}): AiReadScope {
  return {
    ...DEFAULT_AI_READ_SCOPE,
    ...overrides,
    notebookIds:
      overrides.notebookIds === undefined
        ? DEFAULT_AI_READ_SCOPE.notebookIds
        : overrides.notebookIds
  };
}

/**
 * R1：范围**求交集**的唯一实现（本子与搜索共用，不再各写一份）。
 *
 * - `null`/`undefined` = 未指定范围（视为不限）；**空数组 = 不允许任何本**，绝不解释成“全部”；
 * - 两侧都给 → 取交集；任一侧为空 → 结果为空（明确拒绝，而不是忽略限制）。
 */
export function narrowNotebookScope(
  authorized: readonly string[] | null | undefined,
  requested: readonly string[] | null | undefined
): string[] | null {
  if (authorized === null || authorized === undefined) {
    return requested === null || requested === undefined ? null : [...requested];
  }
  if (requested === null || requested === undefined) return [...authorized];
  const allowed = new Set(authorized);
  return requested.filter((notebookId) => allowed.has(notebookId));
}

/**
 * R1：把方法级（或任务级）scope 叠加到已有 scope 上，**只能收窄**。
 * 覆盖范围、放宽可见性、抬高预算都被拒绝；这样调用方无法通过传参扩大读取权限。
 */
export function mergeAiReadScope(
  base: AiReadScope,
  override: Partial<AiReadScope> | undefined
): AiReadScope {
  if (!override) return base;
  return {
    notebookIds: narrowNotebookScope(base.notebookIds, override.notebookIds),
    maxTotalTextChars: Math.min(
      base.maxTotalTextChars,
      override.maxTotalTextChars ?? base.maxTotalTextChars
    ),
    maxPages: Math.min(base.maxPages, override.maxPages ?? base.maxPages),
    // 更严格的一侧生效：任一侧不允许 legacy 关联页，就不能读。
    allowLegacyLinkedPages: base.allowLegacyLinkedPages && (override.allowLegacyLinkedPages ?? true)
  };
}

/**
 * R1：把任务目标本收窄到授权范围内。
 * 返回 `null` 表示目标不在授权范围内（明确失败），否则返回只含目标本的集合。
 * 目标的 `notebookId` 必须**属于**授权集合；授权为空集合时任何目标都被拒绝。
 */
export function narrowScopeToNotebook(
  authorized: readonly string[] | null | undefined,
  notebookId: string
): string[] | null {
  const narrowed = narrowNotebookScope(authorized, [notebookId]);
  return narrowed === null || narrowed.length > 0 ? narrowed : null;
}

/** 任务范围外的读取请求：不静默忽略、不伪装成功。 */
export class AiScopeError extends Error {
  constructor(readonly reason: AiMissingReason) {
    super(`AI_SCOPE_${reason.toUpperCase().replace(/-/g, "_")}`);
    this.name = "AiScopeError";
  }
}

// —— sourceDigest ——
/**
 * 摘要规范 `xsd1`：任务实际消费的字段决定摘要。
 * 输入为「父本标题 + 页标题 + capturedAt + 有序块（id/类型/正文或 mediaId+caption 或原文）+
 * 被消费的地区 id」的稳定拼接，输出 `xsd1:<长度:哈希>`。
 * 因此标题、正文、块顺序、图片引用（mediaId/caption）、capturedAt 与地区变化都会改变摘要；
 * updatedAt、媒体 name/type/size、Blob 内容不参与。
 * 与 PageEditBaseline 的区别：后者只服务本地编辑冲突（updatedAt + blocksDigest，不含标题/
 * capturedAt/地区/父本标题），本摘要服务 AI 输入身份与 stale 判定，两者不互相替代。
 */
export const SOURCE_DIGEST_VERSION = "xsd1";

function digestOf(parts: (string | number)[]): string {
  let hash = 2166136261;
  const input = parts.join("\u0001");
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${SOURCE_DIGEST_VERSION}:${input.length}:${(hash >>> 0).toString(16)}`;
}

function digestParts(
  page: NotebookPage,
  notebook: Notebook | undefined,
  regions: readonly NotebookRegionRef[]
): (string | number)[] {
  return [
    SOURCE_DIGEST_VERSION,
    notebook?.title ?? "",
    page.title,
    page.capturedAt,
    ...page.blocks.flatMap((block) =>
      block.type === "text"
        ? ["t", block.id, block.text]
        : block.type === "photo"
          ? ["p", block.id, block.mediaId, block.caption]
          : ["u", block.id, block.markdown]
    ),
    ...regions.map((region) => region.regionId)
  ];
}

export function pageSourceDigest(
  page: NotebookPage,
  notebook?: Notebook,
  regions: readonly NotebookRegionRef[] = []
): string {
  return digestOf(digestParts(page, notebook, regions));
}

/**
 * 多页上下文里父本自身的摘要：标题 + 成员页身份（页 id 与顺序）。
 * 成员变化或本改名都会改变它，不需要另建 NotebookBaseline。
 * 参数只要求标题（P4 从 `listNotebooks` 的 DTO 计算本册摘要时无需构造整个 Notebook）。
 */
export function notebookSourceDigest(
  notebook: Pick<Notebook, "title">,
  memberPageIds: readonly string[]
): string {
  return digestOf([SOURCE_DIGEST_VERSION, "notebook", notebook.title, ...memberPageIds]);
}

// —— 内部只读辅助 ——

function findNotebook(archive: ArchiveCore, notebookId: string): Notebook | undefined {
  return archive.notebooks.find((notebook) => notebook.id === notebookId);
}

function regionsOf(archive: ArchiveCore, pageId: string): NotebookRegionRef[] {
  return findTripJournal(archive, pageId)?.regions ?? [];
}

function toMediaContext(media: (Omit<NotebookMedia, "blob"> & { blob?: Blob }) | undefined, mediaId: string): AiMediaContext {
  if (!media) {
    return {
      id: mediaId,
      name: "",
      type: "",
      size: 0,
      origin: { kind: "local-upload" },
      availability: "missing"
    };
  }
  return {
    id: media.id,
    name: media.name,
    type: media.type,
    size: media.size,
    origin: media.origin,
    availability: "available"
  };
}

function toBlockContext(block: NotebookPageBlock): AiBlockContext {
  if (block.type === "text") return { blockId: block.id, kind: "text", text: block.text };
  if (block.type === "photo") {
    return {
      blockId: block.id,
      kind: "photo",
      mediaId: block.mediaId,
      caption: block.caption,
      immutable: true
    };
  }
  return {
    blockId: block.id,
    kind: "unsupported-image",
    markdown: block.markdown,
    immutable: true
  };
}

/** 块投影：顺序、id、完整正文与图片引用原样保留（不存在截断路径）。 */
function toBlocks(page: NotebookPage): AiBlockContext[] {
  return page.blocks.map(toBlockContext);
}

// —— Provider ——

export type AiContextProviderOptions = {
  /** 现有领域快照；Provider 只读，不回写。 */
  archive: ArchiveCore;
  /**
   * 媒体元数据快照（ArchiveCore 不含 media）。缺省为空：
   * 不读取 Blob、不生成 Data URL，只描述引用是否存在。
   * F5：blob 可选（metadataOnly 视图）；本 Provider 从不读取 Blob。
   */
  media?: readonly (Omit<NotebookMedia, "blob"> & { blob?: Blob })[];
  /** 本次任务的默认范围；调用方可按方法覆盖。 */
  scope?: Partial<AiReadScope>;
};

export type AiPagesResult = {
  pages: AiPageContext[];
  /** 请求中不可用的 id（不存在/已删除/超范围/超预算），顺序与页顺序一致。 */
  missing: { id: string; reason: AiMissingReason }[];
  /** 因 maxPages 未读取的 id；明确报告，不静默丢弃。 */
  skipped: string[];
};

export type AiMediaResult = {
  media: AiMediaContext[];
  /** 未在本次允许列表中的 id；不会因调用方传入任意 id 而扩大读取。 */
  skipped: string[];
};

export interface AiContextProvider {
  getPage(
    pageId: string,
    options?: { scope?: Partial<AiReadScope> }
  ): Promise<AiPageContext | null>;
  getPages(pageIds: string[], options?: { scope?: Partial<AiReadScope> }): Promise<AiPagesResult>;
  listNotebooks(options?: { scope?: Partial<AiReadScope> }): Promise<AiNotebookContext[]>;
  listNotebookPages(
    notebookId: string,
    options?: { scope?: Partial<AiReadScope> }
  ): Promise<AiPageContext[]>;
  /** 只返回元数据引用；不读取 Blob、不下载图片。 */
  getMedia(mediaIds: string[], allowedMediaIds: readonly string[]): Promise<AiMediaResult>;
}

/**
 * 单页可见性唯一判定，搜索与上下文共用（避免两处各说一套）：
 * 本存在且未删除、未归档；页未删除；legacy 关联查看页按开关排除；在任务 Notebook 范围内。
 */
export function pageAvailability(
  archive: ArchiveCore,
  page: NotebookPage | undefined,
  scope: AiReadScope
): AiMissingReason | null {
  if (!page) return "not-found";
  const notebook = findNotebook(archive, page.notebookId);
  if (!notebook || notebook.deletedAt || notebook.archivedAt) return "deleted";
  if (typeof page.deletedAt === "string" && page.deletedAt.length > 0) return "deleted";
  if (page.source.kind === "legacy-journal" && !scope.allowLegacyLinkedPages) return "deleted";
  if (scope.notebookIds && !scope.notebookIds.includes(page.notebookId)) return "out-of-scope";
  return null;
}

export function createAiContextProvider(options: AiContextProviderOptions): AiContextProvider {
  const archive = options.archive;
  const mediaSnapshot = options.media ?? [];
  const defaultScope = createAiReadScope(options.scope);

  function availability(page: NotebookPage | undefined, scope: AiReadScope) {
    return pageAvailability(archive, page, scope);
  }

  function mediaFor(page: NotebookPage): AiMediaContext[] {
    const seen = new Set<string>();
    const result: AiMediaContext[] = [];
    for (const block of page.blocks) {
      if (block.type !== "photo" || seen.has(block.mediaId)) continue;
      seen.add(block.mediaId);
      result.push(
        toMediaContext(
          mediaSnapshot.find((item) => item.id === block.mediaId),
          block.mediaId
        )
      );
    }
    return result;
  }

  function buildPage(page: NotebookPage): AiPageContext {
    const notebook = findNotebook(archive, page.notebookId);
    const regions = regionsOf(archive, page.id);
    return {
      id: page.id,
      notebookId: page.notebookId,
      notebookTitle: notebook?.title ?? "",
      title: page.title,
      text: getPageText(page),
      blocks: toBlocks(page),
      capturedAt: page.capturedAt,
      createdAt: page.createdAt,
      updatedAt: page.updatedAt,
      regions: regions.map((region) => ({ ...region })),
      media: mediaFor(page),
      sourceDigest: pageSourceDigest(page, notebook, regions)
    };
  }

  async function getPage(pageId: string, methodOptions?: { scope?: Partial<AiReadScope> }) {
    // R1：方法级 scope 只能**收窄**默认范围（交集/取更小预算），不能覆盖或扩大。
    const scope = mergeAiReadScope(defaultScope, methodOptions?.scope);
    const page = archive.pages.find((item) => item.id === pageId);
    if (!page || availability(page, scope) !== null) return null;
    return buildPage(page);
  }

  /** 预算是读入门槛：超预算的页整页不读，报 over-budget，不返回部分正文。 */
  async function getPages(pageIds: string[], methodOptions?: { scope?: Partial<AiReadScope> }) {
    // R1：方法级 scope 只能**收窄**默认范围（交集/取更小预算），不能覆盖或扩大。
    const scope = mergeAiReadScope(defaultScope, methodOptions?.scope);
    const unique = [...new Set(pageIds)];
    const pages: AiPageContext[] = [];
    const missing: AiPagesResult["missing"] = [];
    const skipped: string[] = [];
    let used = 0;

    for (const [index, id] of unique.entries()) {
      const page = archive.pages.find((item) => item.id === id);
      const reason = availability(page, scope);
      if (!page || reason !== null) {
        missing.push({ id, reason: reason ?? "not-found" });
        continue;
      }
      if (pages.length >= scope.maxPages) {
        skipped.push(...unique.slice(index));
        break;
      }
      const textLength = getPageText(page).length;
      if (used + textLength > scope.maxTotalTextChars) {
        missing.push({ id, reason: "over-budget" });
        continue;
      }
      used += textLength;
      pages.push(buildPage(page));
    }

    return { pages, missing, skipped };
  }

  async function listNotebooks(methodOptions?: { scope?: Partial<AiReadScope> }) {
    // R1：方法级 scope 只能**收窄**默认范围（交集/取更小预算），不能覆盖或扩大。
    const scope = mergeAiReadScope(defaultScope, methodOptions?.scope);
    const visible = listActiveNotebooks(archive).filter(
      (notebook) => !scope.notebookIds || scope.notebookIds.includes(notebook.id)
    );
    return visible.map((notebook) => ({ id: notebook.id, title: notebook.title }));
  }

  /**
   * 本内全部可见篇。这里刻意不套用 getPages 的 maxPages/正文预算：列一次目录
   * 不应该因为预算悄悄少给几篇；需要限额的场景请用 getPages（它会报告 missing/skipped）。
   */
  async function listNotebookPages(
    notebookId: string,
    methodOptions?: { scope?: Partial<AiReadScope> }
  ) {
    // R1：方法级 scope 只能**收窄**默认范围（交集/取更小预算），不能覆盖或扩大。
    const scope = mergeAiReadScope(defaultScope, methodOptions?.scope);
    const notebook = findNotebook(archive, notebookId);
    if (!notebook || notebook.deletedAt || notebook.archivedAt) return [];
    if (scope.notebookIds && !scope.notebookIds.includes(notebookId)) return [];
    return sortPagesStable(
      listActiveNotebookPages(archive, notebookId).filter(
        (page) => availability(page, scope) === null
      )
    ).map(buildPage);
  }

  async function getMedia(mediaIds: string[], allowedMediaIds: readonly string[]) {
    const allowed = new Set(allowedMediaIds);
    const media: AiMediaContext[] = [];
    const skipped: string[] = [];
    for (const mediaId of [...new Set(mediaIds)]) {
      if (!allowed.has(mediaId)) {
        skipped.push(mediaId);
        continue;
      }
      media.push(
        toMediaContext(
          mediaSnapshot.find((item) => item.id === mediaId),
          mediaId
        )
      );
    }
    return { media, skipped };
  }

  return { getPage, getPages, listNotebooks, listNotebookPages, getMedia };
}

// —— 供 SearchProvider 复用的可见性规则 ——
/** 搜索的可见页集合 = 逐页共用 pageAvailability，再稳定排序。 */
export function aiVisiblePages(archive: ArchiveCore, scope: AiReadScope): NotebookPage[] {
  return sortPagesStable(
    archive.pages.filter((page) => pageAvailability(archive, page, scope) === null)
  );
}

/**
 * 稳定排序：capturedAt 降序；同一 capturedAt 用 pageId 降序破同序
 * （id 单调递增，降序与列表“新的在前”一致；方向固定，避免依赖输入顺序）。
 */
export function sortPagesStable(pages: NotebookPage[]): NotebookPage[] {
  return [...pages].sort((left, right) =>
    left.capturedAt === right.capturedAt
      ? right.id.localeCompare(left.id)
      : right.capturedAt.localeCompare(left.capturedAt)
  );
}
