/** 工作台契约：生产使用真实 adapter；demo adapter 仅保留给原型与隔离测试。 */
import type { WorkbenchStreamEvent } from "@/features/ai/stream-events";
import type { ImageOutputFormat, ImageStyle } from "@/features/creation/creation-image-rules";
import { decodedBase64Bytes, IMAGE_LIMITS } from "@/features/creation/creation-image-limits";
import type {
  ImageAttemptProjection,
  ImageAttemptStatus,
  ImagePromptSnapshot,
  ImageTaskPlan
} from "@/features/ai/image-execution-contract";

export type { ImageAttemptProjection, ImageAttemptStatus, ImagePromptSnapshot, ImageTaskPlan };

/** 工作范围：像工作目录，只表示“这次对话在哪个范围里工作”，不代表已发送全部内容。 */
export type WorkbenchScope =
  | { kind: "free" }
  | { kind: "notebook"; notebookId: string; notebookTitle: string }
  | {
      kind: "note";
      notebookId: string;
      notebookTitle: string;
      noteId: string;
      noteTitle: string;
    };

export function describeScope(scope: WorkbenchScope): string {
  if (scope.kind === "free") return "自由对话";
  if (scope.kind === "notebook") return scope.notebookTitle;
  return `${scope.notebookTitle} / ${scope.noteTitle}`;
}

export function sameScope(a: WorkbenchScope, b: WorkbenchScope): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "free") return true;
  if (b.kind === "free") return false;
  return a.notebookId === b.notebookId && (a.kind === "notebook" || (b.kind === "note" && a.noteId === b.noteId));
}

/** 输入区快捷操作：一个功能一个入口，不做第二层折叠。 */
export type WorkbenchIntent =
  | "chat"
  | "summarize"
  | "copywriting"
  | "image-generate"
  | "image-edit"
  | "handbook-page";

/** 素材引用：来自随记，进入输入区后仍可在发送前移除。 */
export type MaterialReference = { id: string; text: string; createdAt: string };
/** 用户显式引用的方法；名称只用于展示，读取始终按目录 ID 核对。 */
export type SkillReference = { id: string; name: string };
/** 可继续执行的图片建议；消息 ID 是建议引用身份，来源摘要由代码绑定。 */
export type ImageAdvice = { items: { sourceId: string; sourceDigest: string; instruction: string }[] };

/** A durable original in the captured native actor's Data directory. Never contains a token or absolute path. */
export type NativeMediaFileRef = {
  serverId: string; userId: string; datasetId: string; mediaId: string;
  sha256: string; size: number; type: string;
};
export function isNativeMediaFileRef(value: unknown): value is NativeMediaFileRef {
  if (!value || typeof value !== "object") return false;
  const ref = value as NativeMediaFileRef;
  return [ref.serverId, ref.userId, ref.datasetId, ref.mediaId].every((item) => typeof item === "string" && !!item && item.length <= 200)
    && /^[a-f0-9]{64}$/.test(ref.sha256) && Number.isInteger(ref.size) && ref.size > 0 && ref.size <= 50_000_000 && typeof ref.type === "string";
}
export type MessageAttachment = { id: string; name: string; dataUrl?: string; fileRef?: NativeMediaFileRef; edit?: import("./workbench-image-edit-contract").ImageEditMetadata };

/**
 * T5/T6a fileRef 迁移的类型谓词：内联 dataUrl 或内存 objectURL（blob:）附件可进入
 * 查看器管线。blob: 仅存在于当前页面的按需读取注册表，不进会话持久化。
 */
export function hasInlineData(image: MessageAttachment): image is MessageAttachment & { dataUrl: string } {
  return !!image.dataUrl || /^blob:/i.test(String(image.dataUrl ?? ""));
}

/** 每轮图片选项快照；缺省 size 表示自动（基础修图贴近原图比例，其他任务在配置内设计尺寸）。 */
export type WorkbenchImageOptions = {
  modelId: string;
  size?: string;
  style?: ImageStyle;
  outputFormat?: ImageOutputFormat;
  /** 图像入口的显式授权；生成/编辑仍由现有 Agent 根据需求判断。 */
  requested?: true;
};

/**
 * 一次工具调用与它的结果（同一个 `id` 配对）。
 * 按**内容块**展示：调用、进行中、结果各是一行状态，而不是散成多条轨迹行。
 */
