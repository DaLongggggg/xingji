import { z } from "zod";

export const destinationSearchSchema = z.object({
  q: z.string().trim().min(1).max(40),
  limit: z.coerce.number().int().min(1).max(20).default(10)
});
