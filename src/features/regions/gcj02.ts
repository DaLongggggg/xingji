/**
 * WGS-84 → GCJ-02 坐标变换（M1.5：照片 GPS 与地图基准的对齐）。
 *
 * 背景与边界（2026-10-07 核对更新）：
 * - 照片 GPS 仅在声明为 WGS-84，或缺声明且采用明确工程假定时参与转换；
 *   非支持的 GPSMapDatum 在识别入口跳过，不将所有 EXIF 都当成 WGS-84。
 * - 全国/城市素材均未明确声明坐标系；城市上游记录了高德来源，故 GCJ-02
 *   属于谱系推定。2026-10-07 的六个公开城市参考点在转换前后均命中预期
 *   省市；广州/佛山近边界探针则出现不同归属。详见照片收尾坐标证据文档。
 *   内部参考点通过不能判定基准，几何 near 也不是定位误差的置信区间。
 * - 结论：GCJ-02 是**谱系推定**（高德来源+惯例），不是权威声明。确认式
 *   识别流程保留；自动关联规则已披露近界错配风险。若未来获得权威 WGS-84
 *   边界数据，移除本转换即可（单点接入 page-photo-location.tsx）。
 * - 算法是公开的 GCJ-02 偏移近似（国测局加密的社区逆向实现），零依赖；
 *   只用于**匹配**，照片原始 WGS-84 坐标不因此改写。
 * - **判定矩形外**恒等返回（GCJ-02 只在中国境内生效的常用近似）；矩形**内**
 *   的所有点都会被偏移——包括港澳，也包括河内等邻国城市（已知近似：矩形
 *   不区分国界，港澳与境外邻近点未单独豁免）。
 */

export type GeoCoordinate = { lat: number; lng: number };

const SEMI_MAJOR_AXIS = 6378245.0;
const ECCENTRICITY_SQUARED = 0.00669342162296594323;

/** GCJ-02 偏移的适用范围（常用近似矩形；港澳含在内）。 */
export function isWithinGcj02Region(lat: number, lng: number): boolean {
  return lng >= 72.004 && lng <= 137.8347 && lat >= 0.8293 && lat <= 55.8271;
}

function transformLat(x: number, y: number): number {
  let ret =
    -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) * 2.0) / 3.0;
  ret +=
    ((160.0 * Math.sin((y / 12.0) * Math.PI) + 320.0 * Math.sin((y * Math.PI) / 30.0)) * 2.0) /
    3.0;
  return ret;
}

function transformLng(x: number, y: number): number {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) * 2.0) / 3.0;
  ret +=
    ((150.0 * Math.sin((x / 12.0) * Math.PI) + 300.0 * Math.sin((x / 30.0) * Math.PI)) * 2.0) /
    3.0;
  return ret;
}

/** WGS-84 → GCJ-02（近似偏移）。判定矩形外原样返回。 */
export function wgs84ToGcj02(coordinate: GeoCoordinate): GeoCoordinate {
  const { lat, lng } = coordinate;
  if (!isWithinGcj02Region(lat, lng)) return { lat, lng };
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - ECCENTRICITY_SQUARED * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((SEMI_MAJOR_AXIS * (1 - ECCENTRICITY_SQUARED)) / (magic * sqrtMagic)) * Math.PI);
  dLng = (dLng * 180.0) / ((SEMI_MAJOR_AXIS / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return { lat: lat + dLat, lng: lng + dLng };
}

/**
 * GCJ-02 → WGS-84（一次迭代的近似逆变换；仅测试与诊断用——
 * 正式链路只需要 WGS-84 → GCJ-02 单向）。
 */
export function gcj02ToWgs84Approx(coordinate: GeoCoordinate): GeoCoordinate {
  if (!isWithinGcj02Region(coordinate.lat, coordinate.lng)) return { ...coordinate };
  const gcj = wgs84ToGcj02(coordinate);
  return {
    lat: coordinate.lat * 2 - gcj.lat,
    lng: coordinate.lng * 2 - gcj.lng
  };
}