export type WorkbenchToolBlock = {
  id: string;
  name: string;
  title: string;
  argsDigest: string;
  /** 缺省 = 还在进行中。 */
  ok?: boolean;
  /** 用户取消的是本轮等待；不代表供应商已撤回已出站的请求。 */
  cancelled?: true;
  summary?: string;
  /** web_search 的实际公开查询、摘要与来源；沿原工具 JSON 保存。 */
  search?: import("@/features/ai/native-search-contract").NativeSearchResult;
  truncated?: true;
  /** 当前页本次调用的起点；不落库，结束后只保存实测ms。 */
  startedAt?: number;
  /** 这次调用花了多久（毫秒，调用与结果都到达后才有的实测值）。 */
  ms?: number;
};

/** 终止本轮所有未配对的调用；已交付的结果保持原状。 */
export function settleWorkbenchTools(tools: readonly WorkbenchToolBlock[] = [], cancelled = false): WorkbenchToolBlock[] {
  return tools.map(tool => tool.ok === undefined
    ? { ...tool, ok: false, summary: cancelled ? "已取消" : "已中断", ...(cancelled ? { cancelled: true as const } : {}),
        ...(tool.startedAt === undefined ? {} : { startedAt: undefined, ms: Math.max(0, Date.now() - tool.startedAt) }) }
    : tool);
}

/** 图片任务只有一套完成口径：来源集合里的成功项。产物数量不代表完成了多少来源。 */
export function imageEditProgress(sources: readonly MessageAttachment[], tools: readonly WorkbenchToolBlock[] = []) {
  const uniqueSources = [...new Map(sources.map(source => [source.id, source])).values()];
  const succeeded = new Set(tools.filter(tool => tool.name === "image-edit" && tool.ok === true)
    .map(tool => tool.id.replace(/^image-edit-/, "")));
  const completedSourceIds = new Set(uniqueSources.filter(source => succeeded.has(source.id)).map(source => source.id));
  return {
    total: uniqueSources.length,
    completed: completedSourceIds.size,
    completedSourceIds,
    unfinished: uniqueSources.filter(source => !completedSourceIds.has(source.id))
  };
}

/**
 * R1（C2）：有计划的任务从**任务项/尝试记录**派生完成数与补修集合；
 * 工具块只是展示投影，不再是执行事实的唯一权威。
 * 完成口径：该项最新尝试已成功**且**产物已作为附件写入本条消息（artifactSaved 是独立事实）。
 */
export type ImagePlanItemState = {
  itemId: string;
  sourceIds: string[];
  instruction: string;
  /** 完成时对应回复里的附件（按 artifactId = attachment id 对上）。 */
  attachment?: MessageAttachment;
  /** 未完成项的当前状态：失败 / 结果未知 / 处理中（已出站）/ 待执行。 */
  pendingState?: "failed" | "outcome_unknown" | "in_flight" | "not_started";
  detail?: string;
};

export function imagePlanProgress(
  plan: ImageTaskPlan,
  attempts: readonly ImageAttemptProjection[],
  attachments: readonly MessageAttachment[] = []
): {
  total: number;
  completed: number;
  completedItemIds: Set<string>;
  items: ImagePlanItemState[];
} {
  const byItem = new Map<string, ImageAttemptProjection[]>();
  for (const attempt of attempts) {
    const list = byItem.get(attempt.itemId);
    if (list) list.push(attempt);
    else byItem.set(attempt.itemId, [attempt]);
  }
  const attachmentById = new Map(attachments.map(item => [item.id, item]));
  const items: ImagePlanItemState[] = plan.items.map((item) => {
    const itemAttempts = (byItem.get(item.itemId) ?? []).slice().sort((a, b) => a.attemptNo - b.attemptNo);
    const latest = itemAttempts[itemAttempts.length - 1];
    /*
     * 完成判定以**附件已在回复里**为准（artifactSaved 是独立事实）：
     * `delivered` 标记可能与附件一同写入，但保存屏障失败时附件已在而标记未落——
     * 附件存在本身说明产物已进入会话；恢复路径会对未落库的投影自行核对。
     */
    const attachment = latest?.artifactId ? attachmentById.get(latest.artifactId) : undefined;
    if (attachment) return { ...item, attachment };
    const pendingState: ImagePlanItemState["pendingState"] =
      latest === undefined ? "not_started"
        : latest.status === "failed" ? "failed"
        : latest.status === "outcome_unknown" ? "outcome_unknown"
        : latest.status === "dispatched" ? "in_flight"
        : "not_started";
    return {
      ...item,
      pendingState,
      ...(latest?.errorCode ? { detail: latest.errorCode } : {})
    };
  });
  const completedItemIds = new Set(items.filter(item => item.attachment).map(item => item.itemId));
  return { total: plan.items.length, completed: completedItemIds.size, completedItemIds, items };
}

