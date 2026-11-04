/**
 * 本轮图片候选目录（纯函数，运行时派生，**不持久化**）。
 *
 * 存在理由：计划轮原先只拿到「本轮附件 + 上一轮文本」，于是「按照你说的先出图」这类
 * 不带数量的后续请求既找不到原图，也不知道有哪些图可改。这里把**当前会话**里真实存在的
 * 图片派生成带稳定身份、来源与顺序的候选，只在当前回合的请求上下文里使用：
 *
 * - 候选 ID 由既有消息/附件身份组合而成，不由模型生成，也不用数组下标作跨回合身份；
 * - 只读当前已加载会话；不读其他会话、未引用笔记或本机文件；
 * - 图片字节**不进**计划轮载荷，只有元数据；选定后才走既有看图/修图通道；
 * - 同一原图在消息附件与请求快照里重复出现时按内容去重；生成结果与原图分别标注来源。
 */
import { CREATION_VISION_LIMITS } from "@/features/creation/creation-media";
import { decodedBase64Bytes, IMAGE_LIMITS } from "@/features/creation/creation-image-limits";
import { isNativeMediaFileRef, type MessageAttachment, type NativeMediaFileRef, type WorkbenchMessage } from "./workbench-types";

/** 候选数量上限：只影响元数据体积，可执行的张数上限仍是 `CREATION_VISION_LIMITS.images`。 */
export const MAX_IMAGE_CANDIDATES = 24;

/** 来源类别：用户附件 / 助手生成结果 / 回答侧请求快照（复用图）。 */
export type ImageSourceOrigin = "user-attachment" | "generated" | "request-snapshot" | "current-turn";

export type WorkbenchImageSource = {
  /** 仅本会话有效的稳定身份：`<消息 id>#<附件 id>`；无消息上下文的直接调用才用 current 前缀。 */
  sourceId: string;
  /** 所属消息（本轮新附图为 `current`），用于把候选挂回对话关系。 */
  messageId: string;
  /** 候选顺序（目录内 0 基）。 */
  index: number;
  name: string;
  origin: ImageSourceOrigin;
  /** 当前是否可读（格式受支持且未超单图上限）。 */
  readable: boolean;
  /** 只有可读候选带字节。 */
  dataUrl?: string;
  /** Durable native original; resolved on demand after selection, never sent in candidate metadata. */
  fileRef?: NativeMediaFileRef;
  /** 回复内编号与版本组，区别于目录 order；后续修改继承生成来源的编号。 */
  imageNumber?: number;
  imageGroupId?: string;
};

/** 显式复用会把完整 sourceId 用作附件 ID；两种入口沿用同一生成来源身份。 */
export function generatedImageSource(sourceId: string | undefined, attachmentId: string | undefined,
  sources: readonly WorkbenchImageSource[]) {
  return sources.find(source => source.origin === "generated" && (source.sourceId === sourceId
    || source.sourceId === attachmentId || !!attachmentId && source.sourceId.endsWith(`#${attachmentId}`)));
}

/**
 * 附件按计划项展示，补修的迟到产物不能改变既有编号。
 * 每项带 `sourceLabel`（媒体版本来源链的最小展示，S3）：只从**已持久化**的
 * imagePlan/imageAttempts/attachments 派生——edit 取计划来源名（缺失标"未知"），
 * generate 标"新生成"，无计划的兜底附件标"未知"。刷新/回读后同一消息派生同一标签。
 */
export function imageDisplayEntries(message: WorkbenchMessage, sources: readonly WorkbenchImageSource[] = []) {
  const progress = message.imagePlan
    ? message.imagePlan.items.map((item, index) => {
        const latest = (message.imageAttempts ?? []).filter(attempt => attempt.itemId === item.itemId)
          .sort((a, b) => a.attemptNo - b.attemptNo).at(-1);
        const attachment = message.attachments?.find(image => image.id === latest?.artifactId);
        const source = sources.find(source => source.sourceId === item.sourceIds[0] && source.origin === "generated");
        const sourceLabel = message.imagePlan!.mode === "generate"
          ? "新生成"
          : message.imagePlan!.sources.find(entry => entry.sourceId === item.sourceIds[0])?.name ?? "未知";
        return { attachment, number: sources.find(source => source.sourceId === `${message.id}#${attachment?.id}`)?.imageNumber ?? source?.imageNumber ?? index + 1, sourceLabel };
      }).filter((item): item is { attachment: MessageAttachment; number: number; sourceLabel: string } => !!item.attachment)
    : [];
  const seen = new Set(progress.map(item => item.attachment.id));
  return [...progress, ...(message.attachments ?? []).filter(image => !seen.has(image.id))
    .map((attachment, index) => ({ attachment, number: (message.imagePlan?.items.length ?? 0) + index + 1, sourceLabel: "未知" }))];
}

