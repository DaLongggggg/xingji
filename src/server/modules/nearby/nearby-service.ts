import type { DestinationRepository } from "@/server/repositories/content-repository";
import { destinationRepository } from "@/server/repositories/seed/seed-content-repository";
import type { NearbyProvider } from "@/server/providers/nearby-provider";
import { nearbyProvider } from "@/server/providers/nearby-provider";
import type { GeoPoint } from "@/server/shared/types";

export class NearbyService {
  constructor(
    private readonly destinations: DestinationRepository,
    private readonly provider: NearbyProvider
  ) {}

  async list(destinationId: string, center: GeoPoint) {
    const destination = await this.destinations.get(destinationId);
    if (!destination) {
      return null;
    }
    return this.provider.list(destination, center);
  }
}

export const nearbyService = new NearbyService(destinationRepository, nearbyProvider);
