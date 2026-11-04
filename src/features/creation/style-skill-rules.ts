/**
 * 三个**第三方风格 Skill** 的固定登记（纯规则，可安全进浏览器 bundle）。
 *
 * 它们和 `huashu-gpt-image` 一样是**文件资源**：只把提示词文本喂给模型，
 * 不执行上游脚本、不下载素材。sha256 与许可证记录在各目录的 `PROVENANCE.md`，
 * 服务端加载器（`src/server/ai/style-skill.ts`）逐文件核对。
 *
 * 边界：这里是**登记表**，不是插件市场——只登记这三个已 vendor 进仓库的目录，
 * 不扫描用户目录、不按 URL 安装、不运行任何上游代码。
 */
export const STYLE_SKILLS = {
  "gc-minimal-zine-poster": {
    folder: "gc-minimal-zine-poster",
    label: "极简杂志海报",
    version: "v0.3.1",
    upstream: "https://github.com/LiamGvchi/gc-minimal-zine-poster",
    license: "MIT",
    summary: "纸纹、大留白、小体量编辑拼贴与一处高饱和强调色的极简海报风格。"
  },
  "gathered-scenes-zine": {
    folder: "gathered-scenes-zine",
    label: "实景拼贴纸刊",
    version: "v1.3",
    upstream: "https://github.com/Zeejay0/gathered-scenes-zine-skill",
    license: "个人非商用",
    summary: "保留真实摄影为锚点，用源图派生的抽象形状、单一高纯度色与手撕纸边构成纸刊海报。"
  },
  "photo-abstract-editorial": {
    folder: "photo-abstract-editorial",
    label: "照片抽象编辑",
    version: "v1",
    upstream: "https://github.com/ZzzLc0405/photo-abstract-editorial",
    license: "CC BY-NC-SA 4.0 非商用",
    summary: "照片原样保留为上段，下段由照片的空间与色彩关系派生出克制的抽象记忆面板。"
  }
} as const;

export type StyleSkillId = keyof typeof STYLE_SKILLS;
export const STYLE_SKILL_IDS = Object.keys(STYLE_SKILLS) as StyleSkillId[];

export function isStyleSkillId(value: unknown): value is StyleSkillId {
  return typeof value === "string" && (STYLE_SKILL_IDS as readonly string[]).includes(value);
}
