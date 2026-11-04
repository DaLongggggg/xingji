"use client";

import type { BoundaryDataset, BoundaryGeometry } from "./boundary-contract";
import { labelAnchor } from "./region-label-layout";

type HarborRegion = {
  regionId: string;
  name: string;
  shortName: string;
  path: string;
  label: [number, number];
};

export type HarborMagnifierData = {
  /** 经度、纬度；主地图只用它标出放大区域，不移动真实边界。 */
  center: [number, number];
  regions: HarborRegion[];
};

const SIZE = 180;

function geometryRings(geometry: BoundaryGeometry): number[][][][] {
  return geometry.type === "Polygon"
    ? [geometry.coordinates as number[][][]]
    : geometry.coordinates as number[][][][];
}

/** 同一组经纬度投影到局部视图；几何形状与相对位置都来自当前数据包。 */
export function buildHarborMagnifier(dataset: BoundaryDataset): HarborMagnifierData | null {
  if (dataset.level !== "national") return null;
  const sources = [
    { id: "81", shortName: "香港" },
    { id: "82", shortName: "澳门" }
  ];
  const entries = sources.map((item) => {
    const region = dataset.regions.find((candidate) => candidate.sourceRegionId === item.id);
    const feature = dataset.features.find((candidate) => candidate.regionId === region?.regionId);
    return region && feature ? { ...item, region, geometry: feature.geometry } : null;
  });
  if (entries.some((entry) => !entry)) return null;
  const present = entries.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  const points = present.flatMap(({ geometry }) =>
    geometryRings(geometry).flatMap((polygon) => polygon.flatMap((ring) => ring))
  );
  if (points.length === 0) return null;
  const longitudes = points.map((point) => point[0]);
  const latitudes = points.map((point) => point[1]);
  const minLng = Math.min(...longitudes);
  const maxLng = Math.max(...longitudes);
  const minLat = Math.min(...latitudes);
  const maxLat = Math.max(...latitudes);
  if (![minLng, maxLng, minLat, maxLat].every(Number.isFinite) || minLng === maxLng || minLat === maxLat) return null;
  const center: [number, number] = [(minLng + maxLng) / 2, (minLat + maxLat) / 2];
  const scale = Math.min(140 / (maxLng - minLng), 122 / (maxLat - minLat));
  const project = ([lng, lat]: number[]): [number, number] => [
    SIZE / 2 + (lng - center[0]) * scale,
    SIZE / 2 - (lat - center[1]) * scale
  ];
  const regions = present.map(({ region, geometry, shortName }) => {
    const path = geometryRings(geometry).flatMap((polygon) => polygon.map((ring) =>
      ring.map((point, index) => {
        const [x, y] = project(point);
        return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
      }).join(" ") + " Z"
    )).join(" ");
    const anchor = labelAnchor(geometry);
    return { regionId: region.regionId, name: region.name, shortName, path,
      label: anchor ? project(anchor) : [SIZE / 2, SIZE / 2] as [number, number] };
  });
  return { center, regions };
}

export function HarborMagnifier({
  data,
  selectedRegionId,
  onSelectRegion,
  onDrillRegion
}: {
  data: HarborMagnifierData;
  selectedRegionId: string | null;
  onSelectRegion: (regionId: string) => void;
  onDrillRegion?: (regionId: string) => void;
}) {
  return (
    <section className="atlas-harbor-magnifier" aria-label="港澳局部放大图" data-testid="atlas-harbor-magnifier">
      <div className="atlas-harbor-lens">
        <svg viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label="香港和澳门真实轮廓的局部放大图">
          <defs>
            <clipPath id="atlas-harbor-clip"><circle cx="90" cy="90" r="87" /></clipPath>
          </defs>
          <circle cx="90" cy="90" r="87" className="atlas-harbor-sea" />
          <g clipPath="url(#atlas-harbor-clip)">
            <path className="atlas-harbor-grid"
              d="M30 0V180 M60 0V180 M90 0V180 M120 0V180 M150 0V180 M0 30H180 M0 60H180 M0 90H180 M0 120H180 M0 150H180" />
            {data.regions.map((region) => (
              <path key={region.regionId} d={region.path} fillRule="evenodd"
                className={`atlas-harbor-shape ${region.shortName === "香港" ? "is-hongkong" : "is-macau"}${selectedRegionId === region.regionId ? " is-selected" : ""}`} />
            ))}
            {data.regions.map((region) => (
              <g key={`${region.regionId}-label`} transform={`translate(${region.label[0].toFixed(1)} ${region.label[1].toFixed(1)})`}>
                <circle r="2.5" className="atlas-harbor-point" />
              </g>
            ))}
          </g>
          <circle cx="90" cy="90" r="87" className="atlas-harbor-lens-ring" />
        </svg>
        <span className="atlas-harbor-caption">港澳局部</span>
      </div>
      <div className="atlas-harbor-choices">
        {data.regions.map((region) => (
          <button key={region.regionId} type="button" aria-label={`查看${region.name}`}
            aria-pressed={selectedRegionId === region.regionId}
            title={`单击选择${region.shortName}，双击查看区级地图`}
            onClick={() => onSelectRegion(region.regionId)}
            onDoubleClick={() => onDrillRegion?.(region.regionId)}>
            <i className={region.shortName === "香港" ? "is-hongkong" : "is-macau"} aria-hidden />
            {region.shortName}
          </button>
        ))}
      </div>
    </section>
  );
}
