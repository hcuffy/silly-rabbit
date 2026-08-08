import type { FastifyInstance } from "fastify";
import type { AppDeps } from "./app.js";
import { deleteFinding, deleteRunCascade } from "./cascadeDelete.js";
import { cancelExplorerRun } from "./explorerRunLifecycle.js";
import { cancelRun } from "./orchestrator.js";

export function registerCancelDeleteRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.post<{ Params: { id: string } }>("/runs/:id/cancel", async (request, reply) => {
    if (await cancelRun(request.params.id, deps)) return reply.status(200).send({ cancelled: true });

    const run = await deps.runRepo.get(request.params.id);
    if (!run) return reply.status(404).send({ error: "run not found" });
    return reply.status(409).send({ error: `run is already ${run.status}, cannot cancel` });
  });

  app.delete<{ Params: { id: string } }>("/runs/:id", async (request, reply) => {
    const run = await deps.runRepo.get(request.params.id);
    if (!run) return reply.status(404).send({ error: "run not found" });

    await cancelRun(request.params.id, deps);
    const result = await deleteRunCascade(request.params.id, deps);
    return reply.status(200).send(result);
  });

  app.post<{ Params: { id: string } }>("/explorer/runs/:id/cancel", async (request, reply) => {
    if (await cancelExplorerRun(request.params.id, deps)) return reply.status(200).send({ cancelled: true });

    const run = await deps.runRepo.get(request.params.id);
    if (!run) return reply.status(404).send({ error: "run not found" });
    return reply.status(409).send({ error: `run is already ${run.status}, cannot cancel` });
  });

  app.delete<{ Params: { id: string } }>("/explorer/runs/:id", async (request, reply) => {
    const run = await deps.runRepo.get(request.params.id);
    if (!run) return reply.status(404).send({ error: "run not found" });

    await cancelExplorerRun(request.params.id, deps);
    const result = await deleteRunCascade(request.params.id, deps);
    return reply.status(200).send(result);
  });

  app.delete<{ Params: { id: string } }>("/findings/:id", async (request, reply) => {
    const finding = await deps.findingRepo.get(request.params.id);
    if (!finding) return reply.status(404).send({ error: "finding not found" });

    await deleteFinding(finding, deps.findingRepo);
    return reply.status(204).send();
  });
}
