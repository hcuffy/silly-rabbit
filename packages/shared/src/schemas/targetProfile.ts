import { z } from "zod";

export const TargetProfileSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  baseUrl: z.string().url(),
  loginUrl: z.string().url().optional(),
  email: z.string().optional(),
  password: z.string().optional(),
  emailSelector: z.string().optional(),
  passwordSelector: z.string().optional(),
  submitSelector: z.string().optional(),
  nextSelector: z.string().optional(),
  timeoutMs: z.number().optional(),
  loginReadyTimeoutMs: z.number().optional(),
  locationsPath: z.string().optional(),
  allowedDomains: z.array(z.string()).min(1),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type TargetProfile = z.infer<typeof TargetProfileSchema>;
