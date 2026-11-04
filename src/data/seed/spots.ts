import { destinations } from "./destinations";
import { citySpotCatalog } from "./spot-catalog";
import type { Spot, SpotCategory } from "@/server/shared/types";

const categoryCopy: Record<SpotCategory, { label: string; tags: string[] }> = {
  cultural: { label: "人文", tags: ["文化", "城市记忆"] },
  natural: { label: "自然", tags: ["自然", "户外"] },
  shopping: { label: "逛街", tags: ["街区", "美食"] }
};

function hashName(name: string): number {
  return Array.from(name).reduce((total, character) => total + character.charCodeAt(0), 0);
}

function buildSpot(
  destinationId: string,
  category: SpotCategory,
  name: string,
  index: number
): Spot {
  const destination = destinations.find((candidate) => candidate.id === destinationId);
  if (!destination) {
    throw new Error(`Unknown destination: ${destinationId}`);
  }

  const hash = hashName(name);
  const longitudeOffset = ((hash % 19) - 9) * 0.035;
  const latitudeOffset = (((hash >> 2) % 17) - 8) * 0.028;
  const isFree = index % 3 === 1 || category === "shopping";
  const label = categoryCopy[category].label;

  return {
    id: `spot-${destination.slug}-${category}-${String(index + 1).padStart(2, "0")}`,
    name,
    destinationId,
    provinceId: destination.provinceId,
    category,
    summary: `${destination.name}${label}体验候选，适合与同区域景点组合安排。`,
    location: {
      longitude: Number((destination.center.longitude + longitudeOffset).toFixed(4)),
      latitude: Number((destination.center.latitude + latitudeOffset).toFixed(4))
    },
    address: `${destination.name}旅行区域`,
    visitDurationMinutes: category === "shopping" ? 120 : 90 + (index % 3) * 30,
    tags: [...categoryCopy[category].tags, index < 3 ? "初次到访" : "深度体验"],
    tickets: [
      {
        id: `ticket-${destination.slug}-${category}-${index + 1}`,
        name: isFree ? "参观票" : "常规票",
        priceCny: isFree ? 0 : null,
        priceNote: isFree ? "免费，部分场馆可能需要预约" : "以景区当日公示为准"
      }
    ],
    checkedAt: "2026-07-30",
    sourceLabel: "行迹演示种子数据",
    status: "published"
  };
}

/** 从人工名录生成结构一致的第一版景点数据。 */
export const spots: Spot[] = Object.entries(citySpotCatalog).flatMap(([destinationId, catalog]) =>
  (Object.entries(catalog) as Array<[SpotCategory, string[]]>).flatMap(([category, names]) =>
    names.map((name, index) => buildSpot(destinationId, category, name, index))
  )
);
