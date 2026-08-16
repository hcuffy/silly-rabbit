import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "./app.js";
import { deleteSessionRecordingCascade, deleteSessionReplayRunCascade } from "./cascadeDelete.js";
import { RunCapacityError } from "./orchestrator.js";
import { cancelSessionReplayRun, startSessionReplayRun } from "./sessionReplayRunLifecycle.js";
import { withActiveProfileOverrides } from "./targetProfileResolution.js";

const CreateSessionReplayRunBodySchema = z.object({
  sessionId: z.string().uuid(),
  replayMode: z.enum(["live", "mocked"]).optional(),
  cycleId: z.string().uuid().optional(),
});

const DEFAULT_RUNS_LIMIT = 25;
const MAX_RUNS_LIMIT = 100;

const RunsListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_RUNS_LIMIT).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  cycleId: z.string().uuid().optional(),
});

export function registerSessionReplayRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.post("/session-replay/runs", async (request, reply) => {
    const parsed = CreateSessionReplayRunBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid request body", details: parsed.error.flatten() });
    }

    try {
      const run = await startSessionReplayRun(parsed.data, await withActiveProfileOverrides(deps));
      if (!run) {
        return reply.status(404).send({ error: "session recording not found" });
      }

      return reply.status(202).send({ runId: run.id, status: run.status });
    } catch (error) {
      if (error instanceof RunCapacityError) {
        return reply.status(429).send({ error: error.message });
      }
      throw error;
    }
  });

  app.get<{ Querystring: { limit?: string; offset?: string; cycleId?: string } }>("/session-replay/runs", async (request, reply) => {
    const parsed = RunsListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid query parameters", details: parsed.error.flatten() });
    }

    return deps.sessionReplayRunRepo.list({
      limit: parsed.data.limit ?? DEFAULT_RUNS_LIMIT,
      offset: parsed.data.offset ?? 0,
      cycleId: parsed.data.cycleId,
    });
  });

  app.get<{ Params: { id: string } }>("/session-replay/runs/:id", async (request, reply) => {
    const run = await deps.sessionReplayRunRepo.get(request.params.id);
    if (!run) {
      return reply.status(404).send({ error: "session-replay run not found" });
    }

    const [findings, sessionRecording] = await Promise.all([deps.findingRepo.findByRunIds([run.id]), deps.sessionRecordingRepo.get(run.sessionId)]);
    return { ...run, findings, steps: sessionRecording?.steps ?? [] };
  });

  app.post<{ Params: { id: string } }>("/session-replay/runs/:id/cancel", async (request, reply) => {
    if (await cancelSessionReplayRun(request.params.id, deps)) {
      return reply.status(200).send({ cancelled: true });
    }

    const run = await deps.sessionReplayRunRepo.get(request.params.id);
    if (!run) {
      return reply.status(404).send({ error: "session-replay run not found" });
    }
    return reply.status(409).send({ error: `run is already ${run.status}, cannot cancel` });
  });

  app.delete<{ Params: { id: string } }>("/session-replay/runs/:id", async (request, reply) => {
    const run = await deps.sessionReplayRunRepo.get(request.params.id);
    if (!run) {
      return reply.status(404).send({ error: "session-replay run not found" });
    }

    await cancelSessionReplayRun(request.params.id, deps);
    const result = await deleteSessionReplayRunCascade(request.params.id, deps);
    return reply.status(200).send(result);
  });

  app.get("/session-recordings", async () => deps.sessionRecordingRepo.list());

  app.delete<{ Params: { id: string } }>("/session-recordings/:id", async (request, reply) => {
    const recording = await deps.sessionRecordingRepo.get(request.params.id);
    if (!recording) {
      return reply.status(404).send({ error: "session recording not found" });
    }

    const replayRuns = await deps.sessionReplayRunRepo.findBySessionId(request.params.id);
    await Promise.all(replayRuns.map((run) => cancelSessionReplayRun(run.id, deps)));

    const result = await deleteSessionRecordingCascade(request.params.id, deps);
    return reply.status(200).send(result);
  });
}
