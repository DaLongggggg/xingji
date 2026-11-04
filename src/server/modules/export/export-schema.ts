import { z } from "zod";

export const tripExportRequestSchema = z.object({
  trip: z
    .object({
      id: z.string().max(120),
      schemaVersion: z.literal(1),
      name: z.string().max(100),
      destinationId: z.string().max(80)
    })
    .passthrough()
});
