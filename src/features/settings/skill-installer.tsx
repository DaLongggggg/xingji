"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, Search, Upload, FileText } from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import {
  parseSkillSettingsView,
  SKILL_STATE_LABEL,
  type SkillSettingsView
} from "@/features/ai/skill-settings-contract";
import {
  isRecord,
  normalizeSkillPackage,
  parseSkillPreview,
  SKILL_LIMITS,
  type SkillInstallChoice,
  type SkillPreview,
  type SkillPreviewItem
} from "@/features/skills/skill-package";
import {
  parseSkillMarket,
  searchSkillMarket,
  skillMarketListing,
  SKILL_CATEGORIES,
  type SkillCategory,
  type SkillMarketListing
} from "@/features/skills/skill-market";

const BASE = "/api/ai/settings/skills";
type Draft = SkillPreviewItem & { action: SkillInstallChoice["action"] };
type Props = {
  mode: "installed" | "explore" | "add";
  view?: SkillSettingsView;
  locked: boolean;
  onBusyChange: (busy: boolean) => void;
  onInstalled: (view: SkillSettingsView | undefined, message: string) => void;
  onManage: () => void;
};

async function responseData(response: Response): Promise<Record<string, unknown>> {
  const data: unknown = await response.json().catch(() => undefined);
  if (!response.ok || !isRecord(data) || data.ok !== true)
    throw new Error(
      isRecord(data) && typeof data.detail === "string"
        ? data.detail
        : "请求结果未确认，请重新读取后再试。"
    );
  return data;
}

function edited(draft: Draft) {
  try {
    return { package: normalizeSkillPackage(draft.package), error: undefined };
  } catch (error) {
    return { package: undefined, error: error instanceof Error ? error.message : "技能信息无效。" };
  }
}

