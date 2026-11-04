import { z } from "zod";

export const aiRecommendationSchema = z.object({
  destinationId: z.string().min(1).max(80),
  categories: z
    .array(z.enum(["cultural", "natural", "shopping"]))
    .min(1)
    .max(3),
  preferences: z.object({
    themes: z.array(z.string().max(30)).max(8).default([]),
    pace: z.enum(["relaxed", "balanced", "full"]).default("balanced"),
    crowdPreference: z.enum(["popular", "avoid-crowds", "either"]).default("either")
  })
});

export const aiChatSchema = z.object({
  destinationId: z.string().min(1).max(80),
  message: z.string().trim().min(1).max(400),
  tripName: z.string().trim().max(100).optional()
});
