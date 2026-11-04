import type { SpotRepository } from "@/server/repositories/content-repository";
import { spotRepository } from "@/server/repositories/seed/seed-content-repository";

export class SpotService {
  constructor(private readonly spots: SpotRepository) {}

  async get(spotId: string) {
    return this.spots.get(spotId);
  }

  async getMany(spotIds: string[]) {
    const uniqueSpotIds = [...new Set(spotIds)];
    const resolved = await Promise.all(uniqueSpotIds.map((spotId) => this.spots.get(spotId)));
    return resolved.filter((spot) => spot !== null);
  }
}

export const spotService = new SpotService(spotRepository);
