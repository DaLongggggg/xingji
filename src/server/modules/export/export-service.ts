type TripExportInput = {
  id: string;
  schemaVersion: 1;
  name: string;
  destinationId: string;
  [key: string]: unknown;
};

export class ExportService {
  buildJson(trip: TripExportInput) {
    return {
      app: "xingji" as const,
      schemaVersion: 1 as const,
      exportedAt: new Date().toISOString(),
      trip
    };
  }
}

export const exportService = new ExportService();
