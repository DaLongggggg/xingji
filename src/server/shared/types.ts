/** 行迹内部统一使用的经纬度坐标。 */
export type GeoPoint = {
  longitude: number;
  latitude: number;
};

export type PublishStatus = "draft" | "published" | "building" | "archived";

export type SpotCategory = "cultural" | "natural" | "shopping";

export type Ticket = {
  id: string;
  name: string;
  priceCny: number | null;
  priceNote?: string;
};

export type Province = {
  id: string;
  name: string;
  shortName: string;
  slug: string;
  adminCode: string;
  isFeatured: boolean;
  status: "published" | "building";
};

export type Destination = {
  id: string;
  provinceId: string;
  name: string;
  slug: string;
  level: "province" | "prefecture";
  center: GeoPoint;
  mapZoom: number;
  scopeNote: string;
  aliases: string[];
  status: "published" | "building";
};

export type Spot = {
  id: string;
  name: string;
  destinationId: string;
  provinceId: string;
  category: SpotCategory;
  summary: string;
  location: GeoPoint;
  address: string;
  visitDurationMinutes: number;
  tags: string[];
  tickets: Ticket[];
  checkedAt: string;
  sourceLabel: string;
  status: "published";
};

export type Ranking = {
  id: string;
  destinationId: string;
  category: SpotCategory;
  title: string;
  method: "curated" | "ai-reranked";
  version: number;
  spots: Spot[];
};

export type TransportMode = "walk" | "drive" | "transit" | "taxi";

export type RouteLeg = {
  id: string;
  fromStopId: string;
  toStopId: string;
  mode: TransportMode;
  distanceMeters: number;
  durationMinutes: number;
  costCny: number;
  status: "ready" | "estimated" | "unavailable";
  provider: "local-estimate" | "amap";
};

export type TripStop = {
  id: string;
  spot: Spot;
  order: number;
  stayMinutes: number;
};

export type NearbyPlace = {
  id: string;
  name: string;
  kind: "food" | "hotel";
  location: GeoPoint;
  recommendationNote: string;
  sourceLabel: string;
};

export type LodgingArea = {
  name: string;
  center: GeoPoint;
  reason: string;
};

export type TripDay = {
  dayNumber: number;
  stops: TripStop[];
  routeLegs: RouteLeg[];
  lodgingArea: LodgingArea;
  nearbyPlaces: NearbyPlace[];
};

export type TripDraft = {
  id: string;
  schemaVersion: 1;
  name: string;
  destinationId: string;
  destinationName: string;
  days: number;
  transportPreference: TransportMode | "mixed";
  status: "ready";
  itineraryDays: TripDay[];
  unassignedSpotIds: string[];
  warnings: string[];
  createdAt: string;
  updatedAt: string;
};
