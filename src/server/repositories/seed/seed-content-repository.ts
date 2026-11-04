import { destinations } from "@/data/seed/destinations";
import { provinces } from "@/data/seed/provinces";
import { validateSeedData } from "@/data/seed/seed-validation";
import { spots } from "@/data/seed/spots";
import type {
  DestinationRepository,
  ProvinceRepository,
  SpotRepository
} from "@/server/repositories/content-repository";
import type { Destination, Spot, SpotCategory } from "@/server/shared/types";

function normalizeSearchText(value: string): string {
  return value.trim().toLocaleLowerCase("zh-CN").replaceAll(/\s+/g, "");
}

validateSeedData();

function throwReadOnly(): never {
  throw new Error("Seed repositories are read-only");
}

/** 第一版只读目的地仓储。写方法保留接口，但生产演示固定拒绝。 */
export class SeedDestinationRepository implements DestinationRepository {
  async list(): Promise<Destination[]> {
    return destinations.map((destination) => ({ ...destination }));
  }

  async get(destinationId: string): Promise<Destination | null> {
    return destinations.find((destination) => destination.id === destinationId) ?? null;
  }

  async search(query: string, limit: number): Promise<Destination[]> {
    const normalizedQuery = normalizeSearchText(query);
    if (!normalizedQuery) {
      return [];
    }

    return destinations
      .map((destination) => {
        const searchableNames = [destination.name, ...destination.aliases].map(normalizeSearchText);
        const exactMatch = searchableNames.some((name) => name === normalizedQuery);
        const prefixMatch = searchableNames.some((name) => name.startsWith(normalizedQuery));
        return { destination, score: exactMatch ? 2 : prefixMatch ? 1 : 0 };
      })
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map(({ destination }) => destination);
  }

  async create(): Promise<Destination> {
    return throwReadOnly();
  }

  async update(): Promise<Destination> {
    return throwReadOnly();
  }

  async remove(): Promise<void> {
    return throwReadOnly();
  }
}

/** 第一版只读景点仓储。 */
export class SeedSpotRepository implements SpotRepository {
  async listByDestination(destinationId: string, category?: SpotCategory): Promise<Spot[]> {
    return spots.filter(
      (spot) => spot.destinationId === destinationId && (!category || spot.category === category)
    );
  }

  async listByProvince(provinceId: string, category?: SpotCategory): Promise<Spot[]> {
    return spots.filter(
      (spot) => spot.provinceId === provinceId && (!category || spot.category === category)
    );
  }

  async get(spotId: string): Promise<Spot | null> {
    return spots.find((spot) => spot.id === spotId) ?? null;
  }

  async create(): Promise<Spot> {
    return throwReadOnly();
  }

  async update(): Promise<Spot> {
    return throwReadOnly();
  }

  async remove(): Promise<void> {
    return throwReadOnly();
  }
}

/** 34 个省级行政区的只读仓储。 */
export class SeedProvinceRepository implements ProvinceRepository {
  async list() {
    return provinces.map((province) => ({ ...province }));
  }

  async get(provinceId: string) {
    return provinces.find((province) => province.id === provinceId) ?? null;
  }
}

export const destinationRepository = new SeedDestinationRepository();
export const spotRepository = new SeedSpotRepository();
export const provinceRepository = new SeedProvinceRepository();
