import type { Destination, Province, Spot, SpotCategory } from "@/server/shared/types";

/** 目的地仓储公开契约，后续数据库实现必须保持相同行为。 */
export interface DestinationRepository {
  list(): Promise<Destination[]>;
  get(destinationId: string): Promise<Destination | null>;
  search(query: string, limit: number): Promise<Destination[]>;
  create(destination: Destination): Promise<Destination>;
  update(destinationId: string, patch: Partial<Destination>): Promise<Destination>;
  remove(destinationId: string): Promise<void>;
}

/** 景点仓储公开契约。 */
export interface SpotRepository {
  listByDestination(destinationId: string, category?: SpotCategory): Promise<Spot[]>;
  listByProvince(provinceId: string, category?: SpotCategory): Promise<Spot[]>;
  get(spotId: string): Promise<Spot | null>;
  create(spot: Spot): Promise<Spot>;
  update(spotId: string, patch: Partial<Spot>): Promise<Spot>;
  remove(spotId: string): Promise<void>;
}

/** 省级行政区仓储公开契约。 */
export interface ProvinceRepository {
  list(): Promise<Province[]>;
  get(provinceId: string): Promise<Province | null>;
}