export type WorkbenchResult =
  | { id: string; kind: "text"; title: string; body: string; demo: boolean }
  | { id: string; kind: "image"; title: string; caption: string; from: string; to: string; dataUrl?: string; fileRef?: NativeMediaFileRef; demo: boolean;
      /** 本轮结果说明用；保存与显示的编号仍由计划/来源派生。 */
      imageNumber?: number;
      /** 来源版本展示（媒体版本来源链）：本次编辑实际使用的来源名；生成无来源时缺省。 */
      sourceName?: string }
  | {
      id: string;
      kind: "handbook-page";
      title: string;
      subtitle: string;
      blocks: { heading: string; body: string }[];
      demo: boolean;
    };

/**
 * 会话保存失败（保存屏障）：图片结果已经拿到，但这一次写库没成功。
 * 它和「工具参数错、模型可以再试」是两回事——本轮必须停止继续调用图片工具，
 * 因此单独一个错误类型，让适配层能识别而不必匹配文案。
 */
export class SessionSaveFailureError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "SessionSaveFailureError";
  }
}

/** 只在本轮执行期间使用；落库时拆成同一条助手消息的正文、工具块和附件。 */
export type WorkbenchBatchImageResult = {
  kind: "image-batch";
  total: number;
  images: { sourceId: string; sourceName: string; image: Extract<WorkbenchResult, { kind: "image" }> & { dataUrl: string }; attachment: MessageAttachment }[];
  failures: { sourceId: string; sourceName: string; detail: string }[];
  /** R1：出站后结果未知的项（不冒充失败，也不冒充完成；只有显式「重新生成」才新建尝试）。 */
  unknowns?: { itemId: string; sourceId?: string; sourceName: string; detail: string; attemptId?: string }[];
  /** R1：原尝试仍在处理中的项（期限内不重复出站）。 */
  pendings?: { itemId: string; sourceId?: string; sourceName: string; detail: string }[];
  /** R1：整批停止原因（save/budget/conflict/capacity/config/identity）。 */
  stopped?: "save" | "budget" | "conflict" | "capacity" | "config" | "identity";
  stopDetail?: string;
};

export type WorkbenchTurnResult = WorkbenchResult | WorkbenchBatchImageResult;

/** 一次请求的完整输入：重试必须重放它，不能用「会话最后一条输入」代替。 */
export type WorkbenchRequest = {
  text: string;
  intent: WorkbenchIntent;
  references: MaterialReference[];
  attachments: MessageAttachment[];
  scope: WorkbenchScope;
  /**
   * 当轮上下文；`imageSourceIds` 把这一轮的发言与本轮图片候选对上（只在本轮派生）。
   * `id` 是消息 ID：较早轮次的约束可按 ID 用 `search_materials(kind=session)` 回读。
   */
  history?: { role: "user" | "assistant"; id?: string; text: string; imageSourceIds?: string[]; imageAdvice?: ImageAdvice }[];
  targetResult?: WorkbenchResult;
  context?: string;
  imageOptions?: WorkbenchImageOptions;
  skillReferences?: SkillReference[];
};

/**
 * 无请求快照的当前交付消息（例如 App 恢复领取）按同轮用户输入组装重试。
 * 原始请求存在时直接使用原快照；此函数不重建执行事件或媒体产物。
 */
export function requestFromHistory(
  messages: WorkbenchMessage[],
  assistantId: string,
  scope: WorkbenchScope
): WorkbenchRequest {
  const index = messages.findIndex((item) => item.id === assistantId);
  for (let cursor = (index < 0 ? messages.length : index) - 1; cursor >= 0; cursor -= 1) {
    const item = messages[cursor];
    if (item.role === "user") {
      return {
        text: item.text,
        intent: item.intent ?? "chat",
        references: item.references ?? [],
        ...(item.skillReferences?.length ? { skillReferences: item.skillReferences } : {}),
        attachments: item.attachments ?? [],
        scope
      };
    }
  }
  return { text: "", intent: "chat", references: [], attachments: [], scope };
}

