"use client";

import { useDismissableLayer } from "@/lib/dismissable-layer";
import { apiFetch } from "@/lib/api-client";
/**
 * 设置 → Skill 管理：查看**真实**信息与来源、打开文件夹、启用/停用、从本应用移除与恢复。
 *
 * 边界：
 * - 只有用户开关会被保存；可用性由服务端按能力/依赖/资源健康派生，启用不等于可运行；
 * - 移到垃圾箱记录 removed 并保留文件；单项 / 批量彻底删除需另行确认，清除整个 Skill 目录；
 * - 成功一律以服务端回读为准；单项操作期间禁止重复提交；冲突明确要求重新读取。
 * - 打开文件夹只报告「已请求打开」，不声称验证了文件管理器窗口；非本机/不支持时给复制路径。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Copy, FolderOpen, Info, RotateCcw, Trash2 } from "lucide-react";
import {
  SKILL_STATE_LABEL,
  SKILL_REMARK_MAX_LENGTH,
  SKILL_DELETE_MAX_ITEMS,
  parseSkillSettingsView,
  type ManagedSkillView,
  type SkillSettingsView,
  type SkillState
} from "@/features/ai/skill-settings-contract";
import { SKILL_CATALOG_CHANGED_EVENT } from "@/features/ai/skill-knowledge";
import { SkillInstaller } from "./skill-installer";
import { NotebookDialog } from "@/features/notebook/notebook-dialog";

const SKILLS_PATH = "/api/ai/settings/skills";
const OPEN_FOLDER_PATH = "/api/ai/settings/skills/open-folder";

const KIND_LABEL: Record<ManagedSkillView["kind"], string> = {
  resource: "随应用附带的文件资源"
};
const sourceLabel = (skill: ManagedSkillView) => skill.source === "installed" ? "用户安装的知识资源" : skill.source === "bundled" && !skill.verification ? "本地文件知识资源" : KIND_LABEL[skill.kind];

const VERIFICATION_LABEL: Record<NonNullable<ManagedSkillView["verification"]>["status"], string> = {
  ok: "校验通过",
  changed: "文件已被改动，加载器拒绝运行",
  missing: "资源文件缺失"
};

async function readView(): Promise<SkillSettingsView> {
  const response = await apiFetch(SKILLS_PATH, { cache: "no-store" });
  const data: unknown = await response.json().catch(() => undefined);
  const parsed = parseSkillSettingsView(data);
  if (!response.ok || !parsed) throw new Error((data as { detail?: string } | undefined)?.detail ?? "无法读取 Skill 设置。");
  return parsed;
}

export function SkillSettings() {
  const [section, setSection] = useState<"installed" | "explore" | "add">("installed");
  const [installing, setInstalling] = useState(false);
  const [view, setView] = useState<SkillSettingsView>();
  const [busy, setBusy] = useState(true);
  /** 单项操作进行中：该条目的按钮全部禁用，避免重复提交。 */
  const [pending, setPending] = useState<string>();
  const [message, setMessage] = useState("");
  const [expanded, setExpanded] = useState<string>();
  const [confirmRemove, setConfirmRemove] = useState<string>();
  const removeConfirmRef = useRef<HTMLDivElement>(null);
  useDismissableLayer(removeConfirmRef, Boolean(confirmRemove), () => setConfirmRemove(undefined));
  const [removedOpen, setRemovedOpen] = useState(false);
  const [selectedTrash, setSelectedTrash] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<ManagedSkillView[]>([]);
  const [deleteFailures, setDeleteFailures] = useState<{ id: string; detail: string }[]>([]);
  const [openedPath, setOpenedPath] = useState<string>();

  /** 读取：初始 busy 由 state 给出；手动「重新读取」在点击处置忙。 */
  const load = useCallback(async () => {
    try {
      const next = await readView();
      setView(next);
      setSelectedTrash([]);
      setDeleteFailures([]);
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "无法读取 Skill 设置。");
    } finally {
      setBusy(false);
    }
  }, []);

  // 首次读取：在 promise 回调里落地状态（不在 effect 主体同步 setState）。
  useEffect(() => {
    let active = true;
    readView()
      .then(next => { if (active) { setView(next); setMessage(""); } })
      .catch((error: unknown) => { if (active) setMessage(error instanceof Error ? error.message : "无法读取 Skill 设置。"); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, []);

  async function updateSkill(skill: ManagedSkillView, change: { state: SkillState } | { remark: string }): Promise<boolean> {
    if (pending || !view?.revision) return false;
    setPending(skill.id);
    setMessage("");
    setConfirmRemove(undefined);
    try {
      const response = await apiFetch(SKILLS_PATH, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revision: view.revision, id: skill.id, ...change })
      });
      const data: unknown = await response.json().catch(() => undefined);
      const parsed = parseSkillSettingsView(data);
      if (!response.ok || !parsed)
        throw new Error((data as { detail?: string } | undefined)?.detail ?? "保存结果未确认，请重新读取。");
      // 以服务端回读为准；「已保存、列表暂不可读」时如实转述服务端原因，不显示成功文案。
      setView(parsed);
      setSelectedTrash(current => current.filter(id => id !== skill.id));
      if ("state" in change && change.state === "removed") setRemovedOpen(true);
      window.dispatchEvent(new Event(SKILL_CATALOG_CHANGED_EVENT));
      setMessage(parsed.detail ?? ("state" in change ? `${skill.label}：${SKILL_STATE_LABEL[change.state]}（已保存）。` : `${skill.label}：备注已保存。`));
      return !parsed.detail;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存失败，请重试。");
      return false;
    } finally {
      setPending(undefined);
    }
  }

  async function openFolder(skill: ManagedSkillView) {
    if (pending) return;
    setPending(skill.id);
    setMessage("");
    try {
      const response = await apiFetch(OPEN_FOLDER_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: skill.id })
      });
      const data = await response.json().catch(() => undefined) as { detail?: string; sourceDir?: string } | undefined;
      if (!response.ok || !data) throw new Error(data?.detail ?? "请在运行应用的电脑上打开此目录。");
      setOpenedPath(data.sourceDir ?? skill.sourceDir);
      setMessage(data.detail ?? "已请求打开文件夹。");
    } catch (error) {
      // 打开失败：给出可复制的来源目录（相对路径），不返回虚假成功。
      setOpenedPath(skill.sourceDir);
      setMessage(error instanceof Error ? error.message : "请在运行应用的电脑上打开此目录。");
    } finally {
      setPending(undefined);
    }
  }

  async function copyPath() {
    if (!openedPath) return;
    try {
      await navigator.clipboard?.writeText(openedPath);
      setMessage("来源目录已复制。");
    } catch {
      setMessage(`来源目录：${openedPath}`);
    }
  }

  const skills = view?.skills ?? [];
  const active = skills.filter(skill => skill.state !== "removed");
  const removed = skills.filter(skill => skill.state === "removed");
  const selected = removed.filter(skill => selectedTrash.includes(skill.id));
  const trashLocked = !!pending || !view?.writable || !view.revision || busy || installing;
  const selectable = removed.slice(0, SKILL_DELETE_MAX_ITEMS);
  const cancelDelete = useCallback(() => { if (!pending) setConfirmDelete([]); }, [pending]);

  async function permanentlyDelete() {
    if (trashLocked || !confirmDelete.length || !view?.revision) return;
    const targets = confirmDelete;
    setPending("trash-delete");
    setMessage("");
    setDeleteFailures([]);
    try {
      const response = await apiFetch(SKILLS_PATH, {
        method: "DELETE", headers: { "content-type": "application/json" },
        body: JSON.stringify({ revision: view.revision, ids: targets.map(skill => skill.id), confirmed: true })
      });
      const data: unknown = await response.json().catch(() => undefined);
      const parsed = parseSkillSettingsView(data);
      if (!response.ok || !parsed?.deletion)
        throw new Error((data as { detail?: string } | undefined)?.detail ?? "删除结果未确认，请重新读取垃圾箱后核对。");
      setView(parsed);
      setDeleteFailures(parsed.deletion.failed);
      setSelectedTrash(parsed.deletion.failed.map(item => item.id));
      window.dispatchEvent(new Event(SKILL_CATALOG_CHANGED_EVENT));
      const failures = parsed.deletion.failed.map(item => `${targets.find(skill => skill.id === item.id)?.label ?? item.id}：${item.detail}`).join("；");
      setMessage([
        parsed.deletion.deleted.length ? `已彻底删除 ${parsed.deletion.deleted.length} 个 Skill。` : "没有 Skill 被彻底删除。",
        failures, parsed.detail
      ].filter(Boolean).join(" "));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "删除结果未确认，请重新读取后核对。");
    } finally {
      setPending(undefined);
      setConfirmDelete([]);
    }
  }

  function installed(next: SkillSettingsView | undefined, notice: string) {
    setMessage(notice);
    setSection(current => current === "add" ? "installed" : current);
    window.dispatchEvent(new Event(SKILL_CATALOG_CHANGED_EVENT));
    if (next) setView(next);
    else {
      setBusy(true);
      readView().then(fresh => setView(fresh)).catch(() => setMessage("已安装；列表暂时无法读取，请重新读取。")).finally(() => setBusy(false));
    }
  }

  return <section className="settings-block settings-skills" aria-labelledby="skills-heading">
    <h2 id="skills-heading">Skill 管理</h2>
    <nav className="skill-center-tabs" aria-label="技能中心">
      {([{ id: "installed", label: "已安装" }, { id: "add", label: "添加技能" }, { id: "explore", label: "探索技能" }] as const).map(item => <button type="button" key={item.id} aria-pressed={section === item.id} disabled={item.id === "explore" || installing || !!pending} title={item.id === "explore" ? "探索技能尚未开放" : undefined} onClick={() => setSection(item.id)}>{item.label}</button>)}
    </nav>
    {busy && !view ? <p role="status">正在读取 Skill 信息…</p> : null}
    {/*
      * 复审七：写后回读失败（detail 在场）时显示服务端原因，不冒充
      * 「没有已登记的 Skill」/「服务不允许修改」——写入已因 revision 为空被禁用。
      */}
    {view?.detail ? <p role="status">{view.detail}</p> : null}
    {view && !view.detail && !view.writable ? <p role="status">当前服务不允许在本机修改设置，只能查看。</p> : null}
    {section === "installed" && view && !view.detail && skills.length === 0 ? <p role="status">没有已登记的 Skill。</p> : null}

    <div className="skill-installed-panel" hidden={section !== "installed"}>
    <ul className="settings-skill-list" aria-label="已登记 Skill">
      {active.map(skill => {
        const isOpen = expanded === skill.id;
        const disabled = !!pending || !view?.writable || busy || installing;
        return <li key={skill.id} className="settings-skill-item" data-state={skill.state} data-available={String(skill.available)}>
          <div className="settings-skill-head">
            <button type="button" className="settings-skill-summary" aria-expanded={isOpen}
              aria-controls={`skill-detail-${skill.id}`}
              onClick={() => setExpanded(current => current === skill.id ? undefined : skill.id)}>
              <span className="settings-skill-name">{skill.label}</span>
              {skill.remark ? <span className="settings-skill-remark">备注：{skill.remark}</span> : null}
              {!skill.available ? (
                <span className="settings-skill-available">当前不可运行：{skill.reason ?? "依赖或资源不可用"}</span>
              ) : null}
              <ChevronDown size={16} aria-hidden className={isOpen ? "is-open" : undefined} />
            </button>
            <span className="settings-skill-toggle">
              <span className="settings-switch-label" aria-hidden>{skill.state === "enabled" ? "已启用" : "已停用"}</span>
              <button type="button" role="switch" className="settings-switch"
                aria-checked={skill.state === "enabled"}
                aria-label={`${skill.label}：${skill.state === "enabled" ? "已启用" : "已停用"}；切换启用状态`}
                title={skill.state === "enabled" ? `停用 ${skill.label}` : `启用 ${skill.label}`}
                disabled={disabled}
                onClick={() => void updateSkill(skill, { state: skill.state === "enabled" ? "disabled" : "enabled" })}>
                <span className="settings-switch-knob" aria-hidden />
              </button>
            </span>
          </div>
          {skill.summary ? <p className="settings-skill-summary-text">{skill.summary}</p> : null}
          {/*
            操作行保留有名称的图标按钮；滑动开关位于标题旁，随条目状态回读。
            开关用原生 button + role="switch" + aria-checked：键盘可达、状态可播报，
            且状态只来自服务端回读，不依赖动画结束事件。
          */}
          <div className="settings-skill-actions">
            <button type="button" className="settings-skill-icon" aria-label={`查看 ${skill.label} 详情`} aria-expanded={isOpen}
              aria-controls={`skill-detail-${skill.id}`} title="详情" disabled={busy}
              onClick={() => setExpanded(current => current === skill.id ? undefined : skill.id)}>
              <Info size={16} aria-hidden />
            </button>
            <button type="button" className="secondary-button" disabled={disabled}
              aria-label={`${skill.remark ? "修改" : "添加"} ${skill.label} 备注`}
              onClick={() => setExpanded(skill.id)}>{skill.remark ? "修改备注" : "添加备注"}</button>
            <button type="button" className="settings-skill-icon" aria-label={`打开 ${skill.label} 的来源文件夹`}
              title="打开文件夹" disabled={disabled} onClick={() => void openFolder(skill)}>
              <FolderOpen size={16} aria-hidden />
            </button>
            <button type="button" className="settings-skill-icon" data-tone="danger" aria-label={`从本应用移除 ${skill.label}`}
              title="从本应用移除" disabled={disabled}
              onClick={() => setConfirmRemove(current => current === skill.id ? undefined : skill.id)}>
              <Trash2 size={16} aria-hidden />
            </button>

          </div>
          {confirmRemove === skill.id ? (
            <div ref={removeConfirmRef} className="settings-skill-confirm" role="alertdialog" aria-label={`确认移除 ${skill.label}`}>
              <p>将「{skill.label}」移到垃圾箱？文件会保留。</p>
              <div className="settings-skill-actions">
                <button type="button" className="secondary-button" disabled={disabled} onClick={() => void updateSkill(skill, { state: "removed" })}>确认移除</button>
                <button type="button" className="secondary-button" disabled={disabled} onClick={() => setConfirmRemove(undefined)}>取消</button>
              </div>
            </div>
          ) : null}
          {isOpen ? <div className="settings-skill-detail" id={`skill-detail-${skill.id}`}>
            <SkillRemarkEditor key={`${skill.id}:${skill.remark ?? ""}`} skill={skill} disabled={disabled} onSave={remark => updateSkill(skill, { remark })} />
            <dl>
              <div><dt>ID</dt><dd><code>{skill.id}</code></dd></div>
              <div><dt>来源</dt><dd>{sourceLabel(skill)}</dd></div>
              {skill.version ? <div><dt>版本</dt><dd>{skill.version}</dd></div> : null}
              <div><dt>所需能力</dt><dd>{skill.requires.join("、")}</dd></div>
              <div><dt>依赖/使用者</dt><dd>{skill.usedBy.join("、")}</dd></div>
              <div><dt>允许的工具/对应任务</dt><dd>{skill.tools.join("、")}</dd></div>
              <div><dt>来源目录</dt><dd className="settings-skill-path"><code>{skill.sourceDir}</code>{skill.directoryExists ? "" : "（当前不存在）"}</dd></div>
              <div><dt>相关文件</dt><dd className="settings-skill-path">{skill.promptFiles.map(file => <code key={file}>{file}</code>)}</dd></div>
              {skill.verification ? <div><dt>资源校验</dt><dd>{VERIFICATION_LABEL[skill.verification.status]}（适配版本 {skill.verification.adapterVersion}{skill.verification.digest ? `，摘要 ${skill.verification.digest.slice(0, 12)}…` : ""}）</dd></div> : null}
            </dl>
          </div> : null}
        </li>;
      })}
    </ul>

    {removed.length > 0 ? <details className="settings-skill-removed" open={removedOpen} onToggle={event => setRemovedOpen((event.target as HTMLDetailsElement).open)}>
      <summary>垃圾箱（{removed.length}）</summary>
      <div className="settings-skill-trash-toolbar">
        <label className="settings-skill-trash-check">
          <input type="checkbox" aria-label={removed.length > SKILL_DELETE_MAX_ITEMS ? "选择前 100 个 Skill" : "全选垃圾箱 Skill"}
            checked={selectable.length > 0 && selectable.every(skill => selectedTrash.includes(skill.id))} disabled={trashLocked}
            onChange={event => setSelectedTrash(event.target.checked ? selectable.map(skill => skill.id) : [])} />
          {removed.length > SKILL_DELETE_MAX_ITEMS ? "选择前 100 项" : "全选"}
        </label>
        <button type="button" className="secondary-button settings-skill-purge" disabled={trashLocked || !selected.length}
          aria-label="删除所选 Skill" title={selected.length ? `删除所选 ${selected.length} 个 Skill` : "请选择 Skill"}
          onClick={() => setConfirmDelete(selected)}>删除</button>
      </div>
      <ul className="settings-skill-list" aria-label="垃圾箱中的 Skill">
        {removed.map(skill => <li key={skill.id} className="settings-skill-trash-item" data-state="removed">
          <label className="settings-skill-trash-check">
            <input type="checkbox" aria-label={`选择 ${skill.label}`} checked={selectedTrash.includes(skill.id)}
              disabled={trashLocked || (selected.length >= SKILL_DELETE_MAX_ITEMS && !selectedTrash.includes(skill.id))}
              onChange={event => setSelectedTrash(current => event.target.checked ? [...current, skill.id] : current.filter(id => id !== skill.id))} />
            <span className="settings-skill-trash-name" title={skill.remark ? `${skill.label}（${skill.remark}）` : skill.label}>
              {skill.label}{skill.remark ? `（${skill.remark}）` : ""}
            </span>
          </label>
          <div className="settings-skill-trash-actions">
            <button type="button" className="settings-skill-icon" aria-label={`恢复 ${skill.label}`} title={skill.directoryExists ? "恢复" : "目录不存在，无法恢复"}
              disabled={trashLocked || !skill.directoryExists}
              onClick={() => void updateSkill(skill, { state: "disabled" })}>
              <RotateCcw size={16} aria-hidden />
            </button>
            <button type="button" className="settings-skill-icon" data-tone="danger" aria-label={`彻底删除 ${skill.label}`}
              title="删除" disabled={trashLocked} onClick={() => setConfirmDelete([skill])}>
              <Trash2 size={16} aria-hidden />
            </button>
          </div>
          {deleteFailures.find(item => item.id === skill.id)?.detail ? <p className="settings-block-note settings-skill-trash-error" role="alert">{deleteFailures.find(item => item.id === skill.id)!.detail}</p> : null}
        </li>)}
      </ul>
    </details> : null}

    {openedPath ? <p className="settings-skill-opened"><code>{openedPath}</code>
      <button type="button" className="secondary-button" aria-label="复制来源目录" onClick={() => void copyPath()}>
        <Copy size={15} aria-hidden /> 复制路径
      </button>
    </p> : null}
    </div>
    <NotebookDialog open={confirmDelete.length > 0} title={confirmDelete.length === 1 ? `彻底删除「${confirmDelete[0].label}」？` : `彻底删除 ${confirmDelete.length} 个 Skill？`}
      tone="permanent" confirmLabel={pending === "trash-delete" ? "正在删除…" : "彻底删除"} busy={!!pending}
      onCancel={cancelDelete} onConfirm={() => void permanentlyDelete()}>
      <p>以下 Skill 的整个目录及其中全部文件将被彻底删除，无法恢复。</p>
      <ul className="settings-skill-delete-list">
        {confirmDelete.map(skill => <li key={skill.id}><strong>{skill.label}</strong><code>{skill.sourceDir}</code>
          {!skill.directoryExists ? <span>目录未被发现，将清理残留设置。</span> : null}</li>)}
      </ul>
    </NotebookDialog>
    <SkillInstaller mode={section} view={view} locked={busy || !!pending} onBusyChange={setInstalling} onInstalled={installed} onManage={() => setSection("installed")} />
    {message ? <p role="status">{message}</p> : null}
    <div className="capture-actions">
      <button type="button" className="secondary-button" disabled={busy || installing || !!pending}
        onClick={() => { setBusy(true); setMessage(""); void load(); }}>
        {busy ? "正在读取或保存…" : "重新读取"}
      </button>
    </div>
  </section>;
}

function SkillRemarkEditor({ skill, disabled, onSave }: {
  skill: ManagedSkillView;
  disabled: boolean;
  onSave: (remark: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(skill.remark ?? "");
  return <form className="skill-remark-form" onSubmit={event => {
    event.preventDefault();
    if (!disabled && draft.trim() !== (skill.remark ?? "")) void onSave(draft);
  }}>
    <div className="skill-field">
      <label htmlFor={`skill-remark-${skill.id}`}>备注名</label>
      <input id={`skill-remark-${skill.id}`} type="text" value={draft} maxLength={SKILL_REMARK_MAX_LENGTH} disabled={disabled}
        placeholder="可选，留空使用原名"
        onChange={event => setDraft(event.target.value)} />
    </div>
    <button type="submit" className="secondary-button" disabled={disabled || draft.trim() === (skill.remark ?? "")}>保存备注</button>
  </form>;
}
