import type {
  DestinationRepository,
  SpotRepository
} from "@/server/repositories/content-repository";
import {
  destinationRepository,
  spotRepository
} from "@/server/repositories/seed/seed-content-repository";
import type { NearbyProvider } from "@/server/providers/nearby-provider";
import { nearbyProvider } from "@/server/providers/nearby-provider";
import type { RouteProvider } from "@/server/providers/route-provider";
import { routeProvider } from "@/server/providers/route-provider";
import type {
  GeoPoint,
  LodgingArea,
  Spot,
  TransportMode,
  TripDay,
  TripDraft,
  TripStop
} from "@/server/shared/types";
import type { TripPreviewInput } from "./trip-schema";

function averagePoint(spots: Spot[]): GeoPoint {
  return {
    longitude: spots.reduce((total, spot) => total + spot.location.longitude, 0) / spots.length,
    latitude: spots.reduce((total, spot) => total + spot.location.latitude, 0) / spots.length
  };
}

function sortForRoute(spots: Spot[]): Spot[] {
  return [...spots].sort(
    (left, right) =>
      left.location.longitude +
      left.location.latitude -
      right.location.longitude -
      right.location.latitude
  );
}

function divideIntoDays(spots: Spot[], days: number): Spot[][] {
  const groups = Array.from({ length: days }, () => [] as Spot[]);
  spots.forEach((spot, index) => {
    groups[index % days].push(spot);
  });
  return groups;
}

function resolveTransportMode(
  preference: TripPreviewInput["transportPreference"],
  stopCount: number
): TransportMode {
  if (preference !== "mixed") {
    return preference;
  }
  return stopCount <= 2 ? "walk" : "transit";
}

export class TripService {
  constructor(
    private readonly destinations: DestinationRepository,
    private readonly spots: SpotRepository,
    private readonly routes: RouteProvider,
    private readonly nearby: NearbyProvider
  ) {}

  /** 构建一个地级目的地区域内的 1 至 7 天行程草稿。 */
  async preview(input: TripPreviewInput): Promise<TripDraft> {
    const destination = await this.destinations.get(input.destinationId);
    if (!destination) {
      throw new Error("DESTINATION_NOT_FOUND");
    }
    if (destination.level !== "prefecture") {
      throw new Error("TRIP_REQUIRES_PREFECTURE");
    }

    const uniqueSpotIds = [...new Set(input.spotIds)];
    const resolvedSpots = (
      await Promise.all(uniqueSpotIds.map((spotId) => this.spots.get(spotId)))
    ).filter((spot): spot is Spot => spot !== null);
    if (resolvedSpots.length !== uniqueSpotIds.length) {
      throw new Error("SPOT_NOT_FOUND");
    }
    if (resolvedSpots.some((spot) => spot.destinationId !== destination.id)) {
      throw new Error("SPOT_OUTSIDE_DESTINATION");
    }

    const sortedSpots = sortForRoute(resolvedSpots);
    const dayGroups = divideIntoDays(sortedSpots, input.days);
    const itineraryDays: TripDay[] = [];

    for (const [dayIndex, daySpots] of dayGroups.entries()) {
      const stops: TripStop[] = daySpots.map((spot, stopIndex) => ({
        id: `stop-${dayIndex + 1}-${stopIndex + 1}-${spot.id}`,
        spot,
        order: stopIndex + 1,
        stayMinutes:
          input.pace === "relaxed"
            ? Math.round(spot.visitDurationMinutes * 1.2)
            : input.pace === "full"
              ? Math.round(spot.visitDurationMinutes * 0.85)
              : spot.visitDurationMinutes
      }));
      const center = daySpots.length > 0 ? averagePoint(daySpots) : destination.center;
      const routeLegs = [];
      const mode = resolveTransportMode(input.transportPreference, stops.length);
      for (let index = 0; index < stops.length - 1; index += 1) {
        routeLegs.push(await this.routes.buildLeg(stops[index], stops[index + 1], mode));
      }
      const lodgingArea: LodgingArea = {
        name: `${destination.name}第 ${dayIndex + 1} 天路线中心区`,
        center,
        reason: "根据当天景点坐标中心估算，优先减少跨区往返。"
      };
      itineraryDays.push({
        dayNumber: dayIndex + 1,
        stops,
        routeLegs,
        lodgingArea,
        nearbyPlaces: await this.nearby.list(destination, center)
      });
    }

    const timestamp = new Date().toISOString();
    return {
      id: `trip-${destination.slug}-${Date.now()}`,
      schemaVersion: 1,
      name: `${destination.name} ${input.days} 日行迹`,
      destinationId: destination.id,
      destinationName: destination.name,
      days: input.days,
      transportPreference: input.transportPreference,
      status: "ready",
      itineraryDays,
      unassignedSpotIds: [],
      warnings: ["交通时间与费用为本地估算，真实出行前请通过高德地图复核。"],
      createdAt: timestamp,
      updatedAt: timestamp
    };
  }
}

export const tripService = new TripService(
  destinationRepository,
  spotRepository,
  routeProvider,
  nearbyProvider
);
