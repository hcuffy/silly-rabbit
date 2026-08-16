import { getTriggeredBy } from "@silly-rabbit/driver";
import { generateFeatureDocument, trackClientUsage } from "@silly-rabbit/explorer";
import type { FeatureDocument } from "@silly-rabbit/shared";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "./app.js";

const FEATURE_DOCUMENT_RATE_LIMIT = { max: 5, timeWindow: "1 minute" };
const FEATURE_DOCUMENT_COOLDOWN_MS = 10 * 60 * 1000;

export function registerFeatureDocumentRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.post<{ Params: { featureId: string } }>(
    "/features/:featureId/docs",
    { config: { rateLimit: FEATURE_DOCUMENT_RATE_LIMIT } },
    async (request, reply) => {
      const { featureId } = request.params;

      const latestDocument = await deps.featureDocumentRepo.findLatestByFeatureId(featureId);
      const msSinceLastGeneration = latestDocument ? Date.now() - latestDocument.generatedAt.getTime() : undefined;
      if (msSinceLastGeneration !== undefined && msSinceLastGeneration < FEATURE_DOCUMENT_COOLDOWN_MS) {
        return reply.status(429).send({
          error: "a feature doc was generated too recently for this feature — wait before regenerating",
          retryAfterMs: FEATURE_DOCUMENT_COOLDOWN_MS - msSinceLastGeneration,
        });
      }

      const latestTestRun = await deps.testRunRepo.findLatestByFeatureId(featureId);
      if (!latestTestRun) {
        return reply.status(404).send({ error: "no research exists yet for this feature — run the explorer against it first" });
      }

      const activeLearnings = await deps.learningRepo.findActiveByFeatureId(featureId);
      const { clientFactory: trackedClientFactory, totals } = trackClientUsage(deps.judgeClientFactory);
      const generated = await generateFeatureDocument(latestTestRun.research, activeLearnings, {
        clientFactory: trackedClientFactory,
      });

      const featureDocument: FeatureDocument = {
        id: randomUUID(),
        featureId,
        generatedAt: new Date(),
        sourceTestRunId: latestTestRun.id,
        activeLearningIds: activeLearnings.map((learning) => learning.id),
        content: generated.content,
        model: generated.model,
        llmCallsUsed: totals.llmCallsUsed,
        costUsd: totals.costUsd,
        triggeredBy: getTriggeredBy(),
      };
      await deps.featureDocumentRepo.create(featureDocument);
      return reply.status(200).send(featureDocument);
    },
  );

  app.get<{ Params: { featureId: string } }>("/features/:featureId/docs", async (request) =>
    deps.featureDocumentRepo.findByFeatureId(request.params.featureId),
  );

  app.get<{ Params: { featureId: string } }>("/features/:featureId/docs/latest", async (request, reply) => {
    const latest = await deps.featureDocumentRepo.findLatestByFeatureId(request.params.featureId);
    if (!latest) {
      return reply.status(404).send({ error: "no feature doc generated yet for this feature" });
    }
    return latest;
  });
}
