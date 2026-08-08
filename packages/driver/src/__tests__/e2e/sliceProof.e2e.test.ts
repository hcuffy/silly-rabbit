import { deriveScreenId, runEngineLoop, type AnthropicLike, type AnthropicMessageResponse } from "@silly-rabbit/engine";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { explore } from "../../explore.js";
import { applyEngineOutput, emptyLocalStore } from "../../localStore.js";
import type { MockSeed } from "../../mock/pages.js";
import { installMockTarget } from "../../mock/routes.js";
import { generateReproSpec } from "../../reproSpec.js";

const MOCK_BASE_URL = "http://mock.local";
const CHARTER = "test the locations flow";

function seedFor(overrides: Partial<MockSeed> = {}): MockSeed {
  return { recordId: randomUUID(), timestamp: new Date().toISOString(), count: 7, ...overrides };
}

function fakeJudgeClient(): AnthropicLike {
  const response: AnthropicMessageResponse = {
    content: [
      { type: "tool_use", name: "submit_verdict", input: { verdict: "REGRESSION", severity: "HIGH", reasoning: "button removed", confidence: 0.9 } },
    ],
    usage: { input_tokens: 100, output_tokens: 50 },
  };
  return { messages: { create: () => Promise.resolve(response) } };
}

describe("D3 §8 three-run slice", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("run 1 learns; run 2 (volatile-only) flags nothing; run 2' (changed-regression) flags + emits a repro spec", async () => {
    const run1Observations = await explore({
      charter: CHARTER,
      baseUrl: MOCK_BASE_URL,
      browser,
      installRoutes: (context) => installMockTarget(context, "baseline", seedFor()),
    });
    const noJudgeCalls: AnthropicLike = {
      messages: {
        create: () => {
          throw new Error("judge should not be called — no divergence expected in this step");
        },
      },
    };

    const run1Output = await runEngineLoop({
      runId: "run-1",
      charter: CHARTER,
      observations: run1Observations,
      existingBaselines: [],
      existingFindings: [],
      judge: { clientFactory: () => noJudgeCalls },
    });

    expect(run1Output.baselines).toHaveLength(1);
    expect(run1Output.findings.filter((finding) => finding.type === "STATE_DIVERGENCE")).toHaveLength(0);

    const storeAfterRun1 = applyEngineOutput(emptyLocalStore(), run1Output);

    const run2Observations = await explore({
      charter: CHARTER,
      baseUrl: MOCK_BASE_URL,
      browser,
      installRoutes: (context) =>
        installMockTarget(context, "volatile-only", seedFor({ timestamp: new Date(Date.now() + 60_000).toISOString() })),
    });
    const run2Output = await runEngineLoop({
      runId: "run-2",
      charter: CHARTER,
      observations: run2Observations,
      existingBaselines: storeAfterRun1.baselines,
      existingFindings: storeAfterRun1.findings,
      judge: { clientFactory: () => noJudgeCalls },
    });

    expect(run2Output.baselines).toHaveLength(0);
    expect(run2Output.findings.filter((finding) => finding.type === "STATE_DIVERGENCE")).toHaveLength(0);

    const run2pObservations = await explore({
      charter: CHARTER,
      baseUrl: MOCK_BASE_URL,
      browser,
      installRoutes: (context) => installMockTarget(context, "changed-regression", seedFor()),
    });
    const run2pOutput = await runEngineLoop({
      runId: "run-2p",
      charter: CHARTER,
      observations: run2pObservations,
      existingBaselines: storeAfterRun1.baselines,
      existingFindings: storeAfterRun1.findings,
      judge: { clientFactory: fakeJudgeClient },
    });

    const divergence = run2pOutput.findings.find(
      (finding) => finding.type === "STATE_DIVERGENCE" && finding.status === "NEW",
    );
    expect(divergence).toBeDefined();
    if (!divergence) throw new Error("unreachable — asserted above");
    expect(divergence.verdict).toBe("REGRESSION");
    expect(run2pOutput.llmCallsUsed).toBe(1);

    const [listObservation] = run2pObservations;
    expect(listObservation).toBeDefined();
    if (!listObservation) throw new Error("unreachable — asserted above");

    expect(divergence.screenId).toBe(deriveScreenId(listObservation).screenId);

    const reproSpec = generateReproSpec({ finding: divergence, url: listObservation.url });
    expect(reproSpec).toContain("test(");
    expect(reproSpec).toContain("expect(ariaSnapshotMasked).toBe(");
    expect(reproSpec).toContain(listObservation.url);
  });
});
