import type { Finding } from "@silly-rabbit/shared";
import { describe, expect, it } from "vitest";
import { generateReproSpec } from "../reproSpec.js";

function fabricateFinding(): Finding {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    runId: "run-1",
    screenId: "abc123",
    type: "STATE_DIVERGENCE",
    verdict: "NEEDS_HUMAN",
    severity: "MEDIUM",
    reasoning: "mock judge stub",
    confidence: 0,
    evidence: { ariaSnapshot: '- heading "Locations" [level=1]' },
    dedupKey: "dedup-1",
    status: "NEW",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("generateReproSpec (driver-spec §5)", () => {
  it("emits a Playwright spec with the url, an assertion, and the masked snapshot", () => {
    const finding = fabricateFinding();
    const url = "http://mock.local/fleet/auth/platform/locations";
    const spec = generateReproSpec({ finding, url });

    expect(spec).toContain(url);
    expect(spec).toContain("expect(ariaSnapshotMasked).toBe(");
    expect(spec).toContain(JSON.stringify(finding.evidence.ariaSnapshot));
    expect(spec).toContain('import { deriveFingerprint } from "@silly-rabbit/engine"');
  });
});
