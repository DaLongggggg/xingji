import type { GeoPoint, RouteLeg, TransportMode, TripStop } from "@/server/shared/types";

export interface RouteProvider {
  buildLeg(from: TripStop, to: TripStop, mode: TransportMode): Promise<RouteLeg>;
}

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

/** 使用 Haversine 公式估算两点直线距离，单位为米。 */
export function calculateDistanceMeters(from: GeoPoint, to: GeoPoint): number {
  const earthRadiusMeters = 6_371_000;
  const latitudeDelta = toRadians(to.latitude - from.latitude);
  const longitudeDelta = toRadians(to.longitude - from.longitude);
  const startLatitude = toRadians(from.latitude);
  const endLatitude = toRadians(to.latitude);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(startLatitude) * Math.cos(endLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return Math.round(2 * earthRadiusMeters * Math.asin(Math.sqrt(haversine)));
}

const modeSpeedKmh: Record<TransportMode, number> = {
  walk: 4.5,
  drive: 30,
  transit: 20,
  taxi: 28
};

/** 无高德 Key 时使用的确定性路线估算，界面必须标记为估算。 */
export class LocalRouteProvider implements RouteProvider {
  async buildLeg(from: TripStop, to: TripStop, mode: TransportMode): Promise<RouteLeg> {
    const straightDistance = calculateDistanceMeters(from.spot.location, to.spot.location);
    const roadFactor = mode === "walk" ? 1.18 : 1.35;
    const distanceMeters = Math.max(300, Math.round(straightDistance * roadFactor));
    const durationMinutes = Math.max(
      5,
      Math.round((distanceMeters / 1000 / modeSpeedKmh[mode]) * 60)
    );
    const costCny =
      mode === "walk" ? 0 : mode === "transit" ? 4 : Math.max(12, Math.round(distanceMeters / 900));

    return {
      id: `leg-${from.id}-${to.id}`,
      fromStopId: from.id,
      toStopId: to.id,
      mode,
      distanceMeters,
      durationMinutes,
      costCny,
      status: "estimated",
      provider: "local-estimate"
    };
  }
}

export const routeProvider = new LocalRouteProvider();
