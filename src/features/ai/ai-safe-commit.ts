/**
 * P1-03：AI 安全提交（Safe Commit）与幂等边界。
 *
 * 完整链路：
 *   生成建议 → 结构校验 → 冻结预览 → 明确接受该版本 → 协调已有保存
 *   → 重读目标与基线 → 现有写管线（revision 事务 + 收据）→ 真实提交确认
 *
 * 边界：
 * - 未接受/已拒绝/载荷被改动的建议**不会产生任何业务写入**；
 * - 模型、Provider、Gateway 不能调用本模块：它们只产出数据，本模块只接受已冻结的 Proposal；
 * - 只替换已有 text block 的内容与允许的标题；图片、unsupported-image、块身份与相对顺序不变；
 * - 不建立跨库事务框架：收据与业务修改在同一个 Notebook 事务内提交。
 */
import {
  digestPageBlocks,
  findTripJournal,
  isPageDeleted,
  MAX_PAGE_TITLE_LENGTH,
  type NotebookPage,
  type NotebookPageBlock
} from "../notebook/notebook-model";
import {
  assertCapacityForChange,
  assertChangedPagesMediaResolvableSync
} from "../notebook/notebook-write-guards";
import type { ArchiveCore } from "../notebook/notebook-repository";
import { pageSourceDigest } from "./ai-context";
import type { AiCommitOutcome, NotebookRepository } from "../notebook/notebook-repository";
import {
  checkPayloadAgainstBlocks,
  markProposalApplied,
  markProposalConflicted,
  payloadDigest,
  type AiProposal,
  type OrganizePagePayload
} from "./ai-proposal";
import type { AiRepository } from "./ai-repository";

/** 只能接受这一种“按已冻结载荷应用”的 Proposal。 */
export type SafeCommitRequest = {
  proposal: AiProposal;
  /** 接受时已协调过的保存版本；用于重读目标后核对。 */
  expectedRevision: number;
  /** 缺省用当前时间。 */
  now?: () => Date;
};

export type SafeCommitOutcome =
  | {
      status: "applied" | "replayed";
      proposal: AiProposal;
      revision: number;
      page: NotebookPage;
      receipt: AiCommitOutcome;
      /** 业务已提交但 AI 状态未更新成功；收据仍阻止重放，需按此诊断。 */
      aiStateError?: string;
    }
  | {
      status: "not-accepted" | "digest-mismatch" | "payload-invalid" | "target-unavailable";
      detail: string;
    }
  | { status: "conflicted"; detail: string; proposal: AiProposal }
  | { status: "revision-conflict"; currentRevision: number }
  | { status: "receipt-limit"; limit: number };

export class SafeCommitPayloadError extends Error {
  constructor(readonly detail: string) {
    super(`AI_SAFE_COMMIT_PAYLOAD_INVALID:${detail}`);
    this.name = "SafeCommitPayloadError";
  }
}

/**
 * 按载荷替换块内容：只改被点名的 text block 的 `text`，
 * 其余块（photo / unsupported-image / 未被点名的 text）**原对象原顺序**保留。
 */
export function applyOrganizePayload(
  blocks: readonly NotebookPageBlock[],
  payload: OrganizePagePayload
): NotebookPageBlock[] {
  const replacements = new Map(payload.textBlocks.map((block) => [block.blockId, block.content]));
  return blocks.map((block) => {
    if (block.type !== "text") return block;
    const content = replacements.get(block.id);
    if (content === undefined) return block;
    return { ...block, text: content };
  });
}

/**
 * R2：提交依据必须来自持久化建议的冻结身份与基线。
 *
 * 这里刻意**不提供**调用方传入 baseline 的入口：请求只带 Proposal ID 与期望 revision，
 * 基线与源摘要一律从 `stored.baselines` / `stored.sourceRefs` 读取，因此
 * “省略基线”“传错 pageId”都不可能绕开核对。
 */
export type FrozenBaselineCheck =
  | { ok: true; baseline: { pageId: string; updatedAt: string; blocksDigest: string } }
  | {
      ok: false;
      code: "BASELINE_MISSING" | "BASELINE_DUPLICATE" | "BASELINE_WRONG_PAGE" | "BASELINE_INVALID";
      detail: string;
    };

