import type { DestinationRepository } from "@/server/repositories/content-repository";
import { destinationRepository } from "@/server/repositories/seed/seed-content-repository";
import type { AiProvider } from "@/server/providers/ai-provider";
import { aiProvider } from "@/server/providers/ai-provider";
import type { Spot, SpotCategory } from "@/server/shared/types";
import { rankingService, type RankingService } from "@/server/modules/ranking";

type RecommendationInput = {
  destinationId: string;
  categories: SpotCategory[];
  preferences: {
    themes: string[];
    pace: "relaxed" | "balanced" | "full";
    crowdPreference: "popular" | "avoid-crowds" | "either";
  };
};

export class AiService {
  constructor(
    private readonly destinations: DestinationRepository,
    private readonly rankings: RankingService,
    private readonly provider: AiProvider
  ) {}

  async recommend(input: RecommendationInput) {
    const rankingResults = await Promise.all(
      input.categories.map((category) => this.rankings.getRanking(input.destinationId, category))
    );
    const candidates = rankingResults
      .filter((ranking) => ranking !== null)
      .flatMap((ranking) => ranking.spots);
    const uniqueCandidates = [
      ...new Map(candidates.map((spot) => [spot.id, spot] as const)).values()
    ];
    const providerResult = await this.provider.rank({
      candidates: uniqueCandidates,
      ...input.preferences
    });

    const candidateById = new Map(uniqueCandidates.map((spot) => [spot.id, spot]));
    const orderedSpots = providerResult.orderedSpotIds
      .map((spotId) => candidateById.get(spotId))
      .filter((spot): spot is Spot => spot !== undefined);

    return {
      orderedSpots,
      reasonsBySpotId: Object.fromEntries(
        orderedSpots.map((spot) => [spot.id, providerResult.reasonsBySpotId[spot.id] ?? "综合推荐"])
      ),
      summary: providerResult.summary,
      fallbackUsed: true
    };
  }

  async chat(destinationId: string, message: string, tripName?: string) {
    const destination = await this.destinations.get(destinationId);
    if (!destination) {
      return null;
    }
    return this.provider.chat(message, destination.name, tripName);
  }
}

export const aiService = new AiService(destinationRepository, rankingService, aiProvider);
