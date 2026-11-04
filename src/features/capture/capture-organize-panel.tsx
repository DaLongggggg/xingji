"use client";
import { useState } from "react";
import type { ArchiveCore } from "../notebook/notebook-repository";
import type { CaptureOrganizeTarget } from "../ai/ai-task";
import { listAppendTargets } from "./capture-assignment";
import { useCaptureOrganize } from "./use-capture-organize";

export function CaptureOrganizePanel({
  selected,
  active,
  archive,
  onSaved,
  onArchive
}: {
  selected: string[];
  active: boolean;
  archive: ArchiveCore;
  onSaved: () => Promise<void>;
  onArchive: (ids: string[]) => Promise<void>;
}) {
  const ai = useCaptureOrganize({ active, onSaved, onArchive });
  const [open, setOpen] = useState(false);
  const [consent, setConsent] = useState(false);
  const [targetKey, setTargetKey] = useState("");
  const [title, setTitle] = useState("整理后的旅行记录");
  const [editing, setEditing] = useState<{ index: number; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const targets = listAppendTargets(archive).filter(
    (t) => t.editable && !archive.pages.find((p) => p.id === t.pageId)?.deletedAt
  );

  /**
   * 选中集合变化后，之前勾的「同意发送」不再覆盖新的素材，必须重新征询。
   *
   * 以前这条语义是靠父层的 `key={JSON.stringify(selected)}` 重挂载实现的，
   * 但重挂载会连带卸载 hook：正在进行的生成被静默 abort、已恢复的待处理建议
   * 也从视图里消失。现在改为在这里只重置与授权有关的本地状态，面板保持挂载。
   * 注意：**不能**顺带清掉派生的 preview —— 待处理建议是刷新后唯一找回路径。
   */
  const selectionKey = selected.join(",");
  const [prevSelectionKey, setPrevSelectionKey] = useState(selectionKey);
  if (prevSelectionKey !== selectionKey) {
    // React 官方推荐的「props 变化时在渲染期调整 state」，避免 effect 内同步 setState 造成级联渲染。
    setPrevSelectionKey(selectionKey);
    setConsent(false);
    setEditing(null);
  }
  const p = ai.proposal;
  const payload = p?.payload.kind === "organize_captures" ? p.payload : null;
  const generating = ai.busy === "generating";
  const applying = ai.busy === "applying";
  function generate() {
    if (!consent || !targetKey) return;
    const target: CaptureOrganizeTarget = targetKey.startsWith("page:")
      ? { kind: "append", pageId: targetKey.slice(5) }
      : { kind: "new", notebookId: targetKey.slice(5), title: title.trim() };
    setEditing(null);
    void ai.generate(selected, target);
  }
  return (
    <section className="capture-ai-panel" aria-label="记录 AI 整理">
      <button
        className="secondary-button"
        disabled={!!ai.busy || !selected.length}
        onClick={() => setOpen((v) => !v)}
      >
        AI 整理选中记录（{selected.length}）
      </button>
      {open && (
        <fieldset disabled={!!ai.busy}>
          <legend>整理目标与外发告知</legend>
          <label>
            加入位置
            <select
              aria-label="AI 整理目标"
              value={targetKey}
              onChange={(e) => setTargetKey(e.target.value)}
            >
              <option value="">选择目标</option>
              {archive.notebooks
                .filter((b) => !b.deletedAt && !b.archivedAt)
                .map((b) => (
                  <option key={b.id} value={`book:${b.id}`}>
                    新建篇 · {b.title}
                  </option>
                ))}
              {targets.map((t) => (
                <option key={t.pageId} value={`page:${t.pageId}`}>
                  追加 · {t.notebookTitle} / {t.pageTitle}
                </option>
              ))}
            </select>
          </label>
          {targetKey.startsWith("book:") && (
            <label>
              新篇标题
              <input
                aria-label="AI 新篇标题"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
          )}
          <p>
            将所选 {selected.length}{" "}
            条记录的完整文字、顺序编号和图片数量发送至服务端配置的模型，连同固定整理提示及结果格式。图片二进制、图注、其他记录和目标篇正文不发送。原记录保留；只在接受后新建或追加正文。
          </p>
          <label>
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />
            我同意发送本次选中记录
          </label>
          <button
            className="primary-button"
            disabled={
              !consent ||
              !targetKey ||
              !selected.length ||
              (targetKey.startsWith("book:") && !title.trim())
            }
            onClick={generate}
          >
            生成整理预览
          </button>
        </fieldset>
      )}
      {generating && (
        <button className="secondary-button" onClick={ai.cancel}>
          取消生成
        </button>
      )}
      {ai.message && <p aria-live="polite">{ai.message}</p>}
      {ai.duplicates.length > 0 && (
        <div role="group" aria-label="重复来源确认">
          <p>{ai.duplicates.length} 条来源已加入目标篇。</p>
          <button disabled={!!ai.busy} onClick={() => void ai.chooseDuplicates("skip")}>
            跳过已加入记录并重新预览
          </button>
          <button disabled={!!ai.busy} onClick={() => void ai.chooseDuplicates("append-duplicate")}>
            仍重复追加并重新预览
          </button>
        </div>
      )}
      {ai.pending.length > 0 && (
        <details>
          <summary>待处理的整理建议（{ai.pending.length}）</summary>
          {ai.pending.map((item) => (
            <button
              key={item.id}
              className="secondary-button"
              disabled={!!ai.busy}
              onClick={() => {
                setEditing(null);
                ai.resume(item);
              }}
            >
              {item.createdAt} · 恢复预览
            </button>
          ))}
        </details>
      )}
      {payload && p && (
        <section aria-label="AI 整理预览" aria-busy={applying}>
          <h3>整理预览</h3>
          {payload.duplicatePolicy && <p>本次已明确选择允许重复追加。</p>}
          <p>
            目标：
            {payload.target.kind === "new"
              ? `新建篇：${payload.target.title}`
              : (targets.find(
                  (t) =>
                    t.pageId === (payload.target.kind === "append" ? payload.target.pageId : "")
                )?.pageTitle ?? "原目标篇")}
          </p>
          <p>
            纳入 {payload.includedMessageIds.length} 条；跳过{" "}
            {payload.sources.length - payload.includedMessageIds.length} 条（文字和图片均不加入）。
          </p>
          {payload.sources
            .filter((s) => !payload.includedMessageIds.includes(s.messageId))
            .map((s) => (
              <p key={s.messageId}>未纳入：{s.text || "仅图片记录"}</p>
            ))}
          {payload.draft.entries.map((entry, index) =>
            entry.kind === "message" ? (
              <div key={index}>
                <p>原文：{payload.sources.find((s) => s.messageId === entry.messageId)?.text}</p>
                {editing?.index === index ? (
                  <>
                    <textarea
                      aria-label="编辑整理正文"
                      value={editing.text}
                      onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                    />
                    <button
                      disabled={saving}
                      onClick={async () => {
                        setSaving(true);
                        const saved = await ai.edit(index, editing.text);
                        setSaving(false);
                        if (saved) setEditing(null);
                      }}
                    >
                      保存预览修改
                    </button>
                  </>
                ) : (
                  <p style={{ whiteSpace: "pre-wrap" }}>
                    整理后：{entry.blocks.map((b) => b.text).join("\n")}
                  </p>
                )}
                {p.status === "draft" && !editing && (
                  <button
                    disabled={applying}
                    onClick={() =>
                      setEditing({ index, text: entry.blocks.map((b) => b.text).join("\n") })
                    }
                  >
                    编辑这段
                  </button>
                )}
              </div>
            ) : (
              <p key={index}>图片保留：{entry.caption || "图片"}</p>
            )
          )}
          {["draft", "accepted", "accepting", "applied"].includes(p.status) && (
            <button
              className="primary-button"
              disabled={!!ai.busy || !!editing || saving}
              onClick={() => void ai.apply()}
            >
              {p.status === "draft" ? "接受并加入笔记" : "继续提交 / 同步状态"}
            </button>
          )}
          {["draft", "accepted"].includes(p.status) && (
            <button
              className="secondary-button"
              disabled={!!ai.busy || saving}
              onClick={() => void ai.dismiss()}
            >
              拒绝建议
            </button>
          )}
          {p.status === "applied" && <p>已应用（只读）</p>}
          {p.status === "rejected" && <p>已拒绝</p>}
        </section>
      )}
    </section>
  );
}
