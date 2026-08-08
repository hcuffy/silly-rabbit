import type { Baseline, Finding } from "@silly-rabbit/shared";
import { describe, expect, it } from "vitest";
import type { AnthropicLike } from "../judge.js";
import { runEngineLoop } from "../runner.js";
import type { CapturedObservation, EngineLoopInput } from "../types.js";

const URL = "https://dev.rabbit.example/fleet/auth/platform/locations";

function observation(overrides: Partial<CapturedObservation> = {}): CapturedObservation {
  return { url: URL, ariaSnapshot: '- heading "Locations" [level=1]', ...overrides };
}

function throwingJudgeClient(): AnthropicLike {
  return {
    messages: {
      create: () => {
        throw new Error("judge should not be called in this test");
      },
    },
  };
}

function loopInput(overrides: Partial<EngineLoopInput> = {}): EngineLoopInput {
  return {
    runId: "run-1",
    charter: "test the locations flow",
    observations: [],
    existingBaselines: [],
    existingFindings: [],
    judge: { clientFactory: () => throwingJudgeClient() },
    ...overrides,
  };
}

describe("runEngineLoop — hash-route identity + in-run baseline map (audit fix 3)", () => {
  const HASH_A = "https://dev.rabbit.example/#/locations";
  const HASH_B = "https://dev.rabbit.example/#/settings";

  it("two distinct hash routes learn two independent baselines; unchanged re-run diverges on neither", async () => {
    const run1 = await runEngineLoop(
      loopInput({
        runId: "run-1",
        observations: [
          observation({ url: HASH_A, ariaSnapshot: '- heading "Locations" [level=1]' }),
          observation({ url: HASH_B, ariaSnapshot: '- heading "Settings" [level=1]' }),
        ],
      }),
    );
    expect(run1.baselines).toHaveLength(2);

    const run2 = await runEngineLoop(
      loopInput({
        runId: "run-2",
        observations: [
          observation({ url: HASH_A, ariaSnapshot: '- heading "Locations" [level=1]' }),
          observation({ url: HASH_B, ariaSnapshot: '- heading "Settings" [level=1]' }),
        ],
        existingBaselines: run1.baselines,
        existingFindings: run1.findings,
      }),
    );
    expect(run2.baselines).toHaveLength(0);
    expect(run2.findings.filter((f) => f.type === "STATE_DIVERGENCE")).toHaveLength(0);
  });

  it("a screen observed twice in one run learns exactly one baseline and never self-diverges", async () => {
    const output = await runEngineLoop(loopInput({ observations: [observation(), observation()] }));
    expect(output.baselines).toHaveLength(1);
    expect(output.findings.filter((f) => f.type === "STATE_DIVERGENCE")).toHaveLength(0);
    expect(output.llmCallsUsed).toBe(0);
  });

  it("no dedup bleed across hash screens: the same console error on #/a and #/b is two NEW findings", async () => {
    const errorMessage = "TypeError: x is undefined at app.js:1:1";
    const output = await runEngineLoop(
      loopInput({
        observations: [
          observation({ url: HASH_A, consoleErrors: [errorMessage] }),
          observation({ url: HASH_B, consoleErrors: [errorMessage] }),
        ],
      }),
    );
    const consoleFindings = output.findings.filter((f) => f.type === "CONSOLE_ERROR");
    expect(consoleFindings).toHaveLength(2);
    expect(consoleFindings.every((f) => f.status === "NEW")).toBe(true);
    expect(new Set(consoleFindings.map((f) => f.dedupKey)).size).toBe(2);
  });

  it("no resolve bleed: an open finding on #/a stays untouched by a run observing only #/b", async () => {
    const run1 = await runEngineLoop(
      loopInput({
        runId: "run-1",
        observations: [observation({ url: HASH_A, consoleErrors: ["TypeError: x is undefined at app.js:1:1"] })],
      }),
    );

    const run2 = await runEngineLoop(
      loopInput({
        runId: "run-2",
        observations: [observation({ url: HASH_B, ariaSnapshot: '- heading "Settings" [level=1]' })],
        existingBaselines: run1.baselines,
        existingFindings: run1.findings,
      }),
    );
    expect(run2.findings.filter((f) => f.status === "RESOLVED")).toHaveLength(0);
  });

  it("a screen observed twice emits no duplicate RESOLVED entries for a prior finding", async () => {
    const run1 = await runEngineLoop(
      loopInput({
        runId: "run-1",
        observations: [observation({ consoleErrors: ["TypeError: x is undefined at app.js:1:1"] })],
      }),
    );

    const run2 = await runEngineLoop(
      loopInput({
        runId: "run-2",
        observations: [observation(), observation()],
        existingBaselines: run1.baselines,
        existingFindings: run1.findings,
      }),
    );
    const resolved = run2.findings.filter((f) => f.status === "RESOLVED");
    expect(resolved).toHaveLength(1);
  });
});

describe("runEngineLoop — type wiring sanity", () => {
  it("accepts plain Baseline/Finding arrays from the shared schema (no engine-only shapes leak)", async () => {
    const baselines: Baseline[] = [];
    const findings: Finding[] = [];
    const output = await runEngineLoop(loopInput({ existingBaselines: baselines, existingFindings: findings }));
    expect(output.baselines).toEqual([]);
    expect(output.findings).toEqual([]);
  });
});
