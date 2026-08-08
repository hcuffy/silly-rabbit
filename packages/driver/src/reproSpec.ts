import type { Finding } from "@silly-rabbit/shared";

export interface ReproSpecInput {
  finding: Finding;
  url: string;
}

export function generateReproSpec({ finding, url }: ReproSpecInput): string {
  const expectedMasked = finding.evidence.ariaSnapshot ?? "";

  return `import { expect, test } from "@playwright/test";
import { deriveFingerprint } from "@silly-rabbit/engine";

test("repro: ${finding.type} on screen ${finding.screenId}", async ({ page }) => {
  await page.goto(${JSON.stringify(url)});
  const ariaSnapshot = await page.ariaSnapshot({ boxes: true });
  const { ariaSnapshotMasked } = deriveFingerprint(ariaSnapshot);
  expect(ariaSnapshotMasked).toBe(${JSON.stringify(expectedMasked)});
});
`;
}
