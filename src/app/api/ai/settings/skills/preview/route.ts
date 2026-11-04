import { requireBetaAccess } from "@/server/ai/session-http";
import { readJsonBodyWithinLimit } from "@/server/ai/skill-settings";
import {
  assertSkillInstallWritable,
  marketSkillImport,
  previewSkillImport,
  readSkillUpload,
  recoverSkillInstallations,
  skillInstallFailure,
  skillInstallJson
} from "@/server/ai/skill-install";
import { downloadSkillUrl } from "@/server/ai/skill-download";
import {
  assertImportPath,
  decodeSkillText,
  isRecord,
  prepareMarkdown,
  SkillInstallError,
  type SkillImport
} from "@/features/skills/skill-package";
import { prepareSkillZip } from "@/features/skills/skill-zip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const denied = requireBetaAccess(request);
  if (denied) return denied;
  try {
    assertSkillInstallWritable();
    let imported: SkillImport, source: string;
    const type = request.headers.get("content-type")?.split(";")[0].trim();
    if (type === "application/octet-stream") {
      const header = request.headers.get("x-skill-filename");
      if (!header) throw new SkillInstallError("SKILL_INVALID", "上传文件缺少名称。");
      let filename: string;
      try {
        filename = decodeURIComponent(header);
      } catch {
        throw new SkillInstallError("SKILL_INVALID", "文件名编码无效。");
      }
      assertImportPath(filename);
      if (filename.includes("/") || !/\.(?:md|zip)$/i.test(filename))
        throw new SkillInstallError("SKILL_INVALID", "请选择 .md 或 .zip 文件。");
      const bytes = await readSkillUpload(request);
      imported = /\.zip$/i.test(filename)
        ? prepareSkillZip(bytes)
        : { packages: [prepareMarkdown(decodeSkillText(bytes), filename)], warnings: [] };
      source = `本地文件：${filename}`;
    } else if (type === "application/json") {
      const read = await readJsonBodyWithinLimit(request, 1024 * 1024);
      if (!read.ok)
        throw new SkillInstallError(
          read.code === "AI_SKILL_BODY_TOO_LARGE" ? "SKILL_LIMIT" : "SKILL_INVALID",
          "导入内容过长或格式无效。"
        );
      const body = read.value;
      if (!isRecord(body)) throw new SkillInstallError("SKILL_INVALID", "导入请求无效。");
      if (
        body.kind === "markdown" &&
        typeof body.markdown === "string" &&
        Object.keys(body).every((key) => key === "kind" || key === "markdown")
      ) {
        imported = { packages: [prepareMarkdown(body.markdown)], warnings: [] };
        source = "粘贴 Markdown";
      } else if (
        body.kind === "url" &&
        typeof body.url === "string" &&
        Object.keys(body).length === 2
      ) {
        imported = await downloadSkillUrl(body.url, {}, request.signal);
        source = body.url.trim();
      } else if (
        body.kind === "market" &&
        typeof body.id === "string" &&
        Object.keys(body).length === 2
      ) {
        imported = marketSkillImport(body.id);
        source = `行迹技能市场：${body.id}`;
      } else
        throw new SkillInstallError(
          "SKILL_INVALID",
          "请选择有效的文件、链接、Markdown 或市场技能。"
        );
    } else throw new SkillInstallError("SKILL_INVALID", "导入格式无效。");
    await recoverSkillInstallations();
    return skillInstallJson(previewSkillImport(imported, source));
  } catch (error) {
    return skillInstallFailure(error);
  }
}
