import { CycleSchema, computeFindingStats, computeJudgeAccuracy, type Cycle } from "@silly-rabbit/shared";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "./app.js";
import type { ActiveCycleRepo } from "./repos/activeCycleRepo.js";
import type { CycleRepo } from "./repos/cycleRepo.js";

const CreateCycleBodySchema = z.object({
  name: z.string().trim().min(1),
  kind: z.enum(["sprint", "release"]),
});

const CyclesListQuerySchema = z.object({
  status: z.enum(["active", "archived"]).optional(),
});

function requireCycleRepo(deps: AppDeps): CycleRepo {
  if (!deps.cycleRepo) {
    throw new Error("cycleRepo not configured");
  }
  return deps.cycleRepo;
}

function requireActiveCycleRepo(deps: AppDeps): ActiveCycleRepo {
  if (!deps.activeCycleRepo) {
    throw new Error("activeCycleRepo not configured");
  }
  return deps.activeCycleRepo;
}

export function registerCycleRoutes(app: FastifyInstance, deps: AppDeps): void {
  const cycleRepo = requireCycleRepo(deps);
  const activeCycleRepo = requireActiveCycleRepo(deps);

  app.get<{ Querystring: { status?: string } }>("/cycles", async (request, reply) => {
    const parsed = CyclesListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid query parameters", details: parsed.error.flatten() });
    }
    return cycleRepo.list(parsed.data);
  });

  app.get("/cycles/active", async () => {
    const pointer = await activeCycleRepo.get();
    return { cycleId: pointer?.cycleId ?? null };
  });

  app.get<{ Params: { id: string } }>("/cycles/:id", async (request, reply) => {
    const cycle = await cycleRepo.get(request.params.id);
    if (!cycle) {
      return reply.status(404).send({ error: "cycle not found" });
    }
    return cycle;
  });

  app.post("/cycles", async (request, reply) => {
    const parsed = CreateCycleBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid request body", details: parsed.error.flatten() });
    }

    const cycle: Cycle = CycleSchema.parse({
      id: randomUUID(),
      name: parsed.data.name,
      kind: parsed.data.kind,
      status: "active",
      isDefault: false,
      runCounter: 0,
      sessionReplayRunCounter: 0,
      createdAt: new Date(),
    });
    await cycleRepo.create(cycle);
    return reply.status(201).send(cycle);
  });

  app.post<{ Params: { id: string } }>("/cycles/:id/archive", async (request, reply) => {
    const cycle = await cycleRepo.get(request.params.id);
    if (!cycle) {
      return reply.status(404).send({ error: "cycle not found" });
    }

    if (cycle.isDefault) {
      return reply.status(409).send({ error: "the Uncategorized cycle cannot be archived" });
    }

    const archived = await cycleRepo.archive(request.params.id);
    if (!archived) {
      return reply.status(409).send({ error: `cycle is already ${cycle.status}, cannot archive` });
    }
    return reply.status(200).send(await cycleRepo.get(request.params.id));
  });

  app.post<{ Params: { id: string } }>("/cycles/:id/activate", async (request, reply) => {
    const cycle = await cycleRepo.get(request.params.id);
    if (!cycle) {
      return reply.status(404).send({ error: "cycle not found" });
    }

    await activeCycleRepo.set(request.params.id);
    return reply.status(204).send();
  });

  app.get<{ Params: { id: string } }>("/cycles/:id/stats", async (request, reply) => {
    const cycle = await cycleRepo.get(request.params.id);
    if (!cycle) {
      return reply.status(404).send({ error: "cycle not found" });
    }

    const [runIds, replayRunIds] = await Promise.all([
      deps.runRepo.findIdsByCycleId(request.params.id),
      deps.sessionReplayRunRepo.findIdsByCycleId(request.params.id),
    ]);
    const findings = await deps.findingRepo.findByRunIds([...runIds, ...replayRunIds]);

    return {
      runCount: runIds.length,
      replayRunCount: replayRunIds.length,
      ...computeFindingStats(findings),
      ...computeJudgeAccuracy(findings),
    };
  });
}