/** 解析并核对“唯一且指向目标页”的冻结基线；缺失/重复/错页/结构不合法都拒绝。 */
export function resolveFrozenBaseline(
  proposal: Pick<AiProposal, "baselines">,
  pageId: string
): FrozenBaselineCheck {
  const baselines = proposal.baselines ?? [];
  const forPage = baselines.filter((baseline) => baseline.pageId === pageId);
  if (baselines.length === 0) {
    return { ok: false, code: "BASELINE_MISSING", detail: "建议没有冻结基线，拒绝应用。" };
  }
  if (forPage.length === 0) {
    return {
      ok: false,
      code: "BASELINE_WRONG_PAGE",
      detail: `建议的冻结基线指向其它篇（${baselines.map((item) => item.pageId).join(",")}）。`
    };
  }
  if (forPage.length > 1) {
    return { ok: false, code: "BASELINE_DUPLICATE", detail: "目标篇存在多条冻结基线，拒绝应用。" };
  }
  const baseline = forPage[0];
  if (
    typeof baseline.updatedAt !== "string" ||
    baseline.updatedAt.length === 0 ||
    typeof baseline.blocksDigest !== "string" ||
    baseline.blocksDigest.length === 0
  ) {
    return { ok: false, code: "BASELINE_INVALID", detail: "冻结基线结构不完整。" };
  }
  return { ok: true, baseline };
}

/**
 * 冻结源身份：接受前把当前源重新算一遍，与建议生成时的 sourceRefs 比较。
 * 复用的是 Context/Search 同一份 `pageSourceDigest` 规范（`xsd1`）。
 */
export function checkFrozenSource(input: {
  archive: ArchiveCore;
  page: NotebookPage;
  sourceRefs: AiProposal["sourceRefs"];
}):
  | { ok: true; sourceDigest: string }
  | {
      ok: false;
      code: "SOURCE_REF_MISSING" | "SOURCE_REF_DUPLICATE" | "SOURCE_CHANGED" | "SOURCE_REF_INVALID";
      detail: string;
    } {
  const refs = input.sourceRefs ?? [];
  const forPage = refs.filter((ref) => ref.kind === "page" && ref.id === input.page.id);
  if (refs.length === 0) {
    return { ok: false, code: "SOURCE_REF_MISSING", detail: "建议没有冻结源引用，拒绝应用。" };
  }
  if (forPage.length === 0) {
    return { ok: false, code: "SOURCE_REF_MISSING", detail: "建议的源引用未指向目标篇。" };
  }
  if (forPage.length > 1) {
    return { ok: false, code: "SOURCE_REF_DUPLICATE", detail: "目标篇存在多条源引用。" };
  }
  const ref = forPage[0];
  if (typeof ref.sourceDigest !== "string" || !ref.sourceDigest.startsWith("xsd1:")) {
    return { ok: false, code: "SOURCE_REF_INVALID", detail: "冻结源摘要格式不合法。" };
  }
  const notebook = input.archive.notebooks.find((item) => item.id === input.page.notebookId);
  const regions = findTripJournal(input.archive, input.page.id)?.regions ?? [];
  const current = pageSourceDigest(input.page, notebook, regions);
  if (current !== ref.sourceDigest) {
    return {
      ok: false,
      code: "SOURCE_CHANGED",
      detail: "源内容在建议生成后已变化（正文、标题、时间或地区），拒绝应用。"
    };
  }
  return { ok: true, sourceDigest: current };
}

/**
 * 保存协调结果。
 * - `void` / `undefined` / `true` / `{ ok: true }` → 保存已完成，可以进入业务提交；
 * - `false` / `{ ok: false, detail? }` → 保存未完成（例如 autosave 失败），**必须阻止** AI 写入；
 * - 抛出异常 → 同样阻止，异常向上传递（调用方可保留草稿并显示错误）。
 *
 * 不接受“返回一个 Promise 就当成功”：那样 autosave 失败会被吞掉并写入旧内容。
 */
export type SaveCoordinatorResult = void | boolean | { ok: boolean; detail?: string };

export type SaveCoordinator = () => Promise<SaveCoordinatorResult> | SaveCoordinatorResult;

/**
 * 应用一条已接受的建议。
 *
 * 步骤：重读 AI 库中的 Proposal（AI 状态是授权来源）→ 校验接受身份与载荷
 * → 协调已有保存（autosave）→ 在 Notebook 事务内重读目标、核对删除态/只读态/冻结基线、
 * 应用块替换、写收据 → 业务提交成功后更新 AI 状态（失败不回滚业务，收据仍是事实）。
 */
