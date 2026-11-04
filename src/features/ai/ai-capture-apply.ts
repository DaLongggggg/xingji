import {
  assignCapturesToPage,
  createNotebookPageFromCaptures,
  prepareCaptureMedia,
  buildSourceSnapshots
} from "../capture/capture-assignment";
import type { CaptureRepository } from "../capture/capture-repository";
import type { NotebookRepository } from "../notebook/notebook-repository";
import {
  appendRequestDigest,
  createRequestDigest,
  sourceSnapshotDigest
} from "../notebook/append-service";
import { findAppendOperation } from "../notebook/notebook-model";
import {
  payloadDigest,
  markProposalApplied,
  markProposalConflicted,
  validateProposalPayload,
  type AiProposal,
  type OrganizeCapturesPayload
} from "./ai-proposal";
import { transitionAiTask } from "./ai-task";
import type { AiRepository } from "./ai-repository";

export type CaptureApplyDeps = {
  ai: AiRepository;
  notebooks: NotebookRepository;
  captures: CaptureRepository;
  now?: () => Date;
};
export type CaptureApplyResult = {
  status: "applied" | "failed" | "conflicted";
  message: string;
  pageId?: string;
  includedMessageIds?: string[];
  aiStatePending?: boolean;
  duplicateMessageIds?: string[];
};

/** Rebuild exactly the request identity used by the existing business services. */
export function captureProposalRequestDigest(id: string, payload: OrganizeCapturesPayload): string {
  const common = {
    operationId: id,
    expectedRevision: 0,
    duplicatePolicy: payload.duplicatePolicy ?? ("needs-confirmation" as const),
    sources: payload.sources.filter((s) => payload.includedMessageIds.includes(s.messageId)),
    draft: payload.draft
  };
  return payload.target.kind === "append"
    ? appendRequestDigest({ ...common, pageId: payload.target.pageId })
    : createRequestDigest({
        ...common,
        notebookId: payload.target.notebookId,
        title: payload.target.title
      });
}

