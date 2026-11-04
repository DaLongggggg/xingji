import type { PhotoInfo } from "./photo-info";

const ORIENTATION: Record<number, string> = {
  1: "正常", 2: "水平镜像", 3: "旋转 180°", 4: "垂直镜像",
  5: "转置", 6: "顺时针 90°", 7: "横向转置", 8: "逆时针 90°"
};

/** 字段都是不可信的照片资料；React 按纯文本显示，不执行 HTML 或设备自述。 */
export function PhotoInfoPanel({ info }: { info?: PhotoInfo }) {
  if (!info) return <p className="photo-info-panel" role="status">正在读取照片信息…</p>;
  if (info.status !== "ready") return <p className="photo-info-panel" role="status">
    {info.status === "unsupported" ? "暂不支持读取此来源的照片信息。" : "照片信息暂不可读；原图仍可保留和下载。"}
  </p>;
  const missing = "未提供";
  const entries = [
    ["格式", info.format?.toUpperCase() ?? missing],
    ["文件大小", `${(info.bytes / 1024 ** 2).toFixed(2)} MiB`],
    ["像素尺寸", info.width && info.height ? `${info.width} × ${info.height}` : missing],
    ["位深", info.bitDepth ? `${info.bitDepth} bit` : missing],
    ["拍摄时间", info.capturedAt ? `${info.capturedAt.value}（${info.capturedAt.offset ?? "时区未提供"}）` : missing],
    ["位置", info.gps ? `${info.gps.lat.toFixed(6)}, ${info.gps.lng.toFixed(6)}（${info.gps.datum ?? "基准未声明"}）` : missing],
    ["显示方向", info.orientation ? `${ORIENTATION[info.orientation]}（EXIF ${info.orientation}）` : missing],
    ["拍摄朝向", info.heading ? `${info.heading.degrees}°（${info.heading.reference === "true" ? "真北" : "磁北"}）` : missing],
    ["设备", [info.device.make, info.device.model].filter(Boolean).join(" · ") || missing],
    ["镜头", info.device.lens ?? missing]
  ];
  return <div className="photo-info-panel" aria-label="照片信息内容">
    <dl>{entries.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
  </div>;
}
