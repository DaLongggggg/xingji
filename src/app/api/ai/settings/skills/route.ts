/**
 * `/api/ai/settings/skills`：本机视图（GET）、开关 / 备注（PUT）、垃圾箱彻底删除（DELETE）。
 *
 * 边界（与隐私设置端点同一套）：
 * - 仅本机同源（`requireBetaAccess`），响应 `no-store`，不回传任何本机绝对路径或密钥；
 * - PUT 只接受 revision + ID + state 或 remark，有限请求体；版本不匹配明确 409；
 * - 状态落在**同一份加密文档**上，模型/隐私/其他 Skill 字段原样保留；
 * - 写后以服务端回读为准（响应就是重新读出来的状态，不是把请求体回显当成功）。
 */
import { isLegacySkillId, isSkillId, isSkillState, isSkillRemark, parseSkillDeleteRequest } from "@/features/ai/skill-settings-contract";
import { requireBetaAccess } from "@/server/ai/session-http";
import { SkillSettingsError, applySkillState, readJsonBodyWithinLimit, readSkillSettings } from "@/server/ai/skill-settings";
import { deleteSkills } from "@/server/ai/skill-delete";
import { recoverSkillInstallations } from "@/server/ai/skill-install";
import { SkillInstallError } from "@/features/skills/skill-package";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** 请求体上限：三个字段的声明，不该有正文级体量。 */
const MAX_BODY_BYTES = 2_048;

function view() {
  const { revision, writable, skills } = readSkillSettings();
  return { ok: true, revision, writable, skills };
}

export async function GET(request: Request): Promise<Response> {
  // requireBetaAccess 返回的是 Response（401/403/503）或 undefined——原样透传。
  const denied = requireBetaAccess(request);
  if (denied) return denied;
  try {
    await recoverSkillInstallations();
    return json(view());
  } catch (error) {
    return json({ ok: false, detail: error instanceof SkillInstallError ? error.message : "无法读取 Skill 设置，请重试。" }, 503);
  }
}

export async function PUT(request: Request): Promise<Response> {
  const denied = requireBetaAccess(request);
  if (denied) return denied;
  if (!request.headers.get("content-type")?.includes("application/json"))
    return json({ ok: false, detail: "请求格式无效。" }, 400);

  // 读取过程中就限制字节数：超过上限立即停止读取，不先读完再判断。
  const read = await readJsonBodyWithinLimit(request, MAX_BODY_BYTES);
  if (!read.ok)
    return read.code === "AI_SKILL_BODY_TOO_LARGE"
      ? json({ ok: false, detail: "请求内容过长。" }, 413)
      : json({ ok: false, detail: "请求格式无效。" }, 400);
  const body = read.value;
  if (!body || typeof body !== "object" || Array.isArray(body))
    return json({ ok: false, detail: "设置格式无效。" }, 400);
  const { revision, id, state, remark } = body as { revision?: unknown; id?: unknown; state?: unknown; remark?: unknown };
  if (Object.keys(body as object).length !== 3 || typeof revision !== "string" || !revision.trim())
    return json({ ok: false, detail: "设置格式无效：只接受 revision、id 和 state 或 remark。" }, 400);
  // 阶段B：id 按形状校验（目录名），不再限定固定清单——发现的任意 Skill 都走同一启停机制；
  // 旧文档的退役键仍可读，但不再接受写入（防止复活已移除的功能）。
  if (!isSkillId(id) || isLegacySkillId(id))
    return json({ ok: false, detail: "Skill 无效：id 必须是 技能目录名（小写字母/数字/点/横线/下划线，且不是已退役键），state 必须是 enabled/disabled/removed。" }, 400);
  const change = state !== undefined && remark === undefined && isSkillState(state)
    ? { id, revision: revision.trim(), state }
    : remark !== undefined && state === undefined && isSkillRemark(remark)
      ? { id, revision: revision.trim(), remark: remark.trim() }
      : undefined;
  if (!change) return json({ ok: false, detail: "启停状态无效，或备注超过 100 字 / 包含换行。" }, 400);

  // 写入与写后回读**分开处理**（复审六）：写入失败的“未能保存”必须是真话；
  // 写入已成功而目录视图构建失败（如 技能根暂不可读）时，如实回报已保存 + 列表暂不可读，
  // 不落入同一个失败分支谎报保存失败。
  try {
    await applySkillState(change);
  } catch (error) {
    if (error instanceof SkillSettingsError && error.code === "AI_SKILLS_CONFLICT")
      return json({ ok: false, detail: "设置已在别处修改，请重新读取后再试。" }, 409);
    if (error instanceof SkillSettingsError && error.code === "AI_SKILL_NOT_FOUND")
      return json({ ok: false, detail: error.message }, 400);
    return json({ ok: false, detail: "设置未能保存，请重新读取后再试。" }, 503);
  }
  try {
    // 写后回读：响应是服务端现在的状态。
    return json(view());
  } catch {
    // 保存已完成但列表读不出来：revision 置空强制客户端重新打开设置同步，
    // 不冒充完整视图（skills 为空数组是「暂不可读」，不是「没有 Skill」）。
    return json({
      ok: true, revision: null, writable: false, skills: [],
      ...(change.remark !== undefined ? { savedRemark: { id, remark: change.remark } } : { savedState: { id, state: change.state } }),
      detail: "已保存；Skill 列表暂时无法读取（来源目录不可用），请重新打开设置查看。"
    }, 200);
  }
}

/** User-confirmed permanent deletion; paths are resolved exclusively on the server. */
export async function DELETE(request: Request): Promise<Response> {
  const denied = requireBetaAccess(request);
  if (denied) return denied;
  if (!request.headers.get("content-type")?.includes("application/json"))
    return json({ ok: false, detail: "请求格式无效。" }, 400);
  const read = await readJsonBodyWithinLimit(request, 16_384);
  if (!read.ok) return json({ ok: false, detail: "删除请求无效或过长。" }, read.code === "AI_SKILL_BODY_TOO_LARGE" ? 413 : 400);
  const input = parseSkillDeleteRequest(read.value);
  if (!input) return json({ ok: false, detail: "请选择 1–100 个 Skill 并确认彻底删除；请求只接受 revision、ids、confirmed。" }, 400);

  let deletion;
  try { deletion = await deleteSkills(input); } catch (error) {
    if (error instanceof SkillSettingsError) {
      const status = error.code === "AI_SKILLS_CONFLICT" ? 409 : error.code === "AI_SKILL_DIR_UNSAFE" || error.code === "AI_SKILL_NOT_FOUND" ? 400 : 503;
      return json({ ok: false, detail: error.message }, status);
    }
    return json({ ok: false, detail: "删除结果未确认，请重新读取垃圾箱并核对文件后重试。" }, 503);
  }
  const detail = deletion.cleanupPending ? "文件已删除，但残留设置未能清理。请重新读取垃圾箱后重试彻底删除。" : undefined;
  try { return json({ ...view(), deletion, ...(detail ? { detail } : {}) }); } catch {
    return json({ ok: true, revision: null, writable: false, skills: [], deletion,
      detail: `${detail ?? "删除结果已记录。"}Skill 列表暂时无法读取，请重新读取后核对。` });
  }
}
