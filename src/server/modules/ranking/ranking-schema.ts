import { z } from "zod";

export const rankingCategorySchema = z.enum(["cultural", "natural", "shopping"]);