export async function applyAiProposal(
  ai: AiRepository,
  notebooks: NotebookRepository,
  request: SafeCommitRequest,
  onSaved?: SaveCoordinator
): Promise<SafeCommitOutcome> {
  const now = request.now ?? (() => new Date());

  const stored = await ai.getProposal(request.proposal.id);
  if (!stored) return { status: "not-accepted", detail: "AI 库中没有这条建议。" };
  /*
   * 状态判定统一交给 `checkAuthorization`：它允许 `accepted`（正常授权）、
   * `applied`、`accepting`（上一次业务已提交但 AI 状态未落）走收据幂等重放；
   * 其余状态（draft/rejected/conflicted）明确不授权。
   */
  if (stored.payload.kind !== "organize_page") {
    return { status: "payload-invalid", detail: `未启用的载荷类型：${stored.payload.kind}。` };
  }
  const payload = stored.payload;
  const frozenPageId = payload.pageId;

  // 事务前的授权核对（快速失败）：撤回/清空后不再进入保存协调。
  const preGate = await checkAuthorization(ai, stored);
  if (!preGate.ok) return preGate.outcome;

  /*
   * R3：协调已有保存（例如等待 autosave 落盘）。
   * 失败（false / {ok:false}）或抛出都必须阻止 AI 写入——不能基于旧内容整理。
   */
  if (onSaved) {
    const coordinated = await onSaved();
    const saveFailed =
      coordinated === false ||
      (typeof coordinated === "object" && coordinated !== null && coordinated.ok === false);
    if (saveFailed) {
      const detail =
        typeof coordinated === "object" && coordinated !== null && coordinated.detail
          ? coordinated.detail
          : "保存未完成（autosave 失败或冲突），已停止 AI 应用。";
      return { status: "target-unavailable", detail };
    }
  }

  /*
   * F2：保存等待结束后，**重新读取持久化权威状态**再决定是否继续。
   * 等待期间用户可能撤回、清空 AI 数据或换版本；这些都不能继续用等待前的对象。
   * 授权身份（任务 id）取自建议自身的 `taskId`，不接受调用方传入，
   * 因此不能靠“不传参数”绕开核对。
   */
  const reauthorized = await checkAuthorization(ai, stored);
  if (!reauthorized.ok) return reauthorized.outcome;
  const authoritative = reauthorized.stored;

  /*
   * F2 提交屏障：业务事务之前先原子占用授权（accepted → accepting）。
   * 这一步同时是“最后一次授权核对”与撤回的互斥点：
   * - 撤回/清空发生在此之前 → 占用失败，不进入业务提交；
   * - 撤回发生在此之后 → 建议处于 accepting，撤回被拒绝，不会出现悬挂提交。
   * 若授权确实已被占用（并发提交），这里也会明确失败而不是重复写。
   */
  /*
   * 期望版本取**权威副本**（不是调用方传入的快照）：调用方可能持有较旧的
   * accepted 快照（例如“业务已提交、AI 状态未落”时的恢复重试），
   * 用旧 revision 做 CAS 会把合法重放误判为授权失效。
   */
  const authorized = await ai.authorizeCommit({
    proposalId: authoritative.id,
    expectedRevision: authoritative.revision
  });
  if (!authorized.ok) {
    return {
      status: "not-accepted",
      detail: `建议状态是 ${authorized.status}，不再授权应用。`
    };
  }

  // 事务前的预检只用于给出明确错误；权威校验在事务内。
  const preview = await notebooks.loadArchive();
  const previewPage = preview.pages.find((page) => page.id === frozenPageId);
  if (!previewPage || previewPage.notebookId.length === 0) {
    return await markUnavailable(ai, stored, "目标篇不存在。", now);
  }

  // 事务内的权威判定：目标可用性、只读态、基线、载荷白名单。
  let outcome: AiCommitOutcome;
  try {
    outcome = await notebooks.commitJournalChangeWithReceipt(
      (current) => {
        const page = current.pages.find((item) => item.id === frozenPageId);
        if (!page) throw new SafeCommitPayloadError("目标篇已不存在。");
        // 事务内再核对一次任务身份：核对之后被撤回/清空则拒绝（见 checkTaskAuthorizesApply）。
        const notebook = current.notebooks.find((item) => item.id === page.notebookId);
        if (!notebook || notebook.deletedAt) throw new SafeCommitPayloadError("父手帐本不可用。");
        if (isPageDeleted(page)) throw new SafeCommitPayloadError("目标是已删除页，拒绝应用。");
        if (page.source.kind === "legacy-journal") {
          throw new SafeCommitPayloadError("legacy 关联查看页是只读的，拒绝应用。");
        }
        const issues = checkPayloadAgainstBlocks(payload, page.blocks);
        if (issues.length > 0) {
          throw new SafeCommitPayloadError(
            issues.map((issue) => `${issue.code}:${issue.detail}`).join("；")
          );
        }
        // R2：冻结基线来自已存建议本身，缺少/重复/错页/不匹配一律拒绝。
        const baselineCheck = resolveFrozenBaseline(authoritative, page.id);
        if (!baselineCheck.ok) throw new SafeCommitPayloadError(baselineCheck.detail);
        if (
          baselineCheck.baseline.updatedAt !== page.updatedAt ||
          baselineCheck.baseline.blocksDigest !== digestPageBlocks(page)
        ) {
          throw new SafeCommitConflict("冻结基线与当前内容不一致。");
        }
        // R2：源身份（正文/标题/时间/地区）必须与生成时一致。
        const sourceCheck = checkFrozenSource({
          archive: current,
          page,
          sourceRefs: authoritative.sourceRefs
        });
        if (!sourceCheck.ok) {
          if (sourceCheck.code === "SOURCE_CHANGED")
            throw new SafeCommitConflict(sourceCheck.detail);
          throw new SafeCommitPayloadError(sourceCheck.detail);
        }
        const blocks = applyOrganizePayload(page.blocks, payload);
        const updated: NotebookPage = {
          ...page,
          title:
            payload.title === undefined
              ? page.title
              : payload.title.trim().slice(0, MAX_PAGE_TITLE_LENGTH),
          blocks,
          updatedAt: now().toISOString()
        };
        return {
          archive: {
            ...current,
            pages: current.pages.map((item) => (item.id === frozenPageId ? updated : item))
          },
          receipt: {
            pageId: frozenPageId,
            notebookId: updated.notebookId,
            appliedRevision: current.revision + 1,
            appliedPageUpdatedAt: updated.updatedAt
          }
        };
      },
      {
        operationId: authoritative.id,
        // 在事务内基于当前档案计算：同一 operationId 只有载荷完全一致才算重放。
        payloadDigest: () => payloadDigest(payload),
        now
      },
      {
        expectedRevision: request.expectedRevision,
        /*
         * R3：复用人工保存同一套写入保护，并且在**同一个事务内**针对事务读到的
         * 当前档案与拟提交结果执行。媒体可解析性依据实际媒体 store（含二进制载荷），
         * 容量按提交后的最终引用集计算；任一不通过即抛错，事务整体回滚。
         *
         * 注意：幂等重放不经过这里（repository 在收到既有收据时直接返回），
         * 因此不会因为之后容量变化而错误拒绝已成功提交的操作。
         */
        guard: {
          validate: ({ stored: storedArchive, next, resolvableMediaIds, assetSizes }) => {
            assertChangedPagesMediaResolvableSync({
              stored: storedArchive,
              next,
              pendingMedia: [],
              // 事务内实际可解析的媒体（含二进制载荷）才算存在。
              storedResolvableIds: resolvableMediaIds,
              // AI 首期不做“保留既有缺失引用”：目标必须当前可解析。
              allowedMissingMediaIds: [],
              /*
               * F3：AI 首期只改文字、保持图片引用不变，因此目标页不会被“引用变化”选中。
               * 这里显式把实际目标页作为硬目标：它的图片引用必须整体可解析。
               */
              hardTargets: [payload.pageId]
            });
            assertCapacityForChange(storedArchive, next, [], assetSizes);
          }
        }
      }
    );
  } catch (error) {
    if (error instanceof SafeCommitConflict) {
      // 冲突自身就是终态结论（conflicted 记录旧建议），不再释放为 accepted。
      const conflicted = markProposalConflicted(authorized.proposal, error.message, now);
      await ai.saveProposal(conflicted, { expectedRevision: authorized.proposal.revision });
      return { status: "conflicted", detail: error.message, proposal: conflicted };
    }
    // 失败释放：业务事务没有提交，把 accepting 还原为 accepted，等待用户显式重试。
    await releaseCommit(ai, authorized.proposal);
    if (error instanceof SafeCommitPayloadError) {
      return { status: "payload-invalid", detail: error.message };
    }
    // 事务失败：原数据未变，保留 accepted 与可见错误，不报告 applied。
    throw error;
  }

  // 业务未提交（revision 冲突/收据上限/操作身份冲突）：仅在仍处于提交中时释放占用。
  if (outcome.status !== "committed" && outcome.status !== "replayed") {
    await releaseCommit(ai, authorized.proposal);
  }

  return await settle(ai, notebooks, authorized.proposal, payload, outcome, now);
}

