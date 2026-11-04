import { isAllowedSkillPath, isSkillId, type SkillCatalogEntry, type SkillDesignResource, type SkillReadRequest, type SkillReadResult } from "@/features/ai/skill-knowledge";
import { isSkillRemark, isSkillState, type SkillDeleteRequest, type SkillDeleteResult, type SkillSettingsView, type SkillState } from "@/features/ai/skill-settings-contract";
import { decodeSkillText, normalizeSkillPackage, prepareMarkdown, prepareSkillFiles, SkillInstallError, validateSkillPackages, type SkillImport, type SkillInstallChoice, type SkillPackage, type SkillPreview, type SkillTextFile } from "@/features/skills/skill-package";
import { prepareSkillZip } from "@/features/skills/skill-zip";
import { ACTOR_WHERE, actorValues, type NativeActor, type NativeDatabase } from "./native-database";
import { detectGlobalBridge, digestBytes } from "./native-host";
import { nativeJson } from "./native-repositories";

export type NativeSkillInput =
  | { kind: "markdown" | "paste"; text: string; filename?: string }
  | { kind: "zip"; bytes: Uint8Array; filename?: string }
  | { kind: "url"; url: string; downloaded: { bytes: Uint8Array; filename: string } | { files: SkillTextFile[] } };
type StoredSkill = { id: string; name: string; description: string; source: "installed" | "bundled"; state: SkillState; remark?: string; package?: SkillPackage; digest: string; fingerprint: string; fileDigests: Record<string, string> };
export type NativeSkillSnapshot = { id: string; name: string; digest: string; windows: { path: string; offset: number; total: number; digest: string; text: string; nextOffset?: number }[] };

