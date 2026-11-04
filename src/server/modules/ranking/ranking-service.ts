import type {
  DestinationRepository,
  SpotRepository
} from "@/server/repositories/content-repository";
import {
  destinationRepository,
  spotRepository
} from "@/server/repositories/seed/seed-content-repository";
import type { Ranking, Spot, SpotCategory } from "@/server/shared/types";

function selectRoundRobin(spots: Spot[], limit: number): Spot[] {
  const groups = new Map<string, Spot[]>();
  for (const spot of spots) {
    groups.set(spot.destinationId, [...(groups.get(spot.destinationId) ?? []), spot]);
  }

  const selected: Spot[] = [];
  const groupValues = [...groups.values()];
  let rowIndex = 0;
  while (selected.length < limit && groupValues.some((group) => rowIndex < group.length)) {
    for (const group of groupValues) {
      const spot = group[rowIndex];
      if (spot && selected.length < limit) {
        selected.push(spot);
      }
    }
    rowIndex += 1;
  }
  return selected;
}

export class RankingService {
  constructor(
    private readonly destinations: DestinationRepository,
    private readonly spots: SpotRepository
  ) {}

  async getRanking(destinationId: string, category: SpotCategory): Promise<Ranking | null> {
    const destination = await this.destinations.get(destinationId);
    if (!destination) {
      return null;
    }
    if (category === "shopping" && destination.level === "province") {
      return null;
    }

    const limit = category === "shopping" ? 5 : 10;
    const candidates =
      destination.level === "province"
        ? await this.spots.listByProvince(destination.provinceId, category)
        : await this.spots.listByDestination(destinationId, category);
    const rankingSpots =
      destination.level === "province"
        ? selectRoundRobin(candidates, limit)
        : candidates.slice(0, limit);

    return {
      id: `ranking-${destination.slug}-${category}-v1`,
      destinationId,
      category,
      title: `${destination.name}${category === "cultural" ? "人文" : category === "natural" ? "自然" : "逛街"} TOP ${limit}`,
      method: "curated",
      version: 1,
      spots: rankingSpots
    };
  }

  async getAll(destinationId: string): Promise<Ranking[]> {
    const destination = await this.destinations.get(destinationId);
    if (!destination) {
      return [];
    }
    const categories: SpotCategory[] =
      destination.level === "province"
        ? ["cultural", "natural"]
        : ["cultural", "natural", "shopping"];
    const rankings = await Promise.all(
      categories.map((category) => this.getRanking(destinationId, category))
    );
    return rankings.filter((ranking) => ranking !== null);
  }
}

export const rankingService = new RankingService(destinationRepository, spotRepository);