export type ImageSourceCatalog = {
  /** 可读候选（按会话顺序）。 */
  sources: WorkbenchImageSource[];
  /** 会话里存在但当前不可读的图片数量（不计入候选）。 */
  unreadable: number;
  /** 候选总数（含因上限未纳入的）。 */
  total: number;
  /** 有候选因数量上限没有纳入本轮目录。 */
  truncated: boolean;
  /** 用户本轮明确说出的张数（如「这两张」）：交给计划轮遵守、由代码核对，不用来猜组。 */
  expectedCount?: number;
};

/** 单图可读性：与 `attachmentBlob` 同一套格式与大小上限，不另造第二份判定。 */
export function isReadableImageDataUrl(dataUrl: unknown): dataUrl is string {
  if (typeof dataUrl !== "string") return false;
  const prefix = /^data:image\/(?:png|jpeg|webp);base64,/.exec(dataUrl);
  if (!prefix) return false;
  const base64 = dataUrl.slice(prefix[0].length);
  if (base64.length % 4 !== 0 || decodedBase64Bytes(base64) > IMAGE_LIMITS.sourceBytes) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(base64);
}

// 流式正文每次变化仍需更新目录，但不重新扫描未变的历史原图。
const readableAttachments = new WeakMap<MessageAttachment, { dataUrl?: string; fileIdentity: string; readable: boolean }>();
function isReadableAttachment(attachment: MessageAttachment): boolean {
  const cached = readableAttachments.get(attachment);
  const ref = attachment.fileRef;
  const fileIdentity = ref ? JSON.stringify([ref.serverId, ref.userId, ref.datasetId, ref.mediaId, ref.sha256, ref.size, ref.type]) : "";
  if (cached && cached.dataUrl === attachment.dataUrl && cached.fileIdentity === fileIdentity) return cached.readable;
  const readable = isReadableImageDataUrl(attachment.dataUrl) || isNativeMediaFileRef(ref) && ["image/png", "image/jpeg", "image/webp"].includes(ref.type) && ref.size <= IMAGE_LIMITS.sourceBytes;
  readableAttachments.set(attachment, { dataUrl: attachment.dataUrl, fileIdentity, readable });
  return readable;
}

function sourceIdFor(messageId: string, attachmentId: string, snapshot: boolean): string {
  return snapshot ? `${messageId}#req#${attachmentId}` : `${messageId}#${attachmentId}`;
}

type Group = { messageId: string; origin: ImageSourceOrigin; snapshot: boolean; attachments: MessageAttachment[] };

/** 一条消息贡献的图片组：自身附件优先，请求快照作为补充（同一原图随后按内容去重）。 */
function groupsOf(message: WorkbenchMessage): Group[] {
  // 运行中的输出尚未交付；失败回复可能保留已完成项，真实附件仍可选。
  if (message.status === "pending") return [];
  const groups: Group[] = [];
  if (message.attachments?.length) {
    groups.push({
      messageId: message.id,
      origin: message.role === "assistant" ? "generated" : "user-attachment",
      snapshot: false,
      attachments: message.role === "assistant" ? imageDisplayEntries(message).map(item => item.attachment) : message.attachments
    });
  }
  if (message.request?.attachments?.length) {
    groups.push({ messageId: message.id, origin: "request-snapshot", snapshot: true, attachments: message.request.attachments });
  }
  return groups;
}

/**
 * 从当前会话派生候选目录。
 *
 * 去重按**附件身份**（`attachment.id`）而不是按字节：回答侧请求快照复用的就是同一批附件身份，
 * 所以「同一原图出现在消息与快照里」只登记一次；而字节相同但身份不同的图（例如生成结果与原图）
 * 各自保留，来源类别不会互相顶掉。
 * 超上限时保留**最近的**候选并标记 `truncated`。
 */
