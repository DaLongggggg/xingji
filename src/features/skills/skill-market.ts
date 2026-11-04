/** Manifest contract shared by Web and future native hosts. */
import { isSkillId } from "@/features/ai/skill-knowledge";
import { isRecord, SKILL_LIMITS, SkillInstallError, utf8Size } from "./skill-package";

export const SKILL_CATEGORIES = {
  drawing: "绘图",
  editing: "修图",
  photography: "摄影",
  writing: "旅行文案"
} as const;
export type SkillCategory = keyof typeof SKILL_CATEGORIES;
export type SkillMarketEntry = {
  id: string;
  name: string;
  description: string;
  category: SkillCategory;
  tags: string[];
  publisher: string;
  markdown: string;
};
export type SkillMarketListing = Omit<SkillMarketEntry, "markdown">;
export function skillMarketListing({
  id,
  name,
  description,
  category,
  tags,
  publisher
}: SkillMarketEntry): SkillMarketListing {
  return { id, name, description, category, tags, publisher };
}

export function parseSkillMarket(value: unknown): SkillMarketEntry[] {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Array.isArray(value.skills) ||
    value.skills.length > 100
  )
    throw new SkillInstallError("SKILL_UNAVAILABLE", "技能市场清单无效，请稍后重试。");
  const ids = new Set<string>();
  return value.skills.map((raw: unknown) => {
    if (
      !isRecord(raw) ||
      !isSkillId(raw.id) ||
      ids.has(raw.id) ||
      typeof raw.name !== "string" ||
      !raw.name.trim() ||
      raw.name.length > SKILL_LIMITS.name ||
      typeof raw.description !== "string" ||
      !raw.description.trim() ||
      raw.description.length > SKILL_LIMITS.description ||
      typeof raw.category !== "string" ||
      !Object.hasOwn(SKILL_CATEGORIES, raw.category) ||
      typeof raw.publisher !== "string" ||
      !raw.publisher.trim() ||
      raw.publisher.length > 100 ||
      !Array.isArray(raw.tags) ||
      raw.tags.length > 10 ||
      !raw.tags.every((tag) => typeof tag === "string" && tag.length <= 40) ||
      typeof raw.markdown !== "string" ||
      !raw.markdown.trim() ||
      utf8Size(raw.markdown) > SKILL_LIMITS.textBytes
    )
      throw new SkillInstallError("SKILL_UNAVAILABLE", "技能市场存在无效条目，请稍后重试。");
    ids.add(raw.id);
    return raw as SkillMarketEntry;
  });
}

export function searchSkillMarket(
  entries: SkillMarketListing[],
  query: string,
  category: SkillCategory | "all"
): SkillMarketListing[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter(
    (entry) =>
      (category === "all" || entry.category === category) &&
      words.every((word) =>
        `${entry.name} ${entry.description} ${entry.tags.join(" ")}`.toLowerCase().includes(word)
      )
  );
}