export function SkillInstaller({ mode, view, locked, onBusyChange, onInstalled, onManage }: Props) {
  const [method, setMethod] = useState<"file" | "url" | "markdown">("file");
  const [file, setFile] = useState<File>();
  const [url, setUrl] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [preview, setPreview] = useState<SkillPreview>();
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [busy, setBusy] = useState<"preview" | "install">();
  const [error, setError] = useState("");
  const [market, setMarket] = useState<SkillMarketListing[]>();
  const [marketLoading, setMarketLoading] = useState(false);
  const [marketError, setMarketError] = useState("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<SkillCategory | "all">("all");
  const mounted = useRef(true);
  const operation = useRef<AbortController | null>(null);
  const marketOperation = useRef<AbortController | null>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const previewRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operation.current?.abort();
      marketOperation.current?.abort();
    };
  }, []);

  const loadMarket = useCallback(async () => {
    marketOperation.current?.abort();
    const controller = new AbortController();
    marketOperation.current = controller;
    setMarketLoading(true);
    setMarketError("");
    try {
      const data = await responseData(
        await apiFetch(`${BASE}/market`, { cache: "no-store", signal: controller.signal })
      );
      // Validate the same manifest shape; listing transport intentionally omits bodies.
      if (!Array.isArray(data.skills)) throw new Error("技能市场响应不完整。");
      const checked = parseSkillMarket({
        version: data.version,
        skills: data.skills.map((entry: unknown) =>
          isRecord(entry) ? { ...entry, markdown: "待预览" } : entry
        )
      });
      if (mounted.current && !controller.signal.aborted) setMarket(checked.map(skillMarketListing));
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted)
        setMarketError(failure instanceof Error ? failure.message : "技能市场暂时无法读取。");
    } finally {
      if (mounted.current && !controller.signal.aborted) setMarketLoading(false);
    }
  }, []);
  useEffect(() => {
    if (mode === "explore" && market === undefined && !marketLoading && !marketError)
      void Promise.resolve().then(loadMarket);
  }, [mode, market, marketLoading, marketError, loadMarket]);

  function clearPreview() {
    setPreview(undefined);
    setDrafts([]);
    setError("");
  }
  function showError(failure: unknown) {
    setError(failure instanceof Error ? failure.message : "操作失败，请重试。");
    requestAnimationFrame(() => errorRef.current?.focus());
  }

  async function getPreview(marketId?: string) {
    if (operation.current || locked || !view?.writable) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy("preview");
    onBusyChange(true);
    clearPreview();
    try {
      let init: RequestInit;
      if (marketId)
        init = {
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind: "market", id: marketId })
        };
      else if (method === "file") {
        if (!file) throw new Error("请选择 .md 或 .zip 文件。");
        if (!/\.(?:md|zip)$/i.test(file.name)) throw new Error("请选择 .md 或 .zip 文件。");
        if (
          file.size >
          (/\.zip$/i.test(file.name) ? SKILL_LIMITS.uploadBytes : SKILL_LIMITS.textBytes)
        )
          throw new Error(
            /\.zip$/i.test(file.name)
              ? "ZIP 文件不能超过 4 MiB。"
              : "Markdown 文件不能超过 256 KiB。"
          );
        init = {
          headers: {
            "content-type": "application/octet-stream",
            "x-skill-filename": encodeURIComponent(file.name)
          },
          body: file
        };
      } else
        init = {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            method === "url" ? { kind: "url", url: url.trim() } : { kind: "markdown", markdown }
          )
        };
      const data = await responseData(
        await apiFetch(`${BASE}/preview`, { ...init, method: "POST", signal: controller.signal })
      );
      const next = parseSkillPreview(data);
      if (!mounted.current || controller.signal.aborted) return;
      setPreview(next);
      setDrafts(
        next.items.map((item) => ({
          ...item,
          action: item.conflict || item.duplicates.length ? "skip" : "create"
        }))
      );
      requestAnimationFrame(() => previewRef.current?.focus());
    } catch (failure) {
      if (mounted.current)
        showError(controller.signal.aborted ? new Error("已取消获取，输入内容已保留。") : failure);
    } finally {
      operation.current = null;
      if (mounted.current) {
        setBusy(undefined);
        onBusyChange(false);
      }
    }
  }

  async function install() {
    if (!preview || operation.current || locked || !view?.writable) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy("install");
    onBusyChange(true);
    setError("");
    try {
      const choices: SkillInstallChoice[] = drafts.map((draft) => ({
        package: normalizeSkillPackage(draft.package),
        source: draft.source,
        action: draft.action,
        targetId: draft.action === "copy" ? draft.copyId : draft.package.id,
        expectedFingerprint:
          draft.action === "update" ? (draft.conflict?.fingerprint ?? null) : null
      }));
      const data = await responseData(
        await apiFetch(`${BASE}/install`, {
          method: "POST",
          signal: controller.signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ revision: preview.revision, choices })
        })
      );
      if (
        !Array.isArray(data.results) ||
        !data.results.every(
          (result) =>
            isRecord(result) &&
            typeof result.id === "string" &&
            ["installed", "updated", "skipped"].includes(String(result.action))
        )
      )
        throw new Error("保存结果未确认，请重新读取已安装列表。");
      if (!mounted.current) return;
      const savedView = parseSkillSettingsView(data.view);
      const changed = data.results.filter(
        (result) => isRecord(result) && result.action !== "skipped"
      ).length;
      setPreview(undefined);
      setDrafts([]);
      onInstalled(
        savedView,
        typeof data.detail === "string" ? data.detail : `已保存 ${changed} 个技能。`
      );
    } catch (failure) {
      if (mounted.current) showError(failure);
    } finally {
      operation.current = null;
      if (mounted.current) {
        setBusy(undefined);
        onBusyChange(false);
      }
    }
  }

  const disabled = !!busy || locked || !view?.writable || !view.revision;
  const selected = drafts.filter((draft) => draft.action !== "skip");
  const valid = selected.length > 0 && selected.every((draft) => !!edited(draft).package);
  const listed = market && searchSkillMarket(market, query, category);
  return (
    <div className="skill-installer" hidden={mode === "installed"}>
      {mode === "add" ? (
        <div className="skill-import-form">
          <nav className="skill-methods" aria-label="技能导入方式">
            {(
              [
                { id: "file", label: "上传 MD / ZIP", icon: Upload },
                { id: "url", label: "URL 安装", icon: Link },
                { id: "markdown", label: "粘贴 Markdown", icon: FileText }
              ] as const
            ).map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                aria-pressed={method === id}
                disabled={!!busy}
                onClick={() => {
                  setMethod(id);
                  clearPreview();
                }}
              >
                <Icon size={16} aria-hidden />
                {label}
              </button>
            ))}
          </nav>
          {method === "file" ? (
            <div key="file" className="skill-field">
              <label htmlFor="skill-import-file">选择文件</label>
              <input
                id="skill-import-file"
                type="file"
                accept=".md,.zip"
                disabled={disabled}
                aria-describedby="skill-file-help"
                onChange={(event) => {
                  setFile(event.target.files?.[0]);
                  clearPreview();
                }}
              />
              <small id="skill-file-help">
                MD 最多 256 KiB，ZIP 最多 4 MiB；压缩包可包含多个技能。
              </small>
              {file ? <small>已选择：{file.name}</small> : null}
            </div>
          ) : method === "url" ? (
            <div key="url" className="skill-field">
              <label htmlFor="skill-import-url">技能链接</label>
              <input
                id="skill-import-url"
                type="url"
                placeholder="https://github.com/作者/仓库/tree/main/skills/技能"
                value={url}
                disabled={disabled}
                aria-describedby="skill-url-help"
                onChange={(event) => {
                  setUrl(event.target.value);
                  clearPreview();
                }}
              />
              <small id="skill-url-help">
                支持公开 GitHub 仓库、Skill 子目录、Raw 地址和直接下载的 Markdown。
              </small>
            </div>
          ) : (
            <div key="markdown" className="skill-field">
              <label htmlFor="skill-import-markdown">Markdown 内容</label>
              <textarea
                id="skill-import-markdown"
                rows={9}
                value={markdown}
                disabled={disabled}
                placeholder={"# 我的技能\n\n粘贴提示词或方法说明，名称与描述会自动补全。"}
                aria-describedby="skill-markdown-help"
                onChange={(event) => {
                  setMarkdown(event.target.value);
                  clearPreview();
                }}
              />
              <small id="skill-markdown-help">
                可直接粘贴普通 Markdown，也支持完整 SKILL.md；最多 256 KiB。
              </small>
            </div>
          )}
          <button
            type="button"
            className="secondary-button"
            disabled={disabled}
            onClick={() => void getPreview()}
          >
            获取并预览
          </button>
        </div>
      ) : (
        <div className="skill-market">
          <div className="skill-market-filters">
            <div className="skill-field">
              <label htmlFor="skill-market-search">
                <Search size={16} aria-hidden /> 搜索技能
              </label>
              <input
                id="skill-market-search"
                type="search"
                placeholder="名称、描述或关键词"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <div className="skill-field">
              <label htmlFor="skill-market-category">用途</label>
              <select
                id="skill-market-category"
                value={category}
                onChange={(event) => setCategory(event.target.value as SkillCategory | "all")}
              >
                <option value="all">全部用途</option>
                {Object.entries(SKILL_CATEGORIES).map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {marketLoading ? <p role="status">正在读取技能市场…</p> : null}
          {marketError ? (
            <p role="alert">
              {marketError}{" "}
              <button
                type="button"
                className="secondary-button"
                disabled={marketLoading}
                onClick={() => void loadMarket()}
              >
                重试读取市场
              </button>
            </p>
          ) : null}
          {listed ? (
            <ul className="skill-market-list" aria-label="技能市场">
              {listed.map((entry) => {
                const installed = view?.skills.find((skill) => skill.id === entry.id);
                return (
                  <li key={entry.id} className="settings-skill-item">
                    <div className="skill-market-heading">
                      <h3>{entry.name}</h3>
                      <span className="skill-category">{SKILL_CATEGORIES[entry.category]}</span>
                    </div>
                    <p>{entry.description}</p>
                    <small>
                      {entry.publisher} · {entry.tags.join(" / ")}
                    </small>
                    <div className="settings-skill-actions">
                      {installed ? (
                        <>
                          <span>
                            {SKILL_STATE_LABEL[installed.state] === "已启用"
                              ? "已安装"
                              : SKILL_STATE_LABEL[installed.state]}
                          </span>
                          <button
                            type="button"
                            className="secondary-button"
                            disabled={disabled}
                            onClick={() => void getPreview(entry.id)}
                          >
                            查看 {entry.name} 内容
                          </button>
                          <button
                            type="button"
                            className="secondary-button"
                            disabled={!!busy}
                            onClick={onManage}
                          >
                            管理此技能
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={disabled}
                          onClick={() => void getPreview(entry.id)}
                        >
                          查看并安装 {entry.name}
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {market?.length === 0 && !marketError ? (
            <p role="status">暂未收录技能。可以在“添加技能”中导入自己的 Skill。</p>
          ) : listed?.length === 0 && !marketError ? (
            <p role="status">没有匹配的技能，试试其他关键词或用途。</p>
          ) : null}
        </div>
      )}

      {busy ? (
        <p role="status">
          {busy === "preview" ? "正在获取技能内容…" : "正在安装技能…"}
          {busy === "preview" ? (
            <button
              type="button"
              className="secondary-button"
              onClick={() => operation.current?.abort()}
            >
              取消获取
            </button>
          ) : null}
        </p>
      ) : null}
      {error ? (
        <p className="skill-install-error" role="alert" tabIndex={-1} ref={errorRef}>
          {error}
        </p>
      ) : null}

      {preview ? (
        <section className="skill-preview" aria-labelledby="skill-preview-heading">
          <h3 id="skill-preview-heading" ref={previewRef} tabIndex={-1}>
            安装预览（{drafts.length} 个技能）
          </h3>
          {preview.warnings.length ? (
            <ul className="skill-import-warnings">
              {preview.warnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
          ) : null}
          {drafts.map((draft, index) => {
            const normalized = edited(draft);
            const update = (key: "name" | "description", value: string) =>
              setDrafts((current) =>
                current.map((item, itemIndex) =>
                  itemIndex === index
                    ? { ...item, package: { ...item.package, [key]: value } }
                    : item
                )
              );
            return (
              <article
                className="settings-skill-item skill-preview-item"
                key={index}
                aria-label={`预览 ${draft.package.name}`}
              >
                <p className="skill-preview-source">{draft.source}</p>
                <div className="skill-field">
                  <label htmlFor={`skill-name-${index}`}>技能名称</label>
                  <input
                    id={`skill-name-${index}`}
                    value={draft.package.name}
                    maxLength={SKILL_LIMITS.name}
                    disabled={!!busy}
                    aria-invalid={!!normalized.error}
                    aria-describedby={normalized.error ? `skill-error-${index}` : undefined}
                    onChange={(event) => update("name", event.target.value)}
                  />
                </div>
                <div className="skill-field">
                  <label htmlFor={`skill-description-${index}`}>技能描述</label>
                  <textarea
                    id={`skill-description-${index}`}
                    rows={2}
                    value={draft.package.description}
                    maxLength={SKILL_LIMITS.description}
                    disabled={!!busy}
                    aria-invalid={!!normalized.error}
                    aria-describedby={normalized.error ? `skill-error-${index}` : undefined}
                    onChange={(event) => update("description", event.target.value)}
                  />
                </div>
                {normalized.error ? (
                  <p role="alert" id={`skill-error-${index}`}>
                    {normalized.error}
                  </p>
                ) : null}
                <p className="settings-block-note">
                  安装标识：<code>{draft.action === "copy" ? draft.copyId : draft.package.id}</code>
                </p>
                {draft.conflict ? (
                  <p className="skill-conflict">
                    {draft.conflict.identical ? "相同内容已安装。" : "此标识已存在。"} 当前
                    {SKILL_STATE_LABEL[draft.conflict.state]}。
                    {draft.conflict.canUpdate
                      ? "可跳过、更新原技能或另存副本。更新会保留当前启停状态。"
                      : "原资源受保护，可跳过或另存副本。"}
                  </p>
                ) : draft.duplicates.length ? (
                  <p className="skill-conflict">
                    发现同名或相同内容：
                    {draft.duplicates.map((item) => `${item.name}（${item.id}）`).join("、")}
                    。请选择是否继续安装。
                  </p>
                ) : null}
                <div className="skill-field">
                  <label htmlFor={`skill-action-${index}`}>安装方式</label>
                  <select
                    id={`skill-action-${index}`}
                    value={draft.action}
                    disabled={!!busy}
                    onChange={(event) =>
                      setDrafts((current) =>
                        current.map((item, itemIndex) =>
                          itemIndex === index
                            ? { ...item, action: event.target.value as Draft["action"] }
                            : item
                        )
                      )
                    }
                  >
                    {!draft.conflict ? <option value="create">安装新技能</option> : null}
                    <option value="skip">跳过</option>
                    {draft.conflict?.canUpdate ? <option value="update">更新原技能</option> : null}
                    {draft.conflict ? <option value="copy">另存副本</option> : null}
                  </select>
                </div>
                {draft.action === "update" && !!draft.conflict?.removedFiles?.length ? (
                  <p className="skill-conflict">
                    更新将移除旧附件：{draft.conflict.removedFiles.join("、")}。
                  </p>
                ) : null}
                {(normalized.package?.files ?? draft.package.files).map((item) => (
                  <details
                    className="skill-content-preview"
                    key={item.path}
                    open={item.path === "SKILL.md"}
                  >
                    <summary>{item.path}</summary>
                    <pre>{item.content}</pre>
                  </details>
                ))}
              </article>
            );
          })}
          <div className="settings-skill-actions">
            <button
              type="button"
              className="primary-button"
              disabled={disabled || !valid}
              onClick={() => void install()}
            >
              确认安装{selected.length ? `（${selected.length}）` : ""}
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={!!busy}
              onClick={clearPreview}
            >
              取消预览
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
