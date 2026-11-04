/**
 * `/api/ai/settings/skills/open-folder`：在**运行应用的本机**打开某个已登记 Skill 的来源目录。
 *
 * 边界：
 * - 只接受固定 `id`；目录由服务端登记表解析，接口不接受 path/command/URL（无通用命令执行端点）；
 * - 仅本机同源；目录必须存在并通过固定根/realpath 校验，越界或符号链接替换一律拒绝；
 * - 文案是「已请求打开文件夹」：不声称验证了文件管理器窗口。
 */
import {isManagedSkillId, isSkillId} from "@/features/ai/skill-settings-contract";
import { requireBetaAccess } from "@/server/ai/session-http";
import { openSkillFolder, readJsonBodyWithinLimit } from "@/server/ai/skill-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** 请求体上限：只有一个 id 的声明。 */
const MAX_BODY_BYTES = 1_024;

export async function POST(request: Request): Promise<Response> {
  const denied = requireBetaAccess(request);
  if (denied) return denied;
  // 请求体只有一个 id：读取过程中就限制字节数，超限立即停止读取。
  const read = await readJsonBodyWithinLimit(request, MAX_BODY_BYTES);
  if (!read.ok)
    return read.code === "AI_SKILL_BODY_TOO_LARGE"
      ? json({ ok: false, detail: "请求内容过长。" }, 413)
      : json({ ok: false, detail: "请求格式无效。" }, 400);
  const body = read.value;
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body as object).length !== 1)
    return json({ ok: false, detail: "请求格式无效：只接受 id。" }, 400);
  const { id } = body as { id?: unknown };
  // 阶段B 复审：发现驱动的登记视图——任意形状合法的目录名都可打开（服务端再核对目录边界）。
  if (!isSkillId(id)) return json({ ok: false, detail: "未知的 Skill。" }, 400);

  if (process.platform !== "darwin" && process.platform !== "win32" && process.platform !== "linux")
    return json({ ok: false, detail: "请在运行应用的电脑上打开此目录。" }, 501);

  const result = await openSkillFolder(id);
  if (!result.ok) {
    const status = result.code === "SKILL_OPEN_UNSUPPORTED" ? 501 : result.code === "SKILL_DIR_MISSING" ? 404 : 500;
    return json({ ok: false, detail: result.detail, code: result.code }, status);
  }
  // 成功文案只到「已请求打开」这一层。
  return json({ ok: true, detail: "已请求打开文件夹。", sourceDir: result.path });
}