/** Only explicit invocation can apply; recovery scans never change task/proposal status. */
export async function applyOrganizeCapturesProposal(
  deps: CaptureApplyDeps,
  proposalId: string
): Promise<CaptureApplyResult> {
  const { ai, notebooks, captures } = deps;
  const now = deps.now ?? (() => new Date());
  const failed = (message: string): CaptureApplyResult => ({ status: "failed", message });
  try {
    const proposal = await ai.getProposal(proposalId);
    if (
      !proposal ||
      proposal.type !== "organize_captures" ||
      proposal.payload.kind !== "organize_captures"
    )
      return failed("建议不存在或类型不符。");
    if (!["accepted", "accepting", "applied"].includes(proposal.status))
      return failed("建议尚未获得有效授权。");
    if (
      validateProposalPayload(proposal.payload).length ||
      !proposal.previewedAt ||
      proposal.payloadDigest !== payloadDigest(proposal.payload)
    )
      return failed("预览内容已变化，请重新生成建议。");
    const payload = structuredClone(proposal.payload);
    const digest = captureProposalRequestDigest(proposal.id, payload);
    const archive = await notebooks.loadArchive();
    const receipt = findAppendOperation(archive, proposal.id);
    const settle = async (
      claim: AiProposal,
      pageId: string,
      revision: number
    ): Promise<CaptureApplyResult> => {
      let aiStatePending = false;
      try {
        const current = await ai.getProposal(claim.id);
        if (!current) throw Error("建议状态已被清空");
        if (current.status !== "applied") {
          if (current.status !== "accepting") throw Error("建议状态已变化");
          await ai.saveProposal(markProposalApplied(current, revision, now), {
            expectedRevision: current.revision
          });
        }
        const task = await ai.getTask(claim.taskId);
        if (!task) throw Error("任务已被清空");
        if (task.status === "waiting_user" && task.proposalId === claim.id) {
          const done = transitionAiTask(task, "completed", {}, now, task.revision);
          if (done.ok) await ai.saveTask(done.task, { expectedRevision: task.revision });
        } else if (task.status !== "completed") throw Error("任务状态已变化");
      } catch {
        aiStatePending = true;
      }
      return {
        status: "applied",
        pageId,
        includedMessageIds: payload.includedMessageIds,
        aiStatePending,
        message: aiStatePending
          ? "手帐已保存，建议状态尚未更新；可显式重试同步状态，不会重复写入。"
          : "已加入手帐；原始记录保留。"
      };
    };
    if (receipt) {
      if (receipt.requestDigest !== digest) return failed("操作身份与冻结内容不一致，未继续。");
      if (receipt.status === "purged") return failed("该建议的目标已永久删除，不会重新创建。");
      if (proposal.status === "applied")
        return await settle(
          proposal,
          receipt.resultPageId ?? receipt.pageId,
          receipt.resultRevision
        );
      const claim = await ai.authorizeCommit({ proposalId, expectedRevision: proposal.revision });
      if (!claim.ok) return failed("建议授权已变化，请刷新后重试。");
      return await settle(
        claim.proposal,
        receipt.resultPageId ?? receipt.pageId,
        receipt.resultRevision
      );
    }
    if (proposal.status === "applied") return failed("缺少业务收据，不能重复提交已应用建议。");
    // Re-derive IDs from actual bytes, never trust a frozen media ID for changed image content.
    const currentCapture = await captures.loadArchive();
    const messages = payload.sources.map((s) =>
      currentCapture.messages.find((m) => m.id === s.messageId)
    );
    let sourceChanged = messages.some((m) => !m);
    const media = await captures.loadMedia();
    if (!sourceChanged) {
      const selected = messages.filter((m): m is NonNullable<typeof m> => Boolean(m));
      try {
        const prepared = await prepareCaptureMedia(selected, media);
        const actual = buildSourceSnapshots(selected, prepared);
        sourceChanged = actual.some(
          (s, i) => sourceSnapshotDigest(s) !== sourceSnapshotDigest(payload.sources[i])
        );
      } catch {
        sourceChanged = true;
      }
    }
    if (sourceChanged) {
      // An accepting claim may belong to another active attempt: never revoke it from a scan/retry.
      if (proposal.status === "accepted")
        await ai.saveProposal(markProposalConflicted(proposal, "来源已变化，请重新生成。", now), {
          expectedRevision: proposal.revision
        });
      return { status: "conflicted", message: "来源已变化或图片缺失，未加入手帐。请重新生成。" };
    }
    const latest = await notebooks.loadArchive();
    const target = payload.target;
    if (target.kind === "append") {
      const page = latest.pages.find((p) => p.id === target.pageId);
      const book = latest.notebooks.find((b) => b.id === page?.notebookId);
      if (
        !page ||
        page.deletedAt ||
        !book ||
        book.deletedAt ||
        book.archivedAt ||
        page.source.kind === "legacy-journal"
      )
        return failed("目标篇不可用，请选择其他目标重新生成。");
    } else if (
      !latest.notebooks.some((b) => b.id === target.notebookId && !b.deletedAt && !b.archivedAt)
    )
      return failed("目标手帐本不可用。");
    const duplicates =
      target.kind === "append"
        ? payload.includedMessageIds.filter((id) =>
            latest.pageSources?.some(
              (link) => link.pageId === target.pageId && link.messageId === id
            )
          )
        : [];
    if (duplicates.length && !payload.duplicatePolicy) {
      return {
        status: "failed",
        message: "部分记录已加入目标篇，请选择跳过或明确重复追加，再核对新预览。",
        duplicateMessageIds: duplicates
      };
    }
    const claim = await ai.authorizeCommit({ proposalId, expectedRevision: proposal.revision });
    if (!claim.ok) return failed("建议授权已变化，未提交。");
    const included = messages.filter((m): m is NonNullable<typeof m> =>
      Boolean(m && payload.includedMessageIds.includes(m.id))
    );
    const common = {
      messageIds: payload.includedMessageIds,
      messages: included,
      duplicatePolicy: payload.duplicatePolicy ?? ("needs-confirmation" as const),
      operationId: proposal.id,
      draft: payload.draft
    };
    const assignmentDeps = {
      captureRepository: captures,
      notebookRepository: notebooks,
      notebookArchive: latest,
      captureMedia: media,
      now
    };
    // Keep accepting on uncertain outcomes: another attempt may already be in flight.
    const outcome =
      target.kind === "append"
        ? await assignCapturesToPage({ ...common, pageId: target.pageId }, assignmentDeps)
        : await createNotebookPageFromCaptures(
            { ...common, notebookId: target.notebookId, title: target.title },
            assignmentDeps
          );
    const committed = findAppendOperation(await notebooks.loadArchive(), proposal.id);
    if (committed && committed.requestDigest === digest && committed.status === "applied")
      return await settle(
        claim.proposal,
        committed.resultPageId ?? committed.pageId,
        committed.resultRevision
      );
    return failed(
      outcome.status === "needs-confirmation"
        ? "部分记录已加入目标篇；未重复写入，请使用其他目标或基础排版的重复确认操作。"
        : (outcome.detail ?? "本次未完成提交，可显式重试；原记录保留。")
    );
  } catch (error) {
    return failed(
      `提交未能确认：${error instanceof Error ? error.message : String(error)}。请显式重试核对收据。`
    );
  }
}
