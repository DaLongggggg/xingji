import type {
  DestinationRepository,
  ProvinceRepository
} from "@/server/repositories/content-repository";
import {
  destinationRepository,
  provinceRepository
} from "@/server/repositories/seed/seed-content-repository";

export class DestinationService {
  constructor(
    private readonly destinations: DestinationRepository,
    private readonly provinces: ProvinceRepository
  ) {}

  async search(query: string, limit = 10) {
    return this.destinations.search(query, limit);
  }

  async get(destinationId: string) {
    return this.destinations.get(destinationId);
  }

  async listPublished() {
    const allDestinations = await this.destinations.list();
    return allDestinations.filter((destination) => destination.status === "published");
  }

  async listProvinces() {
    return this.provinces.list();
  }
}

export const destinationService = new DestinationService(destinationRepository, provinceRepository);