/** 展示顺序事实；工具、调用与图片引用已有数据，不复制其结果或媒体字节。 */
export type WorkbenchMessageBlock = { id: string; sequence: number } & (
  | { type: "trace"; text: string }
  | { type: "text"; text: string; endSequence: number; phase?: "work" | "answer" }
  | { type: "reasoning"; text: string; endSequence: number }
  | { type: "tool"; toolId: string }
  | { type: "call"; callId: string }
  | { type: "images"; attachmentIds: string[] }
  | { type: "result"; resultId: string }
);

/** 单条助手消息的展示事实；activeSince 仅在当前页运行，保存时折入 elapsedMs。 */
export type WorkbenchProcess = {
  startedAt: number;
  phase: "working" | "answering" | "waiting";
  elapsedMs: number;
  activeSince?: number;
  /** 仅当前页等待后恢复阶段；历史读取不会自动续跑。 */
  resumePhase?: "working" | "answering";
  endedAt?: number;
  outcome?: "stop" | "limit" | "cancelled" | "timeout" | "error" | "interrupted";
  waitingLabel?: string;
};

export type WorkbenchMessage = {
  localEdit?: import("./workbench-image-edit-contract").LocalEditOrigin;
  id: string;
  role: "user" | "assistant";
  text: string;
  /** 助手当前事件序列用于实时展示和回放；用户消息可不含时间线。 */
  blocks?: WorkbenchMessageBlock[];
  /** 已消费事件的高水位，重放不重复追加；重试在此前序号之后继续。 */
  eventSequence?: number;
  process?: WorkbenchProcess;
  /** 回答侧的原始请求：重试与后续「继续修改」都以它为准。 */
  request?: WorkbenchRequest;
  intent?: WorkbenchIntent;
  references?: MaterialReference[];
  skillReferences?: SkillReference[];
  imageAdvice?: ImageAdvice;
  attachments?: MessageAttachment[];
  result?: WorkbenchResult;
  status?: "pending" | "failed" | "done";
  /**
   * 供应商公开思考的聚合值；展示按 blocks 中的片段，不拼进正文。
   */
  reasoning?: string;
  /** 工具调用块：与结果按 id 配对。 */
  tools?: WorkbenchToolBlock[];
  /**
   * R1：有计划图片任务（自然入口与显式入口统一）。计划在首个外部执行前固定，
   * 之后不可变——重试只选择未完成项，保持原计划。
   */
  imagePlan?: ImageTaskPlan;
  /** R1：尝试投影（权威在服务端尝试表；这里供派生进度、补修与恢复查询）。 */
  imageAttempts?: ImageAttemptProjection[];
  /** R4（§7.1）：每次模型/图片调用的记录（耗时/结果/usage；usage 缺失保持未知）。 */
  calls?: import("@/features/ai/stream-events").ModelCallRecord[];
  /** 状态行轨迹（阶段/步数/用量/预算说明）；只展示真实发生的事件。 */
  traces?: string[];
  error?: string;
  /** 这条回答是「保存失败」而不是生成失败：界面提供只重试保存的入口。 */
  saveFailed?: boolean;
  createdAt: string;
};

/** 只识别用户明确指出的、当前对话中图片组数量。 */
export function referencedImageCount(text: string): number | undefined {
  const match = /(?:这|那|上面|前面|刚才|之前)\s*(\d+|[一二两俩三四五六七八九十])\s*张\s*(?:图片|图像|照片|图)/u.exec(text);
  if (!match) return undefined;
  const count = /^\d+$/.test(match[1]!) ? Number(match[1]) : ({ 一: 1, 二: 2, 两: 2, 俩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 } as const)[match[1] as "一" | "二" | "两" | "俩" | "三" | "四" | "五" | "六" | "七" | "八" | "九" | "十"];
  return typeof count === "number" && Number.isSafeInteger(count) && count > 0 ? count : undefined;
}

export type ReusableImageGroup =
  | { kind: "match"; attachments: MessageAttachment[] }
  | { kind: "missing" | "ambiguous" | "unreadable" | "too-many" };

