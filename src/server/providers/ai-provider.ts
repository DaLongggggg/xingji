import type { Spot } from "@/server/shared/types";

export type AiRankInput = {
  candidates: Spot[];
  themes: string[];
  pace: "relaxed" | "balanced" | "full";
  crowdPreference: "popular" | "avoid-crowds" | "either";
};

export type AiRankOutput = {
  orderedSpotIds: string[];
  reasonsBySpotId: Record<string, string>;
  summary: string;
};

export interface AiProvider {
  rank(input: AiRankInput): Promise<AiRankOutput>;
  chat(message: string, destinationName: string, tripName?: string): Promise<string>;
}

/** 无 API Key 时的可测试本地智能 Provider，不生成任何景点事实。 */
export class LocalAiProvider implements AiProvider {
  async rank(input: AiRankInput): Promise<AiRankOutput> {
    const preferredTags = new Set(input.themes);
    const scored = input.candidates.map((spot, index) => {
      const tagScore = spot.tags.filter((tag) => preferredTags.has(tag)).length * 3;
      const paceScore =
        input.pace === "relaxed"
          ? -spot.visitDurationMinutes / 180
          : spot.visitDurationMinutes / 240;
      const crowdScore =
        input.crowdPreference === "avoid-crowds" && spot.tags.includes("深度体验") ? 2 : 0;
      return { spot, score: tagScore + paceScore + crowdScore - index / 100 };
    });
    scored.sort((left, right) => right.score - left.score);

    return {
      orderedSpotIds: scored.map(({ spot }) => spot.id),
      reasonsBySpotId: Object.fromEntries(
        scored.map(({ spot }) => [
          spot.id,
          input.crowdPreference === "avoid-crowds" && spot.tags.includes("深度体验")
            ? "更符合避开热门人流、偏向深度体验的偏好。"
            : `结合${spot.tags.slice(0, 2).join("、")}标签和游览节奏重新排序。`
        ])
      ),
      summary: "当前使用本地智能规则在已核实候选池内重排；配置模型后可替换真实 AI Provider。"
    };
  }

  async chat(message: string, destinationName: string, tripName?: string): Promise<string> {
    const context = tripName ? `“${tripName}”` : `${destinationName}行程`;
    if (message.includes("轻松") || message.includes("累")) {
      return `可以把${context}每天控制在 2—3 个主要地点，并将距离最远的一项放入待安排清单。`;
    }
    if (message.includes("吃") || message.includes("美食")) {
      return `建议围绕每天路线中心选择本地风味类型，再用地图核对具体门店的营业时间和距离。`;
    }
    if (message.includes("交通") || message.includes("怎么去")) {
      return `当前交通为估算值。市区优先公共交通，远郊景点应单独预留往返时间，并在出发前用高德复核。`;
    }
    return `针对${context}，建议先确认每天最想保留的 1—2 个核心地点，再根据距离删减跨区往返。`;
  }
}

export const aiProvider = new LocalAiProvider();
