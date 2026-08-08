import { z } from "zod";

export const ActiveTargetProfileSchema = z.object({
  profileId: z.string().uuid(),
  updatedAt: z.date(),
});

export type ActiveTargetProfile = z.infer<typeof ActiveTargetProfileSchema>;
