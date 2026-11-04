import type { TripDraft } from "@/server/shared/types";

export const MAX_SAVED_TRIPS = 10;
const STORAGE_KEY = "xingji:trips:v1";
const MAX_IMPORT_BYTES = 256 * 1024;

function isTripDraft(value: unknown): value is TripDraft {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<TripDraft>;
  return (
    typeof candidate.id === "string" &&
    candidate.schemaVersion === 1 &&
    typeof candidate.name === "string" &&
    Array.isArray(candidate.itineraryDays)
  );
}

export function loadTrips(storage: Pick<Storage, "getItem"> = localStorage): TripDraft[] {
  try {
    const rawValue = storage.getItem(STORAGE_KEY);
    if (!rawValue) {
      return [];
    }
    const parsed: unknown = JSON.parse(rawValue);
    return Array.isArray(parsed) ? parsed.filter(isTripDraft).slice(0, MAX_SAVED_TRIPS) : [];
  } catch {
    return [];
  }
}

export function saveTrip(
  trip: TripDraft,
  storage: Pick<Storage, "getItem" | "setItem"> = localStorage
): TripDraft[] {
  const existing = loadTrips(storage as Storage);
  const withoutCurrent = existing.filter((candidate) => candidate.id !== trip.id);
  if (withoutCurrent.length >= MAX_SAVED_TRIPS) {
    throw new Error("TRIP_LIMIT_REACHED");
  }
  const nextTrips = [trip, ...withoutCurrent];
  storage.setItem(STORAGE_KEY, JSON.stringify(nextTrips));
  return nextTrips;
}

export function removeTrip(
  tripId: string,
  storage: Pick<Storage, "getItem" | "setItem"> = localStorage
): TripDraft[] {
  const nextTrips = loadTrips(storage as Storage).filter((trip) => trip.id !== tripId);
  storage.setItem(STORAGE_KEY, JSON.stringify(nextTrips));
  return nextTrips;
}

/** 读取行迹 JSON 导出文件；只验证当前版本需要的安全边界和基础结构。 */
export async function importTripFile(file: File): Promise<TripDraft> {
  if (file.size > MAX_IMPORT_BYTES) {
    throw new Error("IMPORT_FILE_TOO_LARGE");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new Error("IMPORT_INVALID_JSON");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("IMPORT_INVALID_SCHEMA");
  }
  const payload = parsed as { app?: unknown; schemaVersion?: unknown; trip?: unknown };
  if (payload.app !== "xingji" || payload.schemaVersion !== 1 || !isTripDraft(payload.trip)) {
    throw new Error("IMPORT_INVALID_SCHEMA");
  }
  return payload.trip;
}