/** 只从当前会话复用一个确切图片组；不跨消息拼组。匹配组不可读或有多个匹配组时拒绝猜测。 */
export function resolveReusableImageGroup(
  messages: WorkbenchMessage[],
  count: number,
  maxImages: number
): ReusableImageGroup {
  if (count > maxImages) return { kind: "too-many" };
  const candidates = messages
    .filter(message => message.status !== "pending")
    .map(message => {
      if (message.attachments?.length) return message.attachments;
      if (message.role === "assistant" && message.result?.kind === "image" && message.result.dataUrl) {
        return [{ id: message.result.id, name: imageAttachmentName(message.result), dataUrl: message.result.dataUrl }];
      }
      return [];
    })
    .filter(group => group.length === count);
  if (!candidates.length) return { kind: "missing" };
  if (candidates.length > 1) return { kind: "ambiguous" };

  const [group] = candidates;
  const readable = group!.every(attachment => {
    if (isNativeMediaFileRef(attachment.fileRef)) return ["image/png", "image/jpeg", "image/webp"].includes(attachment.fileRef.type) && attachment.fileRef.size <= IMAGE_LIMITS.sourceBytes;
    const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(attachment.dataUrl ?? "");
    return !!match && match[1]!.length % 4 === 0 && decodedBase64Bytes(match[1]!) <= IMAGE_LIMITS.sourceBytes;
  });
  return readable ? { kind: "match", attachments: group!.map(attachment => ({ ...attachment })) } : { kind: "unreadable" };
}

export type WorkbenchSession = {
  id: string;
  title: string;
  scope: WorkbenchScope;
  messages: WorkbenchMessage[];
  updatedAt: string;
  /** 会话选择的模型（仅用于显示；授权永不持久化）。 */
  textModelId?: string;
  imageModelId?: string;
  /** 用户手动命名过：之后不再被第一条消息标题覆盖。 */
  renamed?: boolean;
  /** 是否已加载完整详情；false 表示只是列表摘要（不能写回）。 */
  loaded?: boolean;
};

/** 写入目标：要么插进已有笔记，要么在某个笔记本里新建笔记。 */
export type WriteTarget =
  | { kind: "insert-into-note"; notebookId: string; notebookTitle: string; noteId: string; noteTitle: string }
  | { kind: "new-note"; notebookId: string; notebookTitle: string; title: string };

export type WriteReceipt = {
  target: WriteTarget;
  /** 已有正文时的合并预览：先看再确认，不做“悄悄覆盖”。 */
  preview: string;
  /** 演示回执与真实落盘回执明确区分。 */
  demo: boolean;
  message: string;
};

/** 结果正文：文本/配图/手帐页三种形态转成可写入的 Markdown 片段。 */
export function resultToMarkdown(result: WorkbenchResult): string {
  if (result.kind === "text") return result.body;
  if (result.kind === "image") return `（配图：${result.caption}）`;
  return result.blocks.map((block) => `## ${block.heading}\n${block.body}`).join("\n\n");
}

/**
 * 写入预览：插入已有笔记时把原正文放在前面，用户先看到合并结果再确认，
 * 不做“悄悄覆盖”。确认前后用的是同一个函数，避免两处不一致。
 */
export function buildWritePreview(result: WorkbenchResult, noteBody?: string): string {
  const content = resultToMarkdown(result);
  return noteBody?.trim() ? `${noteBody.trim()}\n\n${content}` : content;
}

/**
 * 图片结果 → 对话消息附件名。
 * 扩展名跟 `dataUrl` 的真实 mime 走（服务端可能回 JPEG），不假定 PNG，
 * 也不让文件名和实际字节对不上。
 */
export function imageAttachmentName(result: { title: string; dataUrl?: string }): string {
  const mime = /^data:(image\/[a-z+.-]+);/i.exec(result.dataUrl ?? "")?.[1]?.toLowerCase();
  const extension = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png";
  const base = result.title.trim() || "图片";
  return `${base}.${extension}`;
}

/**
 * 时长显示：10 秒内给**两位**小数（"2.34s"），10 秒到 1 分钟给一位（"12.4s"），
 * 超过 1 分钟给「Xm Ys」。
 *
 * 秒表本身按 200ms 走（见 workbench-page），所以 10 秒内的小数位**每位都在动**；
 * 一位小数在 5Hz 刷新下会连着十几次显示同一个值，看起来像卡住了。
 * 只服务于"这一步花了多久"的直观读数，不参与预算或计费判断。
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 10_000) return `${(ms / 1_000).toFixed(2)}s`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

export type QuickNoteCandidate = { id: string; text: string; createdAt: string; score: number };

/** 笔记本目录：范围选择与写入目标共用一份最小结构。 */
export type WorkbenchNotebook = { id: string; title: string; notes: { id: string; title: string; body?: string; images?: { id: string; name: string; dataUrl?: string }[] }[] };

/**
 * 非流式接线：请求包含上下文快照、最近历史与修改目标。重试重放快照；取消丢弃晚到结果。
 * 每轮请求的**实时**上下文：记忆与 sessionId 不进重试快照，
 * 由调用方在每次发送/重试前按当前 revision 重新筛选。
 */
