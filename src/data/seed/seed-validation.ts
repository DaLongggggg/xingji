import { z } from "zod";
import { destinations } from "./destinations";
import { provinces } from "./provinces";
import { spots } from "./spots";

const geoPointSchema = z.object({
  longitude: z.number().min(70).max(140),
  latitude: z.number().min(0).max(60)
});

const provinceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  shortName: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  adminCode: z.string().min(1),
  isFeatured: z.boolean(),
  status: z.enum(["published", "building"])
});

const destinationSchema = z.object({
  id: z.string().min(1),
  provinceId: z.string().min(1),
  name: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  level: z.enum(["province", "prefecture"]),
  center: geoPointSchema,
  mapZoom: z.number().min(3).max(18),
  scopeNote: z.string().min(1),
  aliases: z.array(z.string().min(1)),
  status: z.enum(["published", "building"])
});

const spotSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  destinationId: z.string().min(1),
  provinceId: z.string().min(1),
  category: z.enum(["cultural", "natural", "shopping"]),
  summary: z.string().min(1),
  location: geoPointSchema,
  address: z.string().min(1),
  visitDurationMinutes: z.number().int().positive(),
  tags: z.array(z.string().min(1)).min(1),
  tickets: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        priceCny: z.number().nonnegative().nullable(),
        priceNote: z.string().optional()
      })
    )
    .min(1),
  checkedAt: z.iso.date(),
  sourceLabel: z.string().min(1),
  status: z.literal("published")
});

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} contains duplicate values`);
  }
}

/** 构建启动时校验种子结构、引用和第一版数量边界。 */
export function validateSeedData(): void {
  z.array(provinceSchema).length(34).parse(provinces);
  z.array(destinationSchema).parse(destinations);
  z.array(spotSchema).parse(spots);
  assertUnique(
    provinces.map((province) => province.id),
    "Province IDs"
  );
  assertUnique(
    destinations.map((destination) => destination.id),
    "Destination IDs"
  );
  assertUnique(
    spots.map((spot) => spot.id),
    "Spot IDs"
  );

  const provinceIds = new Set(provinces.map((province) => province.id));
  const destinationIds = new Set(destinations.map((destination) => destination.id));
  for (const destination of destinations) {
    if (!provinceIds.has(destination.provinceId)) {
      throw new Error(`Destination ${destination.id} references an unknown province`);
    }
  }
  for (const spot of spots) {
    if (!destinationIds.has(spot.destinationId) || !provinceIds.has(spot.provinceId)) {
      throw new Error(`Spot ${spot.id} has an invalid destination or province reference`);
    }
  }

  const cityDestinations = destinations.filter((destination) => destination.level === "prefecture");
  for (const destination of cityDestinations) {
    const destinationSpots = spots.filter((spot) => spot.destinationId === destination.id);
    const categoryCounts = {
      cultural: destinationSpots.filter((spot) => spot.category === "cultural").length,
      natural: destinationSpots.filter((spot) => spot.category === "natural").length,
      shopping: destinationSpots.filter((spot) => spot.category === "shopping").length
    };
    if (
      categoryCounts.cultural !== 10 ||
      categoryCounts.natural !== 10 ||
      categoryCounts.shopping !== 5
    ) {
      throw new Error(`Destination ${destination.id} does not satisfy 10/10/5 content counts`);
    }
  }
}