class SafeCommitConflict extends Error {
  constructor(detail: string) {
    super(`AI_SAFE_COMMIT_CONFLICT:${detail}`);
    this.name = "SafeCommitConflict";
  }
}

/**
 * 授权核对（F2）：读取**持久化**建议与它自己的任务关系，判定当前是否仍被授权应用。
 *
 * 三件事必须同时成立：
 * 1. 建议仍存在、状态仍是 `accepted`、载荷与冻结摘要一致；
 * 2. revision 与权威版本一致（等待期间被改写即失效）；
 * 3. 建议关联的任务仍存在、仍停在 `waiting_user`、revision 一致（清空/重试/取消即失效）。
 *
 * 任务身份取自 `stored.taskId`，不是调用方参数——因此“不传任务”不能绕开核对。
 */
async function checkAuthorization(
  ai: AiRepository,
  stored: AiProposal
): Promise<{ ok: true; stored: AiProposal } | { ok: false; outcome: SafeCommitOutcome }> {
  const current = await ai.getProposal(stored.id);
  if (!current) {
    return {
      ok: false,
      outcome: { status: "not-accepted", detail: "AI 库里已没有这条建议，授权已失效。" }
    };
  }
  /*
   * 允许继续核对的状态：
   * - `accepted`：正常授权；
   * - `applied`：已应用，走收据幂等重放判定；
   * - `accepting`：上一次业务已提交但 AI 状态未落（提交占用未释放），
   *   同样必须走收据判定而不是直接拒绝，否则“业务成功、AI 状态失败”的重试会被误拒。
   * 其它状态（draft/rejected/conflicted）不授权。
   */
  if (
    current.status !== "accepted" &&
    current.status !== "applied" &&
    current.status !== "accepting"
  ) {
    return {
      ok: false,
      outcome: { status: "not-accepted", detail: `建议状态是 ${current.status}，不再授权应用。` }
    };
  }
  if (!current.payloadDigest || payloadDigest(current.payload) !== current.payloadDigest) {
    return {
      ok: false,
      outcome: { status: "digest-mismatch", detail: "载荷与已接受的预览版本不一致。" }
    };
  }
  if (
    current.status === "accepted" &&
    stored.status !== "accepting" &&
    current.revision !== stored.revision
  ) {
    return {
      ok: false,
      outcome: { status: "not-accepted", detail: "建议在等待保存期间被改写，本授权不再有效。" }
    };
  }

  const task = await ai.getTask(current.taskId);
  if (!task) {
    return {
      ok: false,
      outcome: {
        status: "not-accepted",
        detail: "这条建议对应的任务已不存在（可能已清空或重试），授权已失效。"
      }
    };
  }
  if (task.status !== "waiting_user") {
    return {
      ok: false,
      outcome: { status: "not-accepted", detail: `任务状态是 ${task.status}，不再授权应用。` }
    };
  }
  /*
   * 注意：**不比较任务 revision 与建议 revision**。两者是各自独立递增的版本号
   * （任务按状态迁移递增，建议按预览/接受递增），相等是巧合而不是契约。
   * 这里用状态 + 建议关系（task.proposalId）确认“这是该建议的当前尝试”。
   */
  if (task.proposalId !== undefined && task.proposalId !== current.id) {
    return {
      ok: false,
      outcome: {
        status: "not-accepted",
        detail: "任务已指向另一条建议（可能已显式重试），本授权不再有效。"
      }
    };
  }
  return { ok: true, stored: current };
}

