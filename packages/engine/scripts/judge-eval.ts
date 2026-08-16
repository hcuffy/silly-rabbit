import Anthropic from "@anthropic-ai/sdk";
import { chromium } from "playwright";
import { deriveFingerprint, deriveScreenId, runJudge, type JudgeInput } from "../src/index.js";

const CHARTER = "test the locations flow";
const MOCK_URL = "http://mock.local/fleet/auth/platform/locations";

function renderLocationsListHtml(options: { withAddButton: boolean }): string {
  return `<!doctype html><html><head><title>rabbit</title></head><body>
    <h1>Locations</h1>
    <p>Last updated: 2026-01-01T00:00:00.000Z</p>
    <p>7 locations found</p>
    <ul>
      <li><a href="/fleet/auth/platform/locations/1">Main Warehouse</a></li>
    </ul>
    ${options.withAddButton ? `<button type="button">Add Location</button>` : ""}
  </body></html>`;
}

interface EvalCase {
  label: string;
  input: JudgeInput;
}

async function captureRealDivergence(): Promise<EvalCase> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();

    await page.route(`${MOCK_URL}**`, (route) => route.fulfill({ contentType: "text/html", body: renderLocationsListHtml({ withAddButton: true }) }));
    await page.goto(MOCK_URL);
    const baselineRaw = await page.ariaSnapshot({ boxes: true });

    await page.unroute(`${MOCK_URL}**`);
    await page.route(`${MOCK_URL}**`, (route) =>
      route.fulfill({ contentType: "text/html", body: renderLocationsListHtml({ withAddButton: false }) }),
    );
    await page.goto(MOCK_URL);
    const currentRaw = await page.ariaSnapshot({ boxes: true });

    const { screenId } = deriveScreenId({ url: MOCK_URL, ariaSnapshot: baselineRaw });
    const baseline = deriveFingerprint(baselineRaw);
    const current = deriveFingerprint(currentRaw);

    return {
      label: 'REAL (captured via Playwright): "Add Location" button removed from the locations list',
      input: {
        charter: CHARTER,
        screenId,
        baselineAriaSnapshotMasked: baseline.ariaSnapshotMasked,
        currentAriaSnapshotMasked: current.ariaSnapshotMasked,
      },
    };
  } finally {
    await browser.close();
  }
}

function handWrittenCases(): EvalCase[] {
  return [
    {
      label: 'HAND-WRITTEN: button relabeled ("Add Location" -> "+ New Location") — likely intended',
      input: {
        charter: CHARTER,
        screenId: "c48994fdd89616ac5ecfc910de83a6421445d921588514dab3eb02912761f525",
        baselineAriaSnapshotMasked: ['- heading "Locations" [level=1]', '- button "Add Location"'].join("\n"),
        currentAriaSnapshotMasked: ['- heading "Locations" [level=1]', '- button "+ New Location"'].join("\n"),
      },
    },
    {
      label: "HAND-WRITTEN: helper banner added above the list — likely intended",
      input: {
        charter: CHARTER,
        screenId: "c48994fdd89616ac5ecfc910de83a6421445d921588514dab3eb02912761f525",
        baselineAriaSnapshotMasked: ['- heading "Locations" [level=1]', "- list", "  - listitem", '    - link "Main Warehouse"'].join("\n"),
        currentAriaSnapshotMasked: [
          '- heading "Locations" [level=1]',
          '- text "Tip: click a location to see its detail page."',
          "- list",
          "  - listitem",
          '    - link "Main Warehouse"',
        ].join("\n"),
      },
    },
    {
      label: "HAND-WRITTEN: list items reordered, same content — likely intended",
      input: {
        charter: CHARTER,
        screenId: "c48994fdd89616ac5ecfc910de83a6421445d921588514dab3eb02912761f525",
        baselineAriaSnapshotMasked: [
          '- heading "Locations" [level=1]',
          "- list",
          "  - listitem",
          '    - link "Main Warehouse"',
          "  - listitem",
          '    - link "Secondary Depot"',
        ].join("\n"),
        currentAriaSnapshotMasked: [
          '- heading "Locations" [level=1]',
          "- list",
          "  - listitem",
          '    - link "Secondary Depot"',
          "  - listitem",
          '    - link "Main Warehouse"',
        ].join("\n"),
      },
    },
  ];
}

function diffSummary(baseline: string, current: string): string {
  if (baseline === current) return "  (identical)";

  const baseLines = new Set(baseline.split("\n"));
  const currentLines = new Set(current.split("\n"));
  const removed = [...baseLines].filter((line) => !currentLines.has(line));
  const added = [...currentLines].filter((line) => !baseLines.has(line));
  const lines = [...removed.map((line) => `  - ${line}`), ...added.map((line) => `  + ${line}`)];
  return lines.length > 0 ? lines.join("\n") : "  (same lines, different order)";
}

function printResult(evalCase: EvalCase, result: Awaited<ReturnType<typeof runJudge>>): void {
  console.log(`\n${"=".repeat(72)}`);
  console.log(evalCase.label);
  console.log("-".repeat(72));
  console.log("divergence:");
  console.log(diffSummary(evalCase.input.baselineAriaSnapshotMasked, evalCase.input.currentAriaSnapshotMasked));
  console.log("-".repeat(72));
  console.log(`verdict:    ${result.verdict}`);
  console.log(`severity:   ${result.severity}`);
  console.log(`confidence: ${result.confidence}`);
  console.log(`reasoning:  ${result.reasoning}`);
  console.log(`cost:       $${result.costUsd.toFixed(6)} (${result.llmCallsUsed} call${result.llmCallsUsed === 1 ? "" : "s"})`);
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log(
      "judge-eval: ANTHROPIC_API_KEY is not set. This script makes real calls to the Anthropic API " +
        "(judge-spec §8 manual sample eval needs a real key). Set it and re-run:\n" +
        "  ANTHROPIC_API_KEY=sk-... npx tsx packages/engine/scripts/judge-eval.ts",
    );
    return;
  }

  let client: Anthropic | undefined;
  const clientFactory = (): Anthropic => (client ??= new Anthropic());

  const cases: EvalCase[] = [await captureRealDivergence(), ...handWrittenCases()];

  console.log(`judge-eval: running ${cases.length} case(s) against the real judge (judge-spec §8 manual sample eval).`);
  console.log("This is a judgment check, not a CI gate — eyeball each verdict below.");

  for (const evalCase of cases) {
    const result = await runJudge(evalCase.input, { clientFactory });
    printResult(evalCase, result);
  }

  console.log(`\n${"=".repeat(72)}`);
  console.log("Done. Review each verdict above against your own judgment of intended-vs-regression.");
}

await main();
