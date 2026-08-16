import type { TargetProfile } from "@silly-rabbit/shared";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "./app.js";
import type { ActiveTargetProfileRepo } from "./repos/activeTargetProfileRepo.js";
import type { TargetProfileRepo } from "./repos/targetProfileRepo.js";

const TargetProfileWriteBodySchema = z.object({
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
});

const TargetProfilePatchBodySchema = TargetProfileWriteBodySchema.partial();

/**
 * Credential values (email/password) must never reach the client, under any field name,
 * in any response — write-only inputs by design. This is the single choke point every
 * route below returns through.
 */
type SafeTargetProfile = Omit<TargetProfile, "email" | "password">;

function toSafeProfile(profile: TargetProfile): SafeTargetProfile {
  const {
    id,
    name,
    baseUrl,
    loginUrl,
    emailSelector,
    passwordSelector,
    submitSelector,
    nextSelector,
    timeoutMs,
    loginReadyTimeoutMs,
    locationsPath,
    allowedDomains,
    createdAt,
    updatedAt,
  } = profile;
  return {
    id,
    name,
    baseUrl,
    loginUrl,
    emailSelector,
    passwordSelector,
    submitSelector,
    nextSelector,
    timeoutMs,
    loginReadyTimeoutMs,
    locationsPath,
    allowedDomains,
    createdAt,
    updatedAt,
  };
}

function requireTargetProfileRepo(deps: AppDeps): TargetProfileRepo {
  if (!deps.targetProfileRepo) {
    throw new Error("targetProfileRepo not configured");
  }
  return deps.targetProfileRepo;
}

function requireActiveTargetProfileRepo(deps: AppDeps): ActiveTargetProfileRepo {
  if (!deps.activeTargetProfileRepo) {
    throw new Error("activeTargetProfileRepo not configured");
  }
  return deps.activeTargetProfileRepo;
}

export function registerTargetProfileRoutes(app: FastifyInstance, deps: AppDeps): void {
  const targetProfileRepo = requireTargetProfileRepo(deps);
  const activeTargetProfileRepo = requireActiveTargetProfileRepo(deps);

  app.get("/target-profiles", async () => (await targetProfileRepo.list()).map(toSafeProfile));

  app.get("/target-profiles/active", async () => {
    const pointer = await activeTargetProfileRepo.get();
    return { profileId: pointer?.profileId ?? null };
  });

  app.get<{ Params: { id: string } }>("/target-profiles/:id", async (request, reply) => {
    const profile = await targetProfileRepo.get(request.params.id);
    if (!profile) {
      return reply.status(404).send({ error: "target profile not found" });
    }
    return toSafeProfile(profile);
  });

  app.post("/target-profiles", async (request, reply) => {
    const parsed = TargetProfileWriteBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid request body", details: parsed.error.flatten() });
    }

    const now = new Date();
    const profile: TargetProfile = { id: randomUUID(), ...parsed.data, createdAt: now, updatedAt: now };
    await targetProfileRepo.create(profile);
    return reply.status(201).send(toSafeProfile(profile));
  });

  app.put<{ Params: { id: string } }>("/target-profiles/:id", async (request, reply) => {
    const existing = await targetProfileRepo.get(request.params.id);
    if (!existing) {
      return reply.status(404).send({ error: "target profile not found" });
    }

    const parsed = TargetProfilePatchBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid request body", details: parsed.error.flatten() });
    }

    await targetProfileRepo.update(request.params.id, parsed.data);
    const updated = await targetProfileRepo.get(request.params.id);
    return reply.status(200).send(toSafeProfile(updated as TargetProfile));
  });

  app.delete<{ Params: { id: string } }>("/target-profiles/:id", async (request, reply) => {
    const existing = await targetProfileRepo.get(request.params.id);
    if (!existing) {
      return reply.status(404).send({ error: "target profile not found" });
    }

    const activePointer = await activeTargetProfileRepo.get();
    if (activePointer?.profileId === request.params.id) {
      return reply.status(409).send({ error: "cannot delete the active target profile — deactivate it first" });
    }

    await targetProfileRepo.delete(request.params.id);
    return reply.status(204).send();
  });

  app.post<{ Params: { id: string } }>("/target-profiles/:id/activate", async (request, reply) => {
    const existing = await targetProfileRepo.get(request.params.id);
    if (!existing) {
      return reply.status(404).send({ error: "target profile not found" });
    }

    await activeTargetProfileRepo.set(request.params.id);
    return reply.status(204).send();
  });

  app.delete("/target-profiles/active", async (_request, reply) => {
    await activeTargetProfileRepo.clear();
    return reply.status(204).send();
  });
}
