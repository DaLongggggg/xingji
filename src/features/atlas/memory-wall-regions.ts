import type { BoundaryDataset } from "./boundary-contract";
import type { MemoryNote, MemoryRegion } from "./region-card-layout";
import { pointInGeometry } from "@/features/regions/photo-location";

/** 只派生当前市内的精确县级展示；省/市级关联及近界、歧义点均不推定县。 */
export function deriveCountyMemories(dataset: BoundaryDataset, pages: MemoryNote[]) {
  const regions: MemoryRegion[] = dataset.regions.map((region) => ({
    regionId: region.regionId,
    name: region.name,
    pages: []
  }));
  const byId = new Map(regions.map((region) => [region.regionId, region]));
  const unassigned: MemoryNote[] = [];
  for (const page of new Map(pages.map((page) => [page.pageId, page])).values()) {
    const matched = new Set<string>();
    for (const point of page.points ?? []) {
      const hits = dataset.features.filter((feature) =>
        pointInGeometry([point.lng, point.lat], feature.geometry)
      );
      if (hits.length === 1) matched.add(hits[0].regionId);
    }
    if (!matched.size) unassigned.push(page);
    for (const id of matched) byId.get(id)?.pages.push(page);
  }
  return { regions, unassigned };
}
