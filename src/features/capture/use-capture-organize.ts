"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createIndexedDbAiRepository, type AiRepository } from "../ai/ai-repository";
import {
  createIndexedDbRepository,
  type NotebookRepository
} from "../notebook/notebook-repository";
import { createIndexedDbCaptureRepository, type CaptureRepository } from "./capture-repository";
import {
  createAiGatewayCaller,
  listAiConfigs,
  type AiGatewayCaller
} from "../ai/ai-gateway-client";
import { runCaptureOrganizeTask, captureSourcesDigest } from "../ai/ai-capture-runner";
import { applyOrganizeCapturesProposal } from "../ai/ai-capture-apply";
import {
  acceptProposal,
  previewProposal,
  rejectProposal,
  withdrawAcceptedProposal,
  type AiProposal
} from "../ai/ai-proposal";
import {
  transitionAiTask,
  type CaptureOrganizeTarget,
  type OrganizeCapturesAiTask
} from "../ai/ai-task";
import { prepareCaptureMedia, buildSourceSnapshots } from "./capture-assignment";
import { useWorkbenchStore } from "../workbench/workbench-store";

type Deps = {
  ai: AiRepository;
  notebooks: NotebookRepository;
  captures: CaptureRepository;
  callGateway: AiGatewayCaller;
  configs: typeof listAiConfigs;
};
export function useCaptureOrganize(options: {
  active: boolean;
  onSaved: () => Promise<void>;
  onArchive: (ids: string[]) => Promise<void>;
  deps?: Deps;
}) {
  const [deps] = useState<Deps>(() => {
    if (options.deps) return options.deps;
    /*
     * T2a 复核三：默认仓储按当前账号命名空间派生（XingjiApp 已在业务树挂载前把
     * serverId/userId 登记进工作台 Store）——不读旧单用户库，也能找到新账号的随记；
     * 未登记（既有单用户测试路径）沿用旧库名。
     */
    const { accountId, serverId } = useWorkbenchStore.getState();
    const namespace = accountId && serverId ? { serverId, userId: accountId } : undefined;
    return {
      ai: createIndexedDbAiRepository(undefined, namespace),
      notebooks: createIndexedDbRepository(undefined, undefined, namespace),
      captures: createIndexedDbCaptureRepository(undefined, undefined, namespace),
      callGateway: createAiGatewayCaller(),
      configs: listAiConfigs
    };
  });
  const [proposal, setProposal] = useState<AiProposal | null>(null);
  const [pending, setPending] = useState<AiProposal[]>([]);
  const [busy, setBusy] = useState<"generating" | "applying" | null>(null);
  const [message, setMessage] = useState("");
  const [duplicates, setDuplicates] = useState<string[]>([]);
  const epoch = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const lock = useRef(false);
  const latest = useRef(options);
  useLayoutEffect(() => {
    latest.current = options;
  });
  const current = (id: number) => epoch.current === id && latest.current.active;
  useEffect(() => {
    if (!options.active) return;
    const id = ++epoch.current;
    void (async () => {
      const tasks = await deps.ai.listTasks();
      if (current(id)) setBusy(null);
      const proposals = await Promise.all(
        tasks
          .filter(
            (t) => t.type === "organize_captures" && t.proposalId && t.status === "waiting_user"
          )
          .map((t) => deps.ai.getProposal(t.proposalId!))
      );
      if (current(id))
        setPending(
          proposals.filter((p): p is AiProposal =>
            Boolean(p && ["draft", "accepted", "accepting", "applied"].includes(p.status))
          )
        );
    })().catch(() => {
      if (current(id)) setMessage("恢复列表读取失败，可重新打开记录页重试。");
    });
    return () => {
      epoch.current++;
      controller.current?.abort();
      lock.current = false;
    };
  }, [options.active, deps]);
  async function generate(ids: string[], target: CaptureOrganizeTarget) {
    if (lock.current || !latest.current.active) return;
    lock.current = true;
    const id = ++epoch.current;
    controller.current = new AbortController();
    setBusy("generating");
    setMessage("");
    setProposal(null);
    try {
      const configs = await deps.configs();
      if (!current(id)) return;
      if (configs.status !== "available" || !configs.configs.length)
        throw Error("AI 尚未配置，未发送记录。");
      const archive = await deps.captures.loadArchive();
      if (!current(id)) return;
      const messages = ids.map((key) => archive.messages.find((m) => m.id === key));
      if (!ids.length || new Set(ids).size !== ids.length || messages.some((m) => !m))
        throw Error("选中记录已变化，请重新选择。");
      const selected = messages.filter((m): m is NonNullable<typeof m> => Boolean(m));
      const media = await deps.captures.loadMedia();
      if (!current(id)) return;
      const prepared = await prepareCaptureMedia(selected, media);
      if (!current(id)) return;
      const sources = buildSourceSnapshots(selected, prepared);
      const stamp = new Date().toISOString();
      const task: OrganizeCapturesAiTask = {
        id: crypto.randomUUID(),
        type: "organize_captures",
        status: "queued",
        revision: 0,
        input: {
          target: structuredClone(target),
          sourceMessageIds: ids.slice(),
          sourcesDigest: captureSourcesDigest(sources),
          maxOutputChars: 8000
        },
        promptId: "capture-organize",
        promptVersion: 1,
        createdAt: stamp,
        updatedAt: stamp
      };
      const result = await runCaptureOrganizeTask(
        {
          ai: deps.ai,
          sources,
          mediaLink: prepared.link,
          selectConfig: () => configs.configs[0].id,
          callGateway: deps.callGateway,
          signal: controller.current.signal
        },
        task
      );
      if (!current(id)) return;
      if (result.status === "waiting_user") setProposal(result.proposal);
      setMessage(
        result.status === "waiting_user"
          ? "请核对预览，接受后才加入笔记。"
          : result.status === "completed"
            ? "没有可加入的文字内容。"
            : result.status === "failed"
              ? result.detail
              : "已取消或任务状态已变化。"
      );
    } catch (error) {
      if (current(id)) setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (current(id)) {
        setBusy(null);
        lock.current = false;
      }
    }
  }
  function cancel() {
    controller.current?.abort();
    epoch.current++;
    lock.current = false;
    setBusy(null);
    setMessage("已取消生成。");
  }
  async function edit(index: number, text: string) {
    if (!proposal || proposal.status !== "draft" || lock.current) return false;
    lock.current = true;
    const id = epoch.current;
    try {
      const stored = await deps.ai.getProposal(proposal.id);
      if (!current(id)) return false;
      if (!stored || stored.status !== "draft" || stored.payload.kind !== "organize_captures")
        throw Error("建议已变化，请重新打开。");
      const next = structuredClone(stored);
      if (next.payload.kind !== "organize_captures") return false;
      const entry = next.payload.draft.entries[index];
      if (entry?.kind !== "message") return false;
      entry.blocks = [{ type: "text", text }];
      const frozen = previewProposal(next);
      if (!frozen.ok) throw Error("预览内容不合法，未保存修改。");
      await deps.ai.saveProposal(frozen.proposal, { expectedRevision: stored.revision });
      if (current(id)) setProposal(frozen.proposal);
      return current(id);
    } catch (error) {
      if (current(id)) setMessage(String(error));
      return false;
    } finally {
      if (current(id)) lock.current = false;
    }
  }
  async function dismiss() {
    if (!proposal || lock.current || proposal.status === "accepting") return;
    lock.current = true;
    const id = epoch.current;
    try {
      const stored = await deps.ai.getProposal(proposal.id);
      if (!current(id) || !stored) return;
      const rejected =
        stored.status === "draft" ? rejectProposal(stored) : withdrawAcceptedProposal(stored);
      if (rejected.status !== "rejected") throw Error("建议状态不允许撤回。");
      await deps.ai.saveProposal(rejected, { expectedRevision: stored.revision });
      const task = await deps.ai.getTask(stored.taskId);
      if (task?.status === "waiting_user") {
        const done = transitionAiTask(task, "cancelled");
        if (done.ok) await deps.ai.saveTask(done.task, { expectedRevision: task.revision });
      }
      if (current(id)) {
        setProposal(rejected);
        setPending((p) => p.filter((x) => x.id !== rejected.id));
        setMessage("已拒绝，原记录与笔记本未改变。");
      }
    } catch (error) {
      if (current(id)) setMessage(String(error));
    } finally {
      lock.current = false;
    }
  }
  async function apply() {
    if (!proposal || lock.current) return;
    lock.current = true;
    const id = epoch.current;
    setBusy("applying");
    try {
      let stored = await deps.ai.getProposal(proposal.id);
      if (!current(id)) return;
      if (!stored) throw Error("建议不存在。");
      if (stored.status === "draft") {
        const accepted = acceptProposal(stored);
        if (!accepted.ok) throw Error("预览身份已变化。");
        await deps.ai.saveProposal(accepted.proposal, { expectedRevision: stored.revision });
        stored = accepted.proposal;
      }
      if (!current(id)) return;
      const result = await applyOrganizeCapturesProposal(deps, stored.id);
      // Refresh shared archive even after navigation; only this view's notices are epoch-scoped.
      let refreshFailed = false;
      if (result.status === "applied") {
        try {
          await latest.current.onSaved();
        } catch {
          refreshFailed = true;
        }
      }
      if (!current(id)) return;
      setMessage(result.message);
      setDuplicates(result.duplicateMessageIds ?? []);
      const updated = await deps.ai.getProposal(stored.id);
      if (!current(id)) return;
      setProposal(updated);
      if (result.status === "applied") {
        try {
          await latest.current.onArchive(result.includedMessageIds ?? []);
          if (refreshFailed) throw Error("refresh failed");
        } catch {
          if (current(id))
            setMessage(
              "笔记本已保存，但界面刷新或记录状态更新失败；请刷新核对，不要重新生成来补写。"
            );
        }
        if (current(id) && !result.aiStatePending)
          setPending((p) => p.filter((x) => x.id !== stored!.id));
      }
    } catch (error) {
      if (current(id)) setMessage(String(error));
    } finally {
      if (current(id)) {
        setBusy(null);
        lock.current = false;
      }
    }
  }
  async function chooseDuplicates(policy: "skip" | "append-duplicate") {
    if (!proposal || lock.current) return;
    lock.current = true;
    const id = epoch.current;
    try {
      const stored = await deps.ai.getProposal(proposal.id);
      if (
        !current(id) ||
        !stored ||
        stored.status !== "accepted" ||
        stored.payload.kind !== "organize_captures"
      )
        return;
      const task = await deps.ai.getTask(stored.taskId);
      if (
        !current(id) ||
        !task ||
        task.type !== "organize_captures" ||
        task.status !== "waiting_user"
      )
        return;
      const payload = structuredClone(stored.payload);
      if (policy === "skip") {
        payload.includedMessageIds = payload.includedMessageIds.filter(
          (key) => !duplicates.includes(key)
        );
        let include = false;
        payload.draft.entries = payload.draft.entries.filter((entry) => {
          if (entry.kind === "message")
            include = payload.includedMessageIds.includes(entry.messageId);
          return include;
        });
        delete payload.duplicatePolicy;
        if (!payload.includedMessageIds.length) {
          setMessage("所有来源都已加入；未重复写入。可拒绝当前建议。");
          return;
        }
      } else payload.duplicatePolicy = "append-duplicate";
      const stamp = new Date().toISOString();
      const nextTask: OrganizeCapturesAiTask = {
        ...task,
        id: crypto.randomUUID(),
        status: "queued",
        revision: 0,
        proposalId: undefined,
        createdAt: stamp,
        updatedAt: stamp
      };
      const nextProposal = previewProposal({
        ...stored,
        id: crypto.randomUUID(),
        taskId: nextTask.id,
        payload,
        status: "draft",
        revision: 0,
        payloadDigest: undefined,
        previewedAt: undefined,
        createdAt: stamp,
        updatedAt: stamp
      });
      if (!nextProposal.ok) throw Error("重复策略预览不合法。");
      // Retire the old authorization before creating a newly frozen review; no model request.
      await deps.ai.saveProposal(withdrawAcceptedProposal(stored), {
        expectedRevision: stored.revision
      });
      const cancelled = transitionAiTask(task, "cancelled");
      if (cancelled.ok) await deps.ai.saveTask(cancelled.task, { expectedRevision: task.revision });
      if (!current(id)) return;
      await deps.ai.saveTask(nextTask);
      const running = transitionAiTask(nextTask, "running");
      if (!running.ok) throw Error("任务状态不允许转换。");
      await deps.ai.saveTask(running.task, { expectedRevision: 0 });
      const waiting = transitionAiTask(running.task, "waiting_user", {
        proposalId: nextProposal.proposal.id
      });
      if (!waiting.ok) throw Error("任务状态不允许转换。");
      await deps.ai.saveTaskWithProposal({
        task: waiting.task,
        proposal: nextProposal.proposal,
        expectedRevision: running.task.revision
      });
      if (current(id)) {
        setProposal(nextProposal.proposal);
        setDuplicates([]);
        setPending((items) => items.filter((p) => p.id !== stored.id));
        setMessage("已按重复策略生成新预览，请再次核对并接受；未发送模型请求。");
      }
    } catch (error) {
      if (current(id)) setMessage(`重复策略处理失败：${String(error)}。请刷新核对。`);
    } finally {
      if (current(id)) lock.current = false;
    }
  }
  function resume(p: AiProposal) {
    if (lock.current) return;
    epoch.current++;
    setProposal(p);
    setMessage("已恢复预览；不会自动发送或提交。");
  }
  return {
    proposal,
    pending,
    busy,
    message,
    duplicates,
    chooseDuplicates,
    generate,
    cancel,
    edit,
    dismiss,
    apply,
    resume
  };
}
