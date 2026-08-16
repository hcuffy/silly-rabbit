import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "./app.js";
import { buildNavMap } from "./navMapLifecycle.js";
import { RunCapacityError } from "./orchestrator.js";
import type { NavMapRepo } from "./repos/navMapRepo.js";
import { resolveActiveProfileForRequest } from "./targetProfileResolution.js";

const CrawlNavMapBodySchema = z.object({
  baseUrl: z.string().url().optional(),
});

const GetNavMapQuerySchema = z.object({
  baseUrl: z.string().url(),
});

export function registerNavMapRoutes(app: FastifyInstance, deps: AppDeps & { navMapRepo: NavMapRepo }): void {
  app.post("/nav-map/crawl", async (request, reply) => {
    const parsed = CrawlNavMapBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid request body", details: parsed.error.flatten() });
    }

    const { activeProfileBaseUrl, deps: resolvedDeps } = await resolveActiveProfileForRequest(deps);
    const targetBaseUrl = parsed.data.baseUrl ?? activeProfileBaseUrl;
    if (!targetBaseUrl) {
      return reply.status(400).send({ error: "baseUrl is required (no active target profile provides a default)" });
    }

    try {
      const navMap = await buildNavMap({ baseUrl: targetBaseUrl }, resolvedDeps);
      return reply.status(200).send(navMap);
    } catch (error) {
      if (error instanceof RunCapacityError) {
        return reply.status(429).send({ error: error.message });
      }
      throw error;
    }
  });

  app.get<{ Querystring: { baseUrl?: string } }>("/nav-map", async (request, reply) => {
    const parsed = GetNavMapQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid query parameters", details: parsed.error.flatten() });
    }

    const navMap = await deps.navMapRepo.getByBaseUrl(parsed.data.baseUrl);
    if (!navMap) {
      return reply.status(404).send({ error: "no nav map for this baseUrl" });
    }
    return navMap;
  });

  app.delete<{ Querystring: { baseUrl?: string } }>("/nav-map", async (request, reply) => {
    const parsed = GetNavMapQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid query parameters", details: parsed.error.flatten() });
    }

    const navMap = await deps.navMapRepo.getByBaseUrl(parsed.data.baseUrl);
    if (!navMap) {
      return reply.status(404).send({ error: "no nav map for this baseUrl" });
    }

    await deps.navMapRepo.delete(parsed.data.baseUrl);
    return reply.status(204).send();
  });
}
