"use client";

/**
 * 记忆面板（设置页「记忆」分类与工作台侧栏共用）。
 *
 * - 记忆明确标注「会随请求发送」，关闭后既不读取也不外发；本轮为会话内存，刷新即清空。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ShieldCheck, Trash2, X, RefreshCw, Download, Upload } from "lucide-react";
import {
  createApiMemoryStore,
  createMemoryId,
  exportMemoryJson,
  memoryForRequest,
  planMemoryImport,
  MemoryClientError,
  type MemoryState,
  type MemoryStore
} from "./workbench-memory";

type Props = {
  onClose: () => void;
  embedded?: boolean;
  /** 生产用 API store；注入便于隔离测试。 */
  store?: MemoryStore;
  /** 记忆被改动（含许可/删除/开关）时通知调用方取消在途回合。 */
  onMemoryChanged?: () => void;
};

export function CapabilitiesPanel({ onClose, embedded = false, store, onMemoryChanged }: Props) {
  const [memoryStore] = useState<MemoryStore>(() => store ?? createApiMemoryStore());
  const [state, setState] = useState<MemoryState>({ revision: 0, enabled: false, entries: [] });
  const [memoryError, setMemoryError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string }>();
  /** 用户是否已经改过：初次载入的异步结果不能覆盖更新的输入。 */
  const touched = useRef(false);

  const load = useCallback(
    async (options: { force?: boolean } = {}) => {
      try {
        const next = await memoryStore.load();
        // 用户已经改过时，初次载入的结果不覆盖更新的输入。
        setState(current => (options.force || !touched.current ? next : current));
        setMemoryError(undefined);
      } catch (error) {
        // 初始化失败不能显示为空库：明确报错并保留原状态。
        setMemoryError(error instanceof Error ? error.message : "读取记忆失败。");
      }
    },
    [memoryStore]
  );

  useEffect(() => {
    void load();
  }, [load]);

  /** 提交一批操作：成功以服务端回读为准；失败/冲突保留输入并提示重新读取。 */
  const apply = async (operations: Parameters<MemoryStore["apply"]>[0]): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    try {
      const next = await memoryStore.apply(operations);
      touched.current = true;
      setState(next);
      setMemoryError(undefined);
      onMemoryChanged?.();
      return true;
    } catch (error) {
      const conflict = error instanceof MemoryClientError && (error.code === "MEMORY_CONFLICT" || error.code === "MEMORY_BUSY");
      setMemoryError(
        conflict
          ? "记忆已在别处修改，本次未保存；已重新读取，请比较后再次提交。"
          : error instanceof Error
            ? error.message
            : "保存失败，输入已保留。"
      );
      if (conflict) await load({ force: true });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveEntry = async (text: string, id?: string) => {
    const clean = text.trim();
    if (!clean) return;
    const target = id ? state.entries.find(entry => entry.id === id) : undefined;
    const ok = await apply([
      {
        op: "upsert",
        id: id ?? createMemoryId(),
        kind: "preference",
        text: clean,
        // 新条目默认不外发；编辑保持原许可。
        ...(target ? { allowModelUse: target.allowModelUse } : { allowModelUse: false })
      }
    ]);
    if (ok) {
      setDraft("");
      setEditing(undefined);
    }
  };

  const downloadMemory = () => {
    const blob = new Blob([exportMemoryJson(state)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "xingji-memory.json";
    link.click();
    URL.revokeObjectURL(url);
  };

  const importMemory = async (file: File | undefined) => {
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      const plan = planMemoryImport(state, payload);
      if (plan.operations.length === 0) {
        setMemoryError(`没有需要导入的新条目（跳过 ${plan.skipped} 条）。`);
        return;
      }
      // 先展示数量，再由用户确认写入。
      if (!window.confirm(`导入 ${plan.imported} 条记忆（跳过 ${plan.skipped} 条）？导入不会开启总开关。`)) return;
      await apply(plan.operations);
    } catch (error) {
      setMemoryError(error instanceof Error ? error.message : "导入失败。");
    }
  };

  // 「本次使用」来自真实筛选（与请求组装同一规则），不是面板条目数。
  const promptEntries = memoryForRequest(state);

  return (
    <section className="wb-panel wb-capabilities" aria-label="本地记忆">
      {!embedded && (
        <header className="wb-panel-head">
          <div>
            <h2>本地记忆</h2>
          </div>
          <button type="button" className="wb-icon-button" aria-label="关闭" title="关闭" onClick={onClose}>
            <X size={18} aria-hidden />
          </button>
        </header>
      )}

      <div className="wb-cap-block" aria-label="本地记忆">
        {!embedded && <h3>
          <ShieldCheck size={14} aria-hidden /> 本地记忆
        </h3>}
        <label className="wb-authorize">
          <input
            type="checkbox"
            checked={state.enabled}
            disabled={busy}
            onChange={event => void apply([{ op: "set-enabled", enabled: event.target.checked }])}
          />
          允许 AI 使用记忆
        </label>
        <p className="wb-panel-hint">
          当前可使用 {promptEntries.length} 条{state.entries.length ? `，已保存 ${state.entries.length} 条。` : "。"}
          {memoryError ? <span role="status"> {memoryError}</span> : null}
        </p>
        <div className="wb-cap-actions">
          <button type="button" className="secondary-button" disabled={busy} onClick={() => void load({ force: true })}>
            <RefreshCw size={15} aria-hidden /> 重新读取
          </button>
          <button type="button" className="secondary-button" onClick={downloadMemory}>
            <Download size={15} aria-hidden /> 导出记忆
          </button>
          <label className="secondary-button wb-cap-import">
            <Upload size={15} aria-hidden /> 导入记忆
            <input
              type="file"
              accept="application/json,.json"
              aria-label="导入记忆文件"
              onChange={event => void importMemory(event.target.files?.[0])}
            />
          </label>
        </div>
        {state.entries.length === 0 ? (
          <p className="wb-empty-note">还没有记忆。在下面写一条偏好，保存后勾选「允许用于对话」。</p>
        ) : (
          <ul className="wb-cap-memory">
            {state.entries.map(entry => (
              <li key={entry.id}>
                {editing?.id === entry.id ? (
                  <div className="wb-cap-edit">
                    <input
                      value={editing.text}
                      aria-label="编辑记忆"
                      onChange={event => setEditing({ id: entry.id, text: event.target.value })}
                    />
                    <button type="button" className="secondary-button" disabled={busy} onClick={() => void saveEntry(editing.text, entry.id)}>
                      保存
                    </button>
                    <button type="button" className="secondary-button" onClick={() => setEditing(undefined)}>
                      取消
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="wb-cap-memory-head">
                      <span className="wb-cap-kind">长期偏好</span>
                      <div className="wb-note-actions">
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={busy}
                          onClick={() => setEditing({ id: entry.id, text: entry.text })}
                        >
                          编辑
                        </button>
                        <button
                          type="button"
                          className="secondary-button"
                          data-tone="danger"
                          disabled={busy}
                          onClick={() => void apply([{ op: "delete", id: entry.id }])}
                        >
                          <Trash2 size={13} aria-hidden /> 删除
                        </button>
                      </div>
                    </div>
                    <p>{entry.text}</p>
                    <label className="wb-cap-sent">
                      <input
                        type="checkbox"
                        checked={entry.allowModelUse}
                        disabled={busy}
                        aria-label={`允许用于对话：${entry.text.slice(0, 12)}`}
                        onChange={event =>
                          void apply([
                            {
                              op: "upsert",
                              id: entry.id,
                              kind: "preference",
                              text: entry.text,
                              allowModelUse: event.target.checked
                            }
                          ])
                        }
                      />
                      允许用于对话
                    </label>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="wb-cap-add">
          <label className="wb-field">
            <span>新增记忆</span>
            <input
              value={draft}
              placeholder="写一条偏好，例如：喜欢安静的住处"
              aria-label="新增记忆"
              onChange={event => setDraft(event.target.value)}
            />
          </label>
          <button type="button" className="secondary-button" disabled={!draft.trim() || busy} onClick={() => void saveEntry(draft)}>
            存为长期偏好
          </button>
        </div>
      </div>
    </section>
  );
}
