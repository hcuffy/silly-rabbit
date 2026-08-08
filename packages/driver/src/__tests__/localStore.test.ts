import type { Baseline, Finding } from "@silly-rabbit/shared";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyEngineOutput, emptyLocalStore, loadLocalStore, saveLocalStore } from "../localStore.js";

function fabricateFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    runId: "run-1",
    screenId: "screen-1",
    type: "CONSOLE_ERROR",
    evidence: { consoleMessages: ["boom"] },
    dedupKey: "dedup-1",
    status: "NEW",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function fabricateBaseline(overrides: Partial<Baseline> = {}): Baseline {
  return {
    screenId: "screen-1",
    fingerprint: "fp-1",
    ariaSnapshotMasked: "<TEXT>",
    capturedAt: new Date("2026-01-01T00:00:00Z"),
    runId: "run-1",
    ...overrides,
  };
}

describe("applyEngineOutput (CLI/test-only convenience persistence, not Mongo)", () => {
  it("appends new baselines and upserts findings by dedupKey", () => {
    const store = { baselines: [], findings: [fabricateFinding({ status: "NEW" })] };
    const updated = applyEngineOutput(store, {
      baselines: [fabricateBaseline()],
      findings: [fabricateFinding({ status: "RECURRING", verdict: "KNOWN" })],
      llmCallsUsed: 0,
      costUsd: 0,
    });

    expect(updated.baselines).toHaveLength(1);
    expect(updated.findings).toHaveLength(1);
    expect(updated.findings[0]?.status).toBe("RECURRING");
  });
});

describe("loadLocalStore / saveLocalStore", () => {
  it("round-trips through JSON with Date fields preserved", async () => {
    const directory = await mkdtemp(join(tmpdir(), "silly-rabbit-localstore-"));
    const path = join(directory, "state.json");
    try {
      const store = { baselines: [fabricateBaseline()], findings: [fabricateFinding()] };
      await saveLocalStore(path, store);
      const loaded = await loadLocalStore(path);

      expect(loaded.baselines[0]?.capturedAt).toBeInstanceOf(Date);
      expect(loaded.baselines[0]?.capturedAt.toISOString()).toBe(store.baselines[0]?.capturedAt.toISOString());
      expect(loaded.findings[0]?.createdAt).toBeInstanceOf(Date);
      expect(loaded.findings[0]?.createdAt.toISOString()).toBe(store.findings[0]?.createdAt.toISOString());
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns an empty store when the file does not exist", async () => {
    const loaded = await loadLocalStore(join(tmpdir(), "silly-rabbit-localstore-missing-dir", "nope.json"));
    expect(loaded).toEqual(emptyLocalStore());
  });
});
