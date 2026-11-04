import type { TripDraft } from "@/server/shared/types";

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function exportTripJson(trip: TripDraft): void {
  const payload = {
    app: "xingji",
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    trip
  };
  downloadBlob(
    new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" }),
    `行迹-${trip.destinationName}.json`
  );
}

/** 使用 Canvas 绘制纯文本行程长图，避免把第三方地图或远程图片混入导出。 */
export async function exportTripPng(trip: TripDraft): Promise<void> {
  const lines = [
    trip.name,
    `${trip.destinationName} · ${trip.days} 日`,
    ...trip.itineraryDays.flatMap((day) => [
      "",
      `DAY ${day.dayNumber}｜${day.stops.length > 0 ? day.stops.map((stop) => stop.spot.name).join(" → ") : "自由活动"}`,
      `住宿建议：${day.lodgingArea.name}`,
      `美食方向：${day.nearbyPlaces
        .filter((place) => place.kind === "food")
        .map((place) => place.name)
        .join("、")}`
    ]),
    "",
    "交通为演示估算，请在真实出行前复核｜行迹 xingji"
  ];
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = Math.max(900, 220 + lines.length * 58);
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("CANVAS_UNAVAILABLE");
  }
  const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
  gradient.addColorStop(0, "#fff7ed");
  gradient.addColorStop(1, "#ecfeff");
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#15251f";
  context.font = "700 50px sans-serif";
  context.fillText("行迹", 90, 100);
  context.font = "700 38px sans-serif";
  context.fillText(trip.name, 90, 175);
  context.font = "26px sans-serif";
  lines.slice(1).forEach((line, index) => {
    context.fillStyle = line.startsWith("DAY") ? "#ea580c" : "#3c4a44";
    context.fillText(line.slice(0, 52), 90, 245 + index * 58);
  });
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) {
    throw new Error("PNG_EXPORT_FAILED");
  }
  downloadBlob(blob, `行迹-${trip.destinationName}.png`);
}

/** 浏览器打印样式只保留行程内容，用户可在系统对话框中保存为 PDF。 */
export function exportTripPdf(): void {
  window.print();
}
