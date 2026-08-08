import Anthropic from "@anthropic-ai/sdk";
import { deriveScreenId, runEngineLoop } from "@silly-rabbit/engine";
import {
  assertAllowedUrl,
  assertNotDestructive,
  assertNotProductionUrl,
  buildTargetProfileOverrides,
  DEFAULT_DESTRUCTIVE_PATTERNS,
  parseAllowedDomains,
  parseProductionUrlPatterns,
  type ActionDescriptor,
} from "@silly-rabbit/shared";
import { resolveCredentialEncryptionKey } from "@silly-rabbit/shared/node";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { explore } from "./explore.js";
import { applyEngineOutput, loadLocalStore, saveLocalStore } from "./localStore.js";
import type { LoginCreds } from "./login.js";
import type { MockSeed, MockVariant } from "./mock/pages.js";
import { installMockTarget } from "./mock/routes.js";
import { generateReproSpec } from "./reproSpec.js";
import { incrementAndGetRunNumber, resolveCycleByNameOrId } from "./cycleStore.js";
import { closeMongo, connectMongo, RunStore } from "./runStore.js";
import { resolveTargetProfileByNameOrId } from "./targetProfileStore.js";
import { getTriggeredBy } from "./triggeredBy.js";

const DEFAULT_MONGO_URI = "mongodb://localhost:27017/silly-rabbit";
const DEFAULT_CREDENTIAL_ENCRYPTION_KEY_PATH = "../../.silly-rabbit/credential-encryption-key";

const MOCK_BASE_URL = "http://mock.local";

const HELP_TEXT = `explore — run a charter-scripted Silly Rabbit check.

Usage:
  explore --charter <text> --run <run-id> [options]

Required:
  --charter <text>   Plain-language instruction, e.g. "test the locations flow"
  --run <id>         An identifier for this run (yours to pick, e.g. "local-1")

Options:
  --variant <name>   baseline | volatile-only | changed-regression (default: baseline)
  --state <path>     Local baseline/finding store (default: .silly-rabbit/driver-state.json)
  --out <dir>        Directory for generated repro specs (default: ./repro-specs)
  --profile <name-or-id>  Use a saved target profile's baseUrl/login/allowedDomains instead
                          of env vars (fully replaces them, not a per-field merge)
  --cycle <name-or-id>    Attach this run to a cycle (sprint/release) for cycle-scoped
                          numbering — omitted means uncycled, exactly as before this flag existed
  --help, -h         Show this help and exit

Zero-config demo (no .env edits needed beyond \`cp .env.example .env\` + \`pnpm db:up\`):
  Runs against a bundled mock target automatically whenever TARGET_BASE_URL is unset.

  # 1. Learn a baseline against the demo target — no target/API config needed
  pnpm --filter driver explore --charter "test the locations flow" --run demo-1

  # 2. Same charter, a deliberately changed variant — detects a real regression
  pnpm --filter driver explore --charter "test the locations flow" --run demo-2 --variant changed-regression

Point at a real target: set TARGET_BASE_URL (and, for auto-login, the six TARGET_LOGIN_URL/
EMAIL/PASSWORD/*_SELECTOR vars) in .env — see README's "Configure your real target" section.`;

function buildSeed(): MockSeed {
  return { recordId: randomUUID(), timestamp: new Date().toISOString(), count: 12 };
}

const REQUIRED_REAL_TARGET_VARS = [
  "TARGET_LOGIN_URL",
  "TARGET_EMAIL",
  "TARGET_PASSWORD",
  "TARGET_EMAIL_SELECTOR",
  "TARGET_PASSWORD_SELECTOR",
  "TARGET_SUBMIT_SELECTOR",
] as const;

