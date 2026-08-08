import { computePixelDiffScore } from "@silly-rabbit/driver";
import { recordFeedback } from "@silly-rabbit/explorer";
import { computeFindingStats, computeJudgeAccuracy } from "@silly-rabbit/shared";
import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "./app.js";

const FeedbackBodySchema = z.object({
  verdict: z.enum(["confirmed_issue", "intended_behavior", "dismiss"]),
});

const TargetStatsQuerySchema = z.object({
  targetBaseUrl: z.string().url(),
});

export function registerFindingRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get<{ Querystring: { targetBaseUrl?: string } }>("/findings/stats", async (request, reply) => {
    const parsed = TargetStatsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid query parameters", details: parsed.error.flatten() });
    }

    const runIds = await deps.runRepo.findIdsByTargetBaseUrl(parsed.data.targetBaseUrl);
    const findings = await deps.findingRepo.findByRunIds(runIds);
    return { ...computeFindingStats(findings), ...computeJudgeAccuracy(findings) };
  });

  app.get<{ Params: { id: string } }>("/findings/:id", async (request, reply) => {
    const finding = await deps.findingRepo.get(request.params.id);
    if (!finding) return reply.status(404).send({ error: "finding not found" });
    return finding;
  });

  app.get<{ Params: { id: string } }>("/findings/:id/repro", async (request, reply) => {
    const finding = await deps.findingRepo.get(request.params.id);
    if (!finding?.reproSpecPath) return reply.status(404).send({ error: "no repro spec for this finding" });

    const content = await readFile(finding.reproSpecPath, "utf8");
    const safeFilenameId = finding.id.replace(/[^a-zA-Z0-9-]/g, "_");
    return reply
      .type("application/typescript")
      .header("Content-Disposition", `attachment; filename="${safeFilenameId}.spec.ts"`)
      .send(content);
  });

  app.get<{ Params: { id: string } }>("/findings/:id/screenshot", async (request, reply) => {
    const finding = await deps.findingRepo.get(request.params.id);
    if (!finding?.screenshotPath) return reply.status(404).send({ error: "no screenshot for this finding" });

    const content = await readFile(finding.screenshotPath);
    return reply.type("image/png").send(content);
  });

  app.get<{ Params: { id: string } }>("/findings/:id/pixel-diff", async (request, reply) => {
    const finding = await deps.findingRepo.get(request.params.id);
    if (!finding?.beforeScreenshotPath || !finding.screenshotPath) {
      return reply.status(404).send({ error: "pixel-diff requires both a before and an after screenshot for this finding" });
    }

    const [before, after] = await Promise.all([
      readFile(finding.beforeScreenshotPath),
      readFile(finding.screenshotPath),
    ]);
    const pixelDiffScore = computePixelDiffScore(before, after);
    if (pixelDiffScore === undefined) {
      return reply.status(422).send({ error: "before/after screenshots have mismatched dimensions — cannot compute a pixel diff" });
    }

    return { pixelDiffScore };
  });

  app.post<{ Params: { id: string } }>("/findings/:id/feedback", async (request, reply) => {
    const parsedBody = FeedbackBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.status(400).send({ error: "invalid request body", details: parsedBody.error.flatten() });
    }

    const finding = await deps.findingRepo.get(request.params.id);
    if (!finding) return reply.status(404).send({ error: "finding not found" });

    const { verdict } = parsedBody.data;
    if (verdict !== "dismiss" && !finding.featureId) {
      return reply.status(400).send({
        error: `verdict "${verdict}" requires the finding to have a featureId (only set for explorer/D8 findings); this finding has none`,
      });
    }

    await recordFeedback({ finding, featureId: finding.featureId ?? "", verdict }, deps.learningRepo, deps.findingRepo);
    return reply.status(204).send();
  });
}