/**
 * 失败释放：把提交中占用还原为 `accepted`（CAS 失败说明已被其它结论覆盖，忽略即可）。
 * 不掩盖根因：释放失败不抛出，由调用方按原错误返回。
 */
async function releaseCommit(ai: AiRepository, proposal: AiProposal): Promise<void> {
  try {
    const current = await ai.getProposal(proposal.id);
    // 只释放“提交中”占用：已被置为 applied/conflicted/rejected 的结论不被覆盖。
    if (!current || current.status !== "accepting") return;
    await ai.saveProposal(
      { ...current, status: "accepted", revision: current.revision + 1 },
      { expectedRevision: current.revision }
    );
  } catch {
    // 释放失败不覆盖根因；应用重启后的中断恢复会处理遗留 accepting。
  }
}

async function markUnavailable(
  ai: AiRepository,
  proposal: AiProposal,
  detail: string,
  now: () => Date
): Promise<SafeCommitOutcome> {
  const conflicted = markProposalConflicted(proposal, detail, now);
  try {
    await ai.saveProposal(conflicted, { expectedRevision: proposal.revision });
  } catch {
    // AI 状态更新失败不影响结论：目标确实不可用。
  }
  return { status: "target-unavailable", detail };
}

async function settle(
  ai: AiRepository,
  notebooks: NotebookRepository,
  proposal: AiProposal,
  payload: OrganizePagePayload,
  outcome: AiCommitOutcome,
  now: () => Date
): Promise<SafeCommitOutcome> {
  if (outcome.status === "revision-conflict") {
    return { status: "revision-conflict", currentRevision: outcome.currentRevision };
  }
  if (outcome.status === "receipt-limit") {
    return { status: "receipt-limit", limit: outcome.limit };
  }
  if (outcome.status === "conflict") {
    void 0;
    /*
     * 同 operationId 不同载荷：保留旧建议与事实，不覆盖。
     * AI 状态写入需要 CAS：并发竞争失败时以 AI 库里的当前状态为准——
     * 对方可能已经把这条建议正常提交为 applied，此时不能把它改写成 conflicted。
     */
    const detail = "同一操作身份已提交过不同载荷，已拒绝。";
    const conflicted = markProposalConflicted(proposal, detail, now);
    try {
      await ai.saveProposal(conflicted, { expectedRevision: proposal.revision });
      return { status: "conflicted", detail, proposal: conflicted };
    } catch {
      // 收据仍是事实来源；据 AI 库当前值给出结论。
      return {
        status: "conflicted",
        detail,
        proposal: (await ai.getProposal(proposal.id)) ?? conflicted
      };
    }
  }

  // 业务已提交（首次或重放）。真实回读提交结果，据实际内容决定 applied/conflicted。
  const archive = await notebooks.loadArchive();
  const page = archive.pages.find((item) => item.id === payload.pageId);
  if (!page) {
    const conflicted = markProposalConflicted(proposal, "提交后目标篇不可读。", now);
    return { status: "conflicted", detail: "提交后目标篇不可读。", proposal: conflicted };
  }
  const applied = markProposalApplied(proposal, outcome.receipt.appliedRevision, now);
  try {
    // 期望版本是“提交中”占用后的版本（authorizeCommit 已 +1）。
    await ai.saveProposal(applied, { expectedRevision: proposal.revision });
  } catch (error) {
    /*
     * 业务已提交、AI 状态更新失败：不回滚业务，也不谎报。两种情形都在这里收敛，
     * 且都不会重复写业务数据：
     * 1. AI 库不可用；
     * 2. 并发接受竞争失败（另一个调用已把 revision 推进）——收据证明业务只提交了一次。
     */
    const current = await ai.getProposal(proposal.id).catch(() => null);
    /*
     * 业务已提交、AI 状态未落：**保留 `accepting` 占用**，不要还原为 accepted。
     * `accepting` 是可恢复状态：显式重试时授权仍有效、`authorizeCommit` 幂等返回，
     * 业务事务命中收据重放，再写 applied。还原成 accepted 反而会把“已提交”的占用
     * 降级，使重试重新走一遍未经收据核对的新提交路径。
     */
    return {
      status: outcome.status === "replayed" ? "replayed" : "applied",
      proposal: current ?? proposal,
      revision: outcome.receipt.appliedRevision,
      page,
      receipt: outcome,
      aiStateError: error instanceof Error ? error.message : String(error)
    };
  }
  return {
    status: outcome.status === "replayed" ? "replayed" : "applied",
    proposal: applied,
    revision: outcome.receipt.appliedRevision,
    page,
    receipt: outcome
  };
}