function resolveRealTargetLoginCreds(): LoginCreds | undefined {
  const baseUrl = process.env.TARGET_BASE_URL;
  if (!baseUrl) return undefined;

  const missing = REQUIRED_REAL_TARGET_VARS.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(
      `TARGET_BASE_URL is set but missing required env var(s): ${missing.join(", ")}`,
    );
  }

  return {
    loginUrl: process.env.TARGET_LOGIN_URL!,
    email: process.env.TARGET_EMAIL!,
    password: process.env.TARGET_PASSWORD!,
    emailSelector: process.env.TARGET_EMAIL_SELECTOR!,
    passwordSelector: process.env.TARGET_PASSWORD_SELECTOR!,
    submitSelector: process.env.TARGET_SUBMIT_SELECTOR!,
    nextSelector: process.env.TARGET_NEXT_SELECTOR,
    timeoutMs: process.env.TIMEOUT_MS ? Number(process.env.TIMEOUT_MS) : undefined,
    loginReadyTimeoutMs: process.env.LOGIN_READY_TIMEOUT_MS
      ? Number(process.env.LOGIN_READY_TIMEOUT_MS)
      : undefined,
  };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      charter: { type: "string" },
      run: { type: "string" },
      variant: { type: "string", default: "baseline" },
      state: { type: "string", default: ".silly-rabbit/driver-state.json" },
      out: { type: "string", default: "./repro-specs" },
      profile: { type: "string" },
      cycle: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(HELP_TEXT);
    return;
  }

  if (!values.charter || !values.run) {
    throw new Error(
      'usage: explore --charter "test the locations flow" --run <run-id> ' +
        "[--variant baseline|volatile-only|changed-regression] [--state path] [--out dir] " +
        "(--help for full usage and examples)",
    );
  }
  const charter = values.charter;
  const runId = values.run;
  const variant = values.variant as MockVariant;
  const statePath = values.state;
  const outputDirectory = values.out;
  const seed = buildSeed();

  let judgeClient: Anthropic | undefined;
  const judgeClientFactory = (): Anthropic => (judgeClient ??= new Anthropic());
  const maxLlmCalls = Number(process.env.MAX_LLM_CALLS ?? 25);
  const maxUsdPerRun = Number(process.env.MAX_USD_PER_RUN ?? 1.0);

  const mongoConnection = await connectMongo(process.env.MONGO_URI ?? DEFAULT_MONGO_URI);
  try {
    let loginCreds = resolveRealTargetLoginCreds();
    let baseUrl = process.env.TARGET_BASE_URL ?? MOCK_BASE_URL;
    let allowedDomains = parseAllowedDomains(process.env.ALLOWED_DOMAINS);
    let locationsPath = process.env.TARGET_LOCATIONS_PATH || undefined;
    const productionUrlPatterns = parseProductionUrlPatterns(process.env.PROD_URL_PATTERNS);

    if (values.profile) {
      const credentialEncryptionKeyPath = process.env.CREDENTIAL_ENCRYPTION_KEY_PATH || DEFAULT_CREDENTIAL_ENCRYPTION_KEY_PATH;
      const credentialEncryptionKey = await resolveCredentialEncryptionKey(process.env, credentialEncryptionKeyPath);
      const profile = await resolveTargetProfileByNameOrId(mongoConnection.db, values.profile, credentialEncryptionKey);
      if (!profile) throw new Error(`target profile not found: "${values.profile}"`);

      const overrides = buildTargetProfileOverrides(profile);
      loginCreds = overrides.loginCreds;
      baseUrl = overrides.baseUrl;
      allowedDomains = overrides.allowedDomains;
      locationsPath = overrides.charterNav.locationsPath;
    }

    if (loginCreds) {
      assertAllowedUrl(baseUrl, allowedDomains);
      assertNotProductionUrl(baseUrl, productionUrlPatterns);
      assertAllowedUrl(loginCreds.loginUrl, allowedDomains);
      assertNotProductionUrl(loginCreds.loginUrl, productionUrlPatterns);
    }

    let cycleFields: { cycleId?: string; cycleRunNumber?: number } = {};
    if (values.cycle) {
      const cycle = await resolveCycleByNameOrId(mongoConnection.db, values.cycle);
      if (!cycle) throw new Error(`cycle not found: "${values.cycle}"`);
      const cycleRunNumber = await incrementAndGetRunNumber(mongoConnection.db, cycle.id);
      cycleFields = cycleRunNumber === undefined ? {} : { cycleId: cycle.id, cycleRunNumber };
    }

    const runStore = new RunStore(mongoConnection.db);
    const mongoRunId = randomUUID();
    await runStore.create({
      id: mongoRunId,
      charter,
      targetBaseUrl: baseUrl,
      status: "RUNNING",
      startedAt: new Date(),
      stepsUsed: 0,
      llmCallsUsed: 0,
      costUsd: 0,
      triggeredBy: getTriggeredBy(),
      ...cycleFields,
    });

    const browser = await chromium.launch();
    try {
      const store = await loadLocalStore(statePath);

      const observations = await explore({
        charter,
        baseUrl,
        browser,
        loginCreds,
        installRoutes: loginCreds
          ? undefined
          : (context) => installMockTarget(context, variant, seed),
        charterNav: { locationsPath },
        onBeforeNavigate: loginCreds
          ? (url) => {
              assertAllowedUrl(url, allowedDomains);
              assertNotProductionUrl(url, productionUrlPatterns);
            }
          : undefined,
        onBeforeAction: loginCreds
          ? (action: ActionDescriptor) => assertNotDestructive(action, DEFAULT_DESTRUCTIVE_PATTERNS)
          : undefined,
      });

      const output = await runEngineLoop({
        runId,
        charter,
        observations,
        existingBaselines: store.baselines,
        existingFindings: store.findings,
        judge: { clientFactory: judgeClientFactory },
        maxLlmCalls,
        maxUsdPerRun,
      });

      const urlByScreenId = new Map(
        observations.map((observation) => [deriveScreenId(observation).screenId, observation.url]),
      );

      const reproSpecPaths: string[] = [];
      for (const finding of output.findings) {
        if (finding.verdict !== "REGRESSION") continue;
        const url = urlByScreenId.get(finding.screenId);
        if (!url) continue;

        await mkdir(outputDirectory, { recursive: true });
        const specPath = join(outputDirectory, `${finding.id}.spec.ts`);
        await writeFile(specPath, generateReproSpec({ finding, url }), "utf8");
        reproSpecPaths.push(specPath);
      }

      await saveLocalStore(statePath, applyEngineOutput(store, output));

      await runStore.updateStatus(mongoRunId, {
        status: "COMPLETED",
        finishedAt: new Date(),
        stepsUsed: observations.length,
        llmCallsUsed: output.llmCallsUsed,
        costUsd: output.costUsd,
      });

      console.log(
        JSON.stringify(
          { runId, triggeredBy: getTriggeredBy(), newBaselines: output.baselines.length, findings: output.findings, reproSpecPaths },
          null,
          2,
        ),
      );
    } catch (error) {
      await runStore.updateStatus(mongoRunId, {
        status: "FAILED",
        finishedAt: new Date(),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      await browser.close();
    }
  } finally {
    await closeMongo(mongoConnection);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