export function deriveImageSources(
  messages: readonly WorkbenchMessage[],
  options: { max?: number } = {}
): ImageSourceCatalog {
  const max = options.max ?? MAX_IMAGE_CANDIDATES;
  const all: WorkbenchImageSource[] = [];
  const seenIds = new Set<string>();
  let unreadable = 0;

  for (const message of messages) {
    for (const group of groupsOf(message)) {
      for (const attachment of group.attachments) {
        // 同一份附件身份只登记一次（快照/复用副本不重复登记）。
        if (seenIds.has(attachment.id)) continue;
        seenIds.add(attachment.id);
        if (!isReadableAttachment(attachment)) {
          unreadable += 1;
          continue;
        }
        const itemIndex = message.imagePlan?.items.findIndex(item => message.imageAttempts?.some(attempt =>
          attempt.itemId === item.itemId && attempt.artifactId === attachment.id)) ?? -1;
        const parentId = itemIndex >= 0 ? message.imagePlan!.items[itemIndex]!.sourceIds[0] : undefined;
        const parentAttachment = message.imagePlan?.sources.find(source => source.sourceId === parentId)?.attachmentId;
        const parent = message.imagePlan?.mode === "edit" ? generatedImageSource(parentId, parentAttachment, all) : undefined;
        const number = group.attachments.indexOf(attachment) + 1;
        all.push({
          sourceId: sourceIdFor(group.messageId, attachment.id, group.snapshot),
          messageId: group.messageId,
          index: 0,
          name: attachment.name,
          origin: group.origin,
          readable: true,
          ...(attachment.dataUrl ? { dataUrl: attachment.dataUrl } : {}),
          ...(attachment.fileRef ? { fileRef: attachment.fileRef } : {}),
          imageNumber: parent?.imageNumber ?? (itemIndex >= 0 ? itemIndex + 1 : number),
          imageGroupId: parent?.imageGroupId ?? group.messageId
        });
      }
    }
  }

  const truncated = all.length > max;
  const kept = truncated ? all.slice(all.length - max) : all;
  return {
    sources: kept.map((source, index) => ({ ...source, index })),
    unreadable,
    total: all.length,
    truncated
  };
}

/**
 * 本轮新附图（或本轮明确选中的目标）优先：放在候选最前，并**保留自己的身份**。
 * 即使字节与旧图相同也不合并——用户这次明确选的是这一份，模型必须能按本轮身份选它。
 */
export function withCurrentTurnSources(
  sources: readonly WorkbenchImageSource[],
  attachments: readonly MessageAttachment[],
  options: { messageId?: string } = {}
): WorkbenchImageSource[] {
  const added: WorkbenchImageSource[] = [];
  const usedIds = new Set<string>();
  for (const attachment of attachments) {
    if (usedIds.has(attachment.id) || !isReadableAttachment(attachment)) continue;
    usedIds.add(attachment.id);
    const existing = sources.find(source => (source.sourceId === attachment.id || source.sourceId.endsWith(`#${attachment.id}`))
      && (attachment.fileRef ? source.fileRef?.mediaId === attachment.fileRef.mediaId && source.fileRef.sha256 === attachment.fileRef.sha256 && source.fileRef.datasetId === attachment.fileRef.datasetId && source.fileRef.userId === attachment.fileRef.userId && source.fileRef.serverId === attachment.fileRef.serverId : source.dataUrl === attachment.dataUrl));
    const messageId = options.messageId ?? existing?.messageId ?? "current";
    added.push({
      sourceId: options.messageId ? sourceIdFor(messageId, attachment.id, false) : existing?.sourceId ?? `current#${attachment.id}`,
      messageId,
      index: 0,
      name: attachment.name,
      origin: "current-turn",
      readable: true,
      ...(attachment.dataUrl ? { dataUrl: attachment.dataUrl } : {}),
      ...(attachment.fileRef ? { fileRef: attachment.fileRef } : {}),
      imageNumber: existing?.imageNumber ?? added.length + 1,
      imageGroupId: existing?.imageGroupId ?? messageId
    });
  }
  const addedIds = new Set(added.map(source => source.sourceId));
  return [...added, ...sources.filter(source => !addedIds.has(source.sourceId))].map((source, index) => ({ ...source, index }));
}

/** 送给模型的候选元数据：只有身份/来源/顺序，**没有**图片字节。 */
export function imageSourceRef(source: WorkbenchImageSource): {
  sourceId: string;
  name: string;
  from: ImageSourceOrigin;
  order: number;
  messageId: string;
  imageNumber?: number;
  imageGroupId?: string;
} {
  return { sourceId: source.sourceId, name: source.name, from: source.origin, order: source.index + 1,
    messageId: source.messageId, imageNumber: source.imageNumber, imageGroupId: source.imageGroupId };
}

