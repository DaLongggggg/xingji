import { z } from "zod";

export const tripPreviewSchema = z.object({
  destinationId: z.string().min(1).max(80),
  spotIds: z.array(z.string().min(1).max(100)).min(1).max(30),
  days: z.number().int().min(1).max(7),
  transportPreference: z.enum(["walk", "drive", "transit", "taxi", "mixed"]).default("mixed"),
  pace: z.enum(["relaxed", "balanced", "full"]).default("balanced")
});

export type TripPreviewInput = z.infer<typeof tripPreviewSchema>;