/** Pure text packages share the existing MD/ZIP parsers. URL bytes must arrive through the authenticated downloader. */
export function createNativeSkillStore(database: NativeDatabase, actorInput: NativeActor, options: { bundled?: readonly SkillPackage[]; digest?: (bytes: Uint8Array) => Promise<string>; assertCurrent?: () => void } = {}) {
  const actor = Object.freeze({ ...actorInput }); const values = () => actorValues(actor);
  const digest = options.digest ?? ((bytes: Uint8Array) => digestBytes(bytes, detectGlobalBridge()));
  const bundled = new Map((options.bundled ?? []).map((item) => { const normalized = normalizeSkillPackage(item); return [normalized.id, normalized] as const; }));
  if (bundled.size !== (options.bundled ?? []).length) throw new SkillInstallError("SKILL_INVALID", "内置 Skill 标识重复。");
  const tx = <T,>(operation: () => Promise<T>) => database.transaction(async () => { options.assertCurrent?.(); await database.assertActor(actor); const result = await operation(); options.assertCurrent?.(); return result; });
  const sha = async (text: string) => { const result = await digest(new TextEncoder().encode(text)); if (!/^[a-f0-9]{64}$/.test(result)) throw new SkillInstallError("SKILL_UNAVAILABLE", "摘要能力不可用。"); return result; };
  const revision = async () => {
    const row = (await database.query(`SELECT json FROM mobile_records WHERE ${ACTOR_WHERE} AND kind='kv' AND record_id='native-skills-revision'`, values()))[0];
    const result = row ? Number(JSON.parse(String(row.json))) : 1;
    if (!Number.isSafeInteger(result) || result < 1) throw new SkillInstallError("SKILL_UNAVAILABLE", "Skill 状态无法读取。");
    return result;
  };
  const put = (id: string, data: StoredSkill) => database.run("INSERT INTO mobile_records(server_id,user_id,dataset_id,kind,record_id,json) VALUES(?,?,?,'skill',?,?) ON CONFLICT(server_id,user_id,dataset_id,kind,record_id) DO UPDATE SET json=excluded.json", [...values(), id, nativeJson(data)]);
  const bump = async () => {
    const next = await revision() + 1;
    await database.run("INSERT INTO mobile_records(server_id,user_id,dataset_id,kind,record_id,json) VALUES(?,?,?,'kv','native-skills-revision',?) ON CONFLICT(server_id,user_id,dataset_id,kind,record_id) DO UPDATE SET json=excluded.json", [...values(), nativeJson(next)]);
    return String(next);
  };
  const checkRevision = async (expected: string) => { if (String(await revision()) !== expected) throw new SkillInstallError("SKILL_CONFLICT", "Skill 已更新，请重新读取后确认。"); };
  const describe = async (item: SkillPackage, source: StoredSkill["source"], state: SkillState = "enabled"): Promise<StoredSkill> => {
    const fileDigests: Record<string, string> = {};
    for (const file of item.files) fileDigests[file.path] = await sha(file.content);
    return { id: item.id, name: item.name, description: item.description, source, state, ...(source === "installed" ? { package: item } : {}), digest: fileDigests["SKILL.md"]!, fingerprint: await sha(nativeJson({ name: item.name, description: item.description, files: item.files })), fileDigests };
  };
  const bundledDescriptions = new Map<string, StoredSkill>();
  const get = async (id: string): Promise<StoredSkill | null> => {
    const row = (await database.query(`SELECT json FROM mobile_records WHERE ${ACTOR_WHERE} AND kind='skill' AND record_id=?`, [...values(), id]))[0];
    const saved = row ? JSON.parse(String(row.json)) as StoredSkill : null;
    if (saved?.source === "installed") return saved;
    const item = bundled.get(id); if (!item) return null;
    let base = bundledDescriptions.get(id); if (!base) { base = await describe(item, "bundled"); bundledDescriptions.set(id, base); }
    return { ...base, ...(saved ? { state: saved.state, ...(saved.remark ? { remark: saved.remark } : {}) } : {}) };
  };
  const all = async (): Promise<StoredSkill[]> => {
    // Only metadata reaches JS for the catalog. Content remains in the local row until read/install needs it.
    const rows = await database.query(`SELECT record_id,json_extract(json,'$.name') AS name,json_extract(json,'$.description') AS description,json_extract(json,'$.source') AS source,json_extract(json,'$.state') AS state,json_extract(json,'$.remark') AS remark,json_extract(json,'$.digest') AS digest,json_extract(json,'$.fingerprint') AS fingerprint,json_extract(json,'$.fileDigests') AS file_digests FROM mobile_records WHERE ${ACTOR_WHERE} AND kind='skill'`, values());
    const byId = new Map<string, StoredSkill>();
    for (const [id] of bundled) { const item = await get(id); if (item) byId.set(id, item); }
    for (const row of rows) if (row.source === "installed") byId.set(String(row.record_id), { id: String(row.record_id), name: String(row.name), description: String(row.description), source: "installed", state: row.state as SkillState, ...(row.remark ? { remark: String(row.remark) } : {}), digest: String(row.digest), fingerprint: String(row.fingerprint), fileDigests: JSON.parse(String(row.file_digests)) });
    return [...byId.values()];
  };
  const catalog = async (): Promise<SkillCatalogEntry[]> => (await all()).filter((item) => item.state !== "removed").map((item) => ({ id: item.id, name: item.name, description: item.description, enabled: item.state === "enabled", readable: true, digest: item.digest, source: item.source, ...(item.remark ? { remark: item.remark } : {}) }));
  const settings = async (): Promise<SkillSettingsView> => ({ ok: true, revision: String(await revision()), writable: true, skills: (await all()).map((item) => ({ id: item.id, label: item.name, summary: item.description, kind: "resource", version: "1", state: item.state, available: item.state === "enabled", requires: [], tools: [], usedBy: [], sourceDir: item.source === "bundled" ? `bundled/${item.id}` : `installed/${item.id}`, directoryExists: true, source: item.source, promptFiles: Object.keys(item.fileDigests), fileDigests: item.fileDigests, verification: { adapterVersion: 1, digest: item.digest, status: "ok" }, ...(item.remark ? { remark: item.remark } : {}) })) });
  const parseInput = (input: NativeSkillInput): { imported: SkillImport; source: string } => {
    if (input.kind === "markdown" || input.kind === "paste") return { imported: { packages: [prepareMarkdown(input.text, input.filename)], warnings: [] }, source: input.kind === "paste" ? "粘贴内容" : input.filename ?? "Markdown" };
    if (input.kind === "zip") return { imported: prepareSkillZip(input.bytes), source: input.filename ?? "ZIP" };
    if (input.kind !== "url") throw new SkillInstallError("SKILL_INVALID", "导入来源无效。");
    let url: URL;
    try { url = new URL(input.url); } catch { throw new SkillInstallError("SKILL_INVALID", "下载来源无效。"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new SkillInstallError("SKILL_INVALID", "下载来源无效。");
    const downloaded = input.downloaded;
    const imported = "files" in downloaded ? prepareSkillFiles(downloaded.files) : /\.zip$/i.test(downloaded.filename) ? prepareSkillZip(downloaded.bytes) : { packages: [prepareMarkdown(decodeSkillText(downloaded.bytes), downloaded.filename)], warnings: [] };
    return { imported, source: `${url.origin}${url.pathname}` };
  };
  const read = async (request: SkillReadRequest): Promise<SkillReadResult> => {
    if (!isSkillId(request.id) || !isAllowedSkillPath(request.path ?? "SKILL.md") || (request.offset !== undefined && (!Number.isInteger(request.offset) || request.offset < 0)) || (request.limit !== undefined && (!Number.isInteger(request.limit) || request.limit < 1))) return { ok: false, code: "SKILL_PATH_INVALID", detail: "Skill 路径或读取范围无效。" };
    const item = await get(request.id); if (!item || item.state === "removed") return { ok: false, code: "SKILL_NOT_FOUND", detail: "Skill 不存在。" };
    if (item.state !== "enabled") return { ok: false, code: "SKILL_DISABLED", detail: "Skill 已停用。" };
    const path = request.path ?? "SKILL.md"; const file = (item.source === "bundled" ? bundled.get(item.id) : item.package)?.files.find((entry) => entry.path === path);
    if (!file) return { ok: false, code: "SKILL_UNREADABLE", detail: "Skill 文件不可读。" };
    const actualDigest = await sha(file.content); if (actualDigest !== item.fileDigests[path]) return { ok: false, code: "SKILL_UNREADABLE", detail: "Skill 文件已变化，请重新导入后确认。" };
    const offset = Math.min(request.offset ?? 0, file.content.length); const text = file.content.slice(offset, request.limit === undefined ? undefined : offset + request.limit); const nextOffset = offset + text.length;
    return { ok: true, id: item.id, name: item.name, path, digest: actualDigest, total: file.content.length, offset, text, ...(nextOffset < file.content.length ? { nextOffset } : {}) };
  };
  return {
    catalog: () => tx(catalog), settings: () => tx(settings), read: (request: SkillReadRequest) => tx(() => read(request)),
    preview: (input: NativeSkillInput): Promise<SkillPreview> => tx(async () => {
      const { imported, source } = parseInput(input); const existing = await all(); const occupied = new Set(existing.map((item) => item.id));
      const items = [];
      for (const item of imported.packages) {
        const next = await describe(item, "installed"); const before = existing.find((entry) => entry.id === item.id);
        let copyId = `${item.id.slice(0, 59)}-2`; for (let suffix = 3; occupied.has(copyId); suffix += 1) copyId = `${item.id.slice(0, 59)}-${suffix}`; occupied.add(copyId);
        items.push({ package: item, source, ...(before ? { conflict: { fingerprint: before.fingerprint, canUpdate: before.source === "installed", identical: before.fingerprint === next.fingerprint, state: before.state } } : {}), duplicates: existing.filter((entry) => entry.id !== item.id && entry.fingerprint === next.fingerprint).map((entry) => ({ id: entry.id, name: entry.name })), copyId });
      }
      return { ok: true, revision: String(await revision()), items, warnings: imported.warnings };
    }),
    install: (input: { revision: string; choices: SkillInstallChoice[] }) => tx(async () => {
      await checkRevision(input.revision);
      if (!Array.isArray(input.choices) || !input.choices.length || input.choices.length > 20) throw new SkillInstallError("SKILL_INVALID", "安装选择无效。");
      const targets = new Set<string>();
      for (const choice of input.choices) {
        if (choice.action === "skip") continue;
        if (!["create", "copy", "update"].includes(choice.action) || !isSkillId(choice.targetId) || targets.has(choice.targetId)) throw new SkillInstallError("SKILL_INVALID", "安装目标无效或重复。");
        targets.add(choice.targetId);
        const item = normalizeSkillPackage(choice.package); const previous = await get(choice.targetId);
        if (choice.action === "update") {
          if (!previous || previous.source !== "installed" || previous.fingerprint !== choice.expectedFingerprint) throw new SkillInstallError("SKILL_CONFLICT", "安装目标已变化或为只读内置 Skill。");
        } else if (previous || choice.expectedFingerprint !== null || (choice.action === "create" && choice.targetId !== item.id) || (choice.action === "copy" && choice.targetId === item.id)) throw new SkillInstallError("SKILL_CONFLICT", "安装目标已存在，请重新预览。");
        const next = await describe(normalizeSkillPackage({ ...item, id: choice.targetId }), "installed", previous?.state ?? "enabled");
        if (previous?.remark) next.remark = previous.remark;
        await put(next.id, next);
      }
      const changed = input.choices.filter((choice) => choice.action !== "skip");
      if (changed.length) { validateSkillPackages(changed.map((choice) => choice.package)); await bump(); }
      return settings();
    }),
    setState: (id: string, state: SkillState, expectedRevision: string) => tx(async () => {
      await checkRevision(expectedRevision); if (!isSkillState(state)) throw new SkillInstallError("SKILL_INVALID", "Skill 状态无效。");
      const item = await get(id); if (!item) throw new SkillInstallError("SKILL_INVALID", "Skill 不存在。");
      await put(id, { ...item, state }); await bump(); return settings();
    }),
    setRemark: (id: string, remark: string, expectedRevision: string) => tx(async () => {
      await checkRevision(expectedRevision); if (!isSkillRemark(remark)) throw new SkillInstallError("SKILL_INVALID", "Skill 备注无效。");
      const item = await get(id); if (!item) throw new SkillInstallError("SKILL_INVALID", "Skill 不存在。");
      const next = { ...item }; if (remark.trim()) next.remark = remark.trim(); else delete next.remark;
      await put(id, next); await bump(); return settings();
    }),
    removePermanently: (input: SkillDeleteRequest): Promise<SkillDeleteResult & { revision: string }> => tx(async () => {
      await checkRevision(input.revision);
      if (input.confirmed !== true || !input.ids.length || input.ids.length > 100 || new Set(input.ids).size !== input.ids.length) throw new SkillInstallError("SKILL_INVALID", "请确认要彻底删除的 Skill。");
      const deleted = [], failed = [];
      for (const id of input.ids) {
        const item = await get(id);
        if (!item || item.source === "bundled" || item.state !== "removed") { failed.push({ id, detail: "只可彻底删除垃圾箱中的用户 Skill。" }); continue; }
        await database.run(`DELETE FROM mobile_records WHERE ${ACTOR_WHERE} AND kind='skill' AND record_id=?`, [...values(), id]); deleted.push(id);
      }
      return { deleted, failed, revision: deleted.length ? await bump() : String(await revision()) };
    }),
    snapshotForTask: (selection: readonly SkillDesignResource[]): Promise<NativeSkillSnapshot[]> => tx(async () => {
      if (selection.length > 20 || new Set(selection.map((item) => item.id)).size !== selection.length) throw new SkillInstallError("SKILL_INVALID", "Skill 选择无效。");
      const result: NativeSkillSnapshot[] = []; let totalBytes = 0;
      for (const selected of selection) {
        const item = await get(selected.id);
        if (!item || item.state !== "enabled" || item.digest !== selected.digest || !selected.windows.length) throw new SkillInstallError("SKILL_CONFLICT", "所选 Skill 已变化或不可用。");
        const windows = [];
        for (const window of selected.windows) {
          const content = await read({ id: selected.id, path: window.path, offset: window.offset, limit: window.limit });
          if (!content.ok || content.digest !== window.digest) throw new SkillInstallError("SKILL_CONFLICT", "所选 Skill 资料已变化。");
          totalBytes += new TextEncoder().encode(content.text).length; if (totalBytes > 2 * 1024 * 1024) throw new SkillInstallError("SKILL_LIMIT", "所选 Skill 资料过多。");
          windows.push({ path: content.path, offset: content.offset, total: content.total, digest: content.digest, text: content.text, ...(content.nextOffset !== undefined ? { nextOffset: content.nextOffset } : {}) });
        }
        result.push({ id: item.id, name: item.name, digest: item.digest, windows });
      }
      return result;
    })
  };
}