/** 明确数字指代绑定最近有图/建议的回复组；绝不把“图一”解释成目录第一个。 */
export function resolveImageNumbers(text: string, sources: readonly WorkbenchImageSource[],
  history: NonNullable<import("./workbench-types").WorkbenchRequest["history"]>) {
  const digits = "一二三四五六七八九";
  const numbers = [...text.matchAll(/(?:图(?:片)?\s*([1-9一二三四五六七八九])(?!\d)|第\s*([1-9一二三四五六七八九])\s*张)/g)]
    .map(match => match[1] ?? match[2]!).map(value => /^[1-9]$/.test(value) ? Number(value) : digits.indexOf(value) + 1);
  if (!numbers.length) return undefined;
  if (/(?:之前|上次|上一批|最初)(?:的|那|中)?(?:结果|图片|图)|原图/.test(text))
    return { ok: false as const, detail: "这次提到了较早图片的编号，请点击对应图片的修改按钮选定版本，避免改错图。" };
  const reply = [...history].reverse().find(turn => turn.role === "assistant" &&
    (turn.imageAdvice?.items.length || turn.imageSourceIds?.length));
  const ids = reply?.imageAdvice?.items.map(item => item.sourceId) ?? reply?.imageSourceIds;
  const anchors = ids?.flatMap(id => sources.filter(source => source.sourceId === id)) ?? [];
  const anchor = anchors[0];
  const current = sources.filter(source => source.origin === "current-turn");
  const referenced = current.length ? current : anchors;
  if (new Set(referenced.map(source => `${source.imageGroupId}:${source.origin}`)).size > 1)
    return { ok: false as const, detail: "当前回复包含不同图片组，编号不能唯一确定来源，请点击要修改的图片选定版本。" };
  const group = current.length ? current : anchor
    ? sources.filter(source => source.imageGroupId === anchor.imageGroupId && source.origin === anchor.origin) : [];
  const picked = [...new Set(numbers)].map(number => [...group].reverse().find(source => source.imageNumber === number));
  if (picked.some(source => !source)) return { ok: false as const, detail: "无法在当前图片组找到所说的编号，请点击要修改的图片选定来源。" };
  return { ok: true as const, sourceIds: picked.map(source => source!.sourceId) };
}

export type ImageSourceResolution =
  | { ok: true; sources: WorkbenchImageSource[] }
  | { ok: false; detail: string };

/**
 * 解析模型给出的 sourceIds：必须非空、唯一、数量在可执行上限内，且**全部**存在于本轮冻结候选。
 * 任何一条不成立都整体失败——不静默丢来源、不退回纯生成、不猜测。
 */
export function resolveImageSources(
  catalog: readonly WorkbenchImageSource[],
  sourceIds: readonly string[],
  maxImages: number = CREATION_VISION_LIMITS.images
): ImageSourceResolution {
  if (sourceIds.length === 0) return { ok: false, detail: "没有给出图片来源。" };
  if (sourceIds.length > maxImages) return { ok: false, detail: `一次最多处理 ${maxImages} 张图片。` };
  if (new Set(sourceIds).size !== sourceIds.length) return { ok: false, detail: "sourceIds 不能重复。" };
  const byId = new Map(catalog.map(source => [source.sourceId, source]));
  const picked: WorkbenchImageSource[] = [];
  for (const sourceId of sourceIds) {
    const source = byId.get(sourceId);
    if (!source) return { ok: false, detail: `来源 ${sourceId} 不在本会话候选里，请改用候选中的 sourceId。` };
    if (!source.readable || !(source.dataUrl || source.fileRef)) return { ok: false, detail: `来源 ${sourceId} 当前不可读，请换一张。` };
    picked.push(source);
  }
  return { ok: true, sources: picked };
}

/**
 * 把候选挂回对话关系：每条历史带它自己携带的候选 ID，供计划轮把建议与原图对上。
 * 助手的建议本身不带图，只继承**紧邻的前一条带图用户消息**的候选 ID——
 * 那正是「上一轮针对这两张图给的建议」。跨过无图话题（例如中间插了一段无关对话）后
 * 不再延续，避免把无关建议标成这些图片的方案。
 */
export function historyWithImageSources(
  messages: readonly WorkbenchMessage[],
  sources: readonly WorkbenchImageSource[],
  limit = 20
): NonNullable<import("./workbench-types").WorkbenchRequest["history"]> {
  const byMessage = new Map<string, string[]>();
  for (const source of sources) {
    const list = byMessage.get(source.messageId);
    if (list) list.push(source.sourceId);
    else byMessage.set(source.messageId, [source.sourceId]);
  }
  let previous: { role: "user" | "assistant"; ids?: string[] } | undefined;
  return messages
    .filter(message => message.status !== "pending" && (message.status !== "failed" || message.attachments?.length))
    .slice(-limit)
    .map((message) => {
      const own = byMessage.get(message.id);
      const adjacentUserImages = previous?.role === "user" && previous.ids?.length ? previous.ids : undefined;
      const ids = own?.length ? own : message.role === "assistant" ? adjacentUserImages : undefined;
      const entry = {
        role: message.role,
        id: message.id,
        text: message.text,
        ...(message.imageAdvice ? { imageAdvice: message.imageAdvice } : {}),
        ...(ids?.length ? { imageSourceIds: [...ids] } : {})
      };
      previous = { role: message.role, ...(entry.imageSourceIds ? { ids: entry.imageSourceIds } : {}) };
      return entry;
    });
}