export type WorkbenchTurnContext = {
  sessionId?: string;
  /** 本轮回答消息的 ID：图片执行身份（sessionId/messageId/executionId…）绑定它。 */
  assistantMessageId?: string;
  /**
   * 本轮冻结的图片候选（只从当前会话派生，仅在本回合有效）。
   * 计划轮只看元数据；选定后由代码解析成具体来源并把执行快照写回这条回答。
   */
  imageSources?: import("./workbench-image-sources").WorkbenchImageSource[];
  /** 候选因数量上限未列全（必须在载荷里如实标注，不能说成“没有图片”）。 */
  imageSourcesTruncated?: boolean;
  /** 会话里存在但当前不可读的图片数量。 */
  imageSourcesUnreadable?: number;
  /**
   * F4 交付屏障（可等待）：交付会把 delivered 计入会话 summary revision。
   * 屏障须冻结新检查点并等待在途/已排队保存收拢后再放行交付；交付与
   * revision 同步完成后调用 onAfterDeliver 恢复检查点。
   */
  onBeforeDeliver?: () => Promise<void>;
  onAfterDeliver?: () => void;
  /**
   * 用户本轮**明确说出**的图片张数（如「这两张」）。自然聊天里它只作为要求交给计划轮，
   * 代码在解析来源时核对数量，不用它去猜是哪一组。
   */
  expectedSourceCount?: number;
  /**
   * R1：图片执行状态桥。执行器在**每个保存屏障**调用它：
   * - `request` 只在首次持久化时给出（固化已解析请求）；
   * - `attachment` 表示一个已生成产物要写入会话附件（保存失败必须抛错停止后续付费请求）；
   * - `plan/attempts` 是要写入这条回答的计划与尝试投影。
   */
  onImageStateResolved?: (state: {
    plan: import("@/features/ai/image-execution-contract").ImageTaskPlan;
    attempts: import("@/features/ai/image-execution-contract").ImageAttemptProjection[];
    request?: WorkbenchRequest;
    attachment?: MessageAttachment;
  }) => Promise<void>;
  /**
   * R1：重试/恢复时沿用**原计划**与尝试投影（重试不改变原任务含义）。
   * `regenerateUnknown` 只有用户显式「重新生成」才为 true。
   */
  imageResume?: {
    plan: import("@/features/ai/image-execution-contract").ImageTaskPlan;
    attempts: import("@/features/ai/image-execution-contract").ImageAttemptProjection[];
    regenerateUnknown?: boolean;
  };
  memory?: import("./workbench-memory").MemoryState;
  /** 当前快照（同步，用于没有权威重读钩子的场景）。 */
  getMemory?: () => import("./workbench-memory").MemoryState | undefined;
  /**
   * 每次外发前向权威来源重读（多标签撤销许可/外部删除必须被感知）。
   * 提供时优先；重读失败必须让本轮失败，不得按空记忆继续发送。
   */
  ensureMemory?: () => Promise<import("./workbench-memory").MemoryState>;
};

export interface WorkbenchAdapter {
  /**
   * 增量流式（可选）：实现方把事件实时回调出去，返回值与 `send` 一致（最终结果）。
   * 不实现时调用方退回 `send`（一次性结果）。
   */
  stream?(
    input: WorkbenchRequest & WorkbenchTurnContext & {
      signal: AbortSignal;
      /** 显式授权后，随记检索工具才可查全库；默认只查已引用的随记。 */
      allowAllQuickNotes?: boolean;
    },
    onEvent: (event: WorkbenchStreamEvent) => void
  ): Promise<WorkbenchTurnResult>;
  /** 固定范围内容，重试沿用快照，不默默读取更新后的资料。 */
  baselineFor?(target: WriteTarget): import("@/features/notebook/notebook-model").PageEditBaseline | undefined;
  prepare?(request: WorkbenchRequest): WorkbenchRequest;
  send(input: WorkbenchRequest & WorkbenchTurnContext & { signal: AbortSignal }): Promise<WorkbenchTurnResult>;
  searchQuickNotes(input: {
    query: string;
    notes: { id: string; text: string; createdAt: string }[];
  }): Promise<QuickNoteCandidate[]>;
  writeResult(input: { result: WorkbenchResult; target: WriteTarget; noteBody?: string; baseline?: import("@/features/notebook/notebook-model").PageEditBaseline }): Promise<WriteReceipt>;
}
