import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { z } from "zod";
import {
  createSessionExpiry,
  passwordMatches,
  signSessionToken,
  verifySessionToken,
  SESSION_COOKIE_NAME,
} from "./auth.js";
import { registerCancelDeleteRoutes } from "./cancelDeleteRoutes.js";
import { registerCycleRoutes } from "./cycleRoutes.js";
import { startExplorerRun, type ExplorerRunLifecycleDeps } from "./explorerRunLifecycle.js";
import { registerFeatureDocumentRoutes } from "./featureDocumentRoutes.js";
import { registerFindingRoutes } from "./findingRoutes.js";
import { registerNavMapRoutes } from "./navMapRoutes.js";
import { RunCapacityError, startRun, type OrchestratorDeps } from "./orchestrator.js";
import type { ActiveCycleRepo } from "./repos/activeCycleRepo.js";
import type { ActiveTargetProfileRepo } from "./repos/activeTargetProfileRepo.js";
import type { FeatureDocumentRepo } from "./repos/featureDocumentRepo.js";
import type { NavMapRepo } from "./repos/navMapRepo.js";
import type { TargetProfileRepo } from "./repos/targetProfileRepo.js";
import { registerSessionReplayRoutes } from "./sessionReplayRoutes.js";
import type { SessionReplayRunLifecycleDeps } from "./sessionReplayRunLifecycle.js";
import { registerTargetProfileRoutes } from "./targetProfileRoutes.js";
import { resolveActiveProfileForRequest } from "./targetProfileResolution.js";

export type AppDeps = OrchestratorDeps &
  ExplorerRunLifecycleDeps &
  SessionReplayRunLifecycleDeps & {
    featureDocumentRepo: FeatureDocumentRepo;
    targetProfileRepo?: TargetProfileRepo;
    activeTargetProfileRepo?: ActiveTargetProfileRepo;
    navMapRepo?: NavMapRepo;
    activeCycleRepo?: ActiveCycleRepo;
    corsOrigins: string[];
    dashboardPassword: string;
    sessionSecret: string;
    cookieSecure: boolean;
    cookieSameSite: "lax" | "none" | "strict";
    trustProxy?: boolean;
  };

const LOGIN_RATE_LIMIT = { max: 5, timeWindow: "1 minute" };
const AUTH_LOGIN_PATH = "/auth/login";

const LoginBodySchema = z.object({
  password: z.string(),
});

const CreateRunBodySchema = z.object({
  charter: z.string(),
  targetBaseUrl: z.string().url().optional(),
  cycleId: z.string().uuid().optional(),
});

const CreateExplorerRunBodySchema = z.object({
  featureId: z.string(),
  sectionDescription: z.string(),
  targetBaseUrl: z.string().url().optional(),
  cycleId: z.string().uuid().optional(),
});

const DEFAULT_RUNS_LIMIT = 25;
const MAX_RUNS_LIMIT = 100;

const RunsListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_RUNS_LIMIT).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  cycleId: z.string().uuid().optional(),
});

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ trustProxy: deps.trustProxy ?? false });

  app.register(cors, { origin: deps.corsOrigins, credentials: true, methods: ["GET", "POST", "PUT", "DELETE"] });
  app.register(cookie);
  app.register(rateLimit, { global: false });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error(error);
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) {
      return reply.status(500).send({ error: "internal server error" });
    }
    return reply.status(statusCode).send({ error: error.message });
  });

  app.addHook("onRequest", async (request, reply) => {
    if (request.routeOptions.url === AUTH_LOGIN_PATH) return;
    if (!verifySessionToken(request.cookies[SESSION_COOKIE_NAME], deps.sessionSecret)) {
      return reply.status(401).send({ error: "unauthorized" });
    }
  });

  app.register((instance, _options, done) => {
    instance.post(AUTH_LOGIN_PATH, { config: { rateLimit: LOGIN_RATE_LIMIT } }, async (request, reply) => {
      const parsed = LoginBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "invalid request body", details: parsed.error.flatten() });
      }

      if (!passwordMatches(parsed.data.password, deps.dashboardPassword)) {
        return reply.status(401).send({ error: "invalid password" });
      }

      const expiresAt = createSessionExpiry();
      const token = signSessionToken(deps.sessionSecret, expiresAt);
      reply.setCookie(SESSION_COOKIE_NAME, token, {
        httpOnly: true,
        path: "/",
        sameSite: deps.cookieSameSite,
        secure: deps.cookieSecure,
        expires: new Date(expiresAt),
      });
      return reply.status(204).send();
    });
    done();
  });

  app.post("/auth/logout", async (_request, reply) => {
    reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
    return reply.status(204).send();
  });

  app.get("/auth/session", async (_request, reply) => reply.status(200).send({ authenticated: true }));

  app.post("/runs", async (request, reply) => {
    const parsed = CreateRunBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid request body", details: parsed.error.flatten() });
    }

    const { activeProfileBaseUrl, deps: resolvedDeps } = await resolveActiveProfileForRequest(deps);
    const targetBaseUrl = parsed.data.targetBaseUrl ?? activeProfileBaseUrl;
    if (!targetBaseUrl) {
      return reply.status(400).send({ error: "targetBaseUrl is required (no active target profile provides a default)" });
    }

    try {
      const run = await startRun({ ...parsed.data, targetBaseUrl }, resolvedDeps);
      return reply.status(202).send({ runId: run.id, status: run.status });
    } catch (error) {
      if (error instanceof RunCapacityError) return reply.status(429).send({ error: error.message });
      throw error;
    }
  });

  app.get<{ Querystring: { limit?: string; offset?: string; cycleId?: string } }>("/runs", async (request, reply) => {
    const parsed = RunsListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid query parameters", details: parsed.error.flatten() });
    }

    return deps.runRepo.list({
      limit: parsed.data.limit ?? DEFAULT_RUNS_LIMIT,
      offset: parsed.data.offset ?? 0,
      cycleId: parsed.data.cycleId,
    });
  });

  app.get<{ Params: { id: string } }>("/runs/:id", async (request, reply) => {
    const run = await deps.runRepo.get(request.params.id);
    if (!run) return reply.status(404).send({ error: "run not found" });
    return run;
  });

  app.get<{ Params: { id: string } }>("/runs/:id/findings", async (request) =>
    deps.findingRepo.listByRun(request.params.id),
  );

  app.post("/explorer/runs", async (request, reply) => {
    const parsed = CreateExplorerRunBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid request body", details: parsed.error.flatten() });
    }

    const { activeProfileBaseUrl, deps: resolvedDeps } = await resolveActiveProfileForRequest(deps);
    const targetBaseUrl = parsed.data.targetBaseUrl ?? activeProfileBaseUrl;
    if (!targetBaseUrl) {
      return reply.status(400).send({ error: "targetBaseUrl is required (no active target profile provides a default)" });
    }

    try {
      const run = await startExplorerRun({ ...parsed.data, targetBaseUrl }, resolvedDeps);
      return reply.status(202).send({ runId: run.id, status: run.status });
    } catch (error) {
      if (error instanceof RunCapacityError) return reply.status(429).send({ error: error.message });
      throw error;
    }
  });

  app.get<{ Querystring: { limit?: string; offset?: string } }>("/explorer/runs", async (request, reply) => {
    const parsed = RunsListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid query parameters", details: parsed.error.flatten() });
    }

    return deps.testRunRepo.list({
      limit: parsed.data.limit ?? DEFAULT_RUNS_LIMIT,
      offset: parsed.data.offset ?? 0,
    });
  });

  app.get<{ Params: { id: string } }>("/explorer/runs/:id", async (request, reply) => {
    const run = await deps.runRepo.get(request.params.id);
    if (!run) return reply.status(404).send({ error: "run not found" });

    const [testRun, findings] = await Promise.all([
      deps.testRunRepo.getByRunId(run.id),
      deps.findingRepo.listByRun(run.id),
    ]);
    return { ...run, testRun, findings };
  });

  registerFeatureDocumentRoutes(app, deps);
  registerFindingRoutes(app, deps);
  registerSessionReplayRoutes(app, deps);
  const { navMapRepo } = deps;
  if (navMapRepo) registerNavMapRoutes(app, { ...deps, navMapRepo });
  registerCancelDeleteRoutes(app, deps);
  if (deps.targetProfileRepo && deps.activeTargetProfileRepo) registerTargetProfileRoutes(app, deps);
  if (deps.cycleRepo && deps.activeCycleRepo) registerCycleRoutes(app, deps);

  return app;
}
