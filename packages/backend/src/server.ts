import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import type { ActionDescriptor, LoginCreds } from "@silly-rabbit/driver";
import { resolveCredentialEncryptionKey } from "@silly-rabbit/shared/node";
import { buildApp } from "./app.js";
import { closeMongo, connectMongo } from "./db/connection.js";
import { ActiveCycleRepo } from "./repos/activeCycleRepo.js";
import { ActiveTargetProfileRepo } from "./repos/activeTargetProfileRepo.js";
import { AppMapRepo } from "./repos/appMapRepo.js";
import { BaselineRepo } from "./repos/baselineRepo.js";
import { CycleRepo } from "./repos/cycleRepo.js";
import { FeatureDocumentRepo } from "./repos/featureDocumentRepo.js";
import { FindingRepo } from "./repos/findingRepo.js";
import { LearningRepo } from "./repos/learningRepo.js";
import { NavMapRepo } from "./repos/navMapRepo.js";
import { RunRepo } from "./repos/runRepo.js";
import { SessionRecordingRepo } from "./repos/sessionRecordingRepo.js";
import { SessionReplayRunRepo } from "./repos/sessionReplayRunRepo.js";
import { TargetProfileRepo } from "./repos/targetProfileRepo.js";
import { TestRunRepo } from "./repos/testRunRepo.js";
import { waitForInFlightRuns } from "./orchestrator.js";
import {
  assertAllowedUrl,
  assertNotDestructive,
  assertNotProductionUrl,
  assertRollbackDeleteAllowed,
  DEFAULT_DESTRUCTIVE_PATTERNS,
  parseAllowedDomains,
  parseProductionUrlPatterns,
  warnIfAllowedDomainsEmpty,
} from "./safety.js";
import { resolveSessionSecret } from "./sessionSecret.js";

const SHUTDOWN_RUN_DRAIN_TIMEOUT_MS = 10_000;
const BYTES_PER_MB = 1024 * 1024;
const DEFAULT_SCREENSHOT_STORAGE_CAP_MB = 500;
const DEFAULT_SESSION_SECRET_PATH = "../../.silly-rabbit/session-secret";
const DEFAULT_CREDENTIAL_ENCRYPTION_KEY_PATH = "../../.silly-rabbit/credential-encryption-key";

function parseLoginCreds(environment: NodeJS.ProcessEnv): LoginCreds | undefined {
  const { TARGET_LOGIN_URL, TARGET_EMAIL, TARGET_PASSWORD,
          TARGET_EMAIL_SELECTOR, TARGET_PASSWORD_SELECTOR, TARGET_SUBMIT_SELECTOR,
          TARGET_NEXT_SELECTOR, TIMEOUT_MS, LOGIN_READY_TIMEOUT_MS } = environment;
  if (!TARGET_LOGIN_URL || !TARGET_EMAIL || !TARGET_PASSWORD ||
      !TARGET_EMAIL_SELECTOR || !TARGET_PASSWORD_SELECTOR || !TARGET_SUBMIT_SELECTOR) {
    return undefined;
  }
  return {
    loginUrl: TARGET_LOGIN_URL,
    email: TARGET_EMAIL,
    password: TARGET_PASSWORD,
    emailSelector: TARGET_EMAIL_SELECTOR,
    passwordSelector: TARGET_PASSWORD_SELECTOR,
    submitSelector: TARGET_SUBMIT_SELECTOR,
    nextSelector: TARGET_NEXT_SELECTOR || undefined,
    timeoutMs: TIMEOUT_MS ? Number(TIMEOUT_MS) : undefined,
    loginReadyTimeoutMs: LOGIN_READY_TIMEOUT_MS ? Number(LOGIN_READY_TIMEOUT_MS) : undefined,
  };
}

function parseCorsOrigins(environmentValue: string | undefined): string[] {
  return (environmentValue ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function requireEnvironmentVariable(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`${name} environment variable is required`);
  return value;
}

function parseCookieSameSite(environmentValue: string | undefined): "lax" | "none" | "strict" {
  if (environmentValue === "none" || environmentValue === "strict") return environmentValue;
  return "lax";
}

async function main(): Promise<void> {
  const mongoUri = process.env.MONGO_URI ?? "mongodb://localhost:27017/silly-rabbit";
  const port = Number(process.env.PORT ?? 8000);
  const reproSpecDirectory = process.env.REPRO_SPEC_DIR ?? "./repro-specs";
  const screenshotDirectory = process.env.SCREENSHOT_DIR ?? "./screenshots";
  const screenshotStorageCapBytes = Number(process.env.SCREENSHOT_STORAGE_CAP_MB ?? DEFAULT_SCREENSHOT_STORAGE_CAP_MB) * BYTES_PER_MB;
  const maxLlmCalls = Number(process.env.MAX_LLM_CALLS ?? 25);
  const maxUsdPerRun = Number(process.env.MAX_USD_PER_RUN ?? 1.0);
  const maxSteps = Number(process.env.MAX_STEPS ?? 40);
  const maxConcurrentRuns = Number(process.env.MAX_CONCURRENT_RUNS ?? 3);
  const loginCreds = parseLoginCreds(process.env);
  const storageState = process.env.STORAGE_STATE_PATH || undefined;
  const allowedDomains = parseAllowedDomains(process.env.ALLOWED_DOMAINS);
  warnIfAllowedDomainsEmpty(allowedDomains);
  const productionUrlPatterns = parseProductionUrlPatterns(process.env.PROD_URL_PATTERNS);
  const corsOrigins = parseCorsOrigins(process.env.CORS_ORIGIN ?? "http://localhost:5173");
  const charterNav = { locationsPath: process.env.TARGET_LOCATIONS_PATH || undefined };
  const dashboardPassword = requireEnvironmentVariable(process.env, "DASHBOARD_PASSWORD");
  const sessionSecretPath = process.env.SESSION_SECRET_PATH || DEFAULT_SESSION_SECRET_PATH;
  const sessionSecret = await resolveSessionSecret(process.env, sessionSecretPath);
  const credentialEncryptionKeyPath = process.env.CREDENTIAL_ENCRYPTION_KEY_PATH || DEFAULT_CREDENTIAL_ENCRYPTION_KEY_PATH;
  const credentialEncryptionKey = await resolveCredentialEncryptionKey(process.env, credentialEncryptionKeyPath);
  const cookieSecure = process.env.COOKIE_SECURE === "true";
  const cookieSameSite = parseCookieSameSite(process.env.COOKIE_SAME_SITE);
  const trustProxy = process.env.TRUST_PROXY === "true";

  const connection = await connectMongo(mongoUri);

  const runRepo = new RunRepo(connection.db);
  const findingRepo = new FindingRepo(connection.db);
  const baselineRepo = new BaselineRepo(connection.db);
  const appMapRepo = new AppMapRepo(connection.db);
  const testRunRepo = new TestRunRepo(connection.db);
  const learningRepo = new LearningRepo(connection.db);
  const featureDocumentRepo = new FeatureDocumentRepo(connection.db);
  const sessionRecordingRepo = new SessionRecordingRepo(connection.db);
  const sessionReplayRunRepo = new SessionReplayRunRepo(connection.db);
  const targetProfileRepo = new TargetProfileRepo(connection.db, credentialEncryptionKey);
  const activeTargetProfileRepo = new ActiveTargetProfileRepo(connection.db);
  const navMapRepo = new NavMapRepo(connection.db);
  const cycleRepo = new CycleRepo(connection.db);
  const activeCycleRepo = new ActiveCycleRepo(connection.db);
  await runRepo.ensureIndexes();
  await findingRepo.ensureIndexes();
  await testRunRepo.ensureIndexes();
  await learningRepo.ensureIndexes();
  await featureDocumentRepo.ensureIndexes();
  await sessionRecordingRepo.ensureIndexes();
  await sessionReplayRunRepo.ensureIndexes();
  await targetProfileRepo.ensureIndexes();
  await navMapRepo.ensureIndexes();
  await cycleRepo.ensureIndexes();
  await cycleRepo.ensureDefaultCycle();

  let judgeClient: Anthropic | undefined;
  const judgeClientFactory = (): Anthropic => (judgeClient ??= new Anthropic());

  const app = buildApp({
    runRepo,
    findingRepo,
    baselineRepo,
    appMapRepo,
    testRunRepo,
    learningRepo,
    featureDocumentRepo,
    sessionRecordingRepo,
    sessionReplayRunRepo,
    targetProfileRepo,
    activeTargetProfileRepo,
    navMapRepo,
    cycleRepo,
    activeCycleRepo,
    reproSpecDirectory,
    screenshotDirectory,
    screenshotStorageCapBytes,
    judgeClientFactory,
    maxLlmCalls,
    maxUsdPerRun,
    maxSteps,
    maxConcurrentRuns,
    loginCreds,
    storageState,
    allowedDomains,
    productionUrlPatterns,
    charterNav,
    corsOrigins,
    dashboardPassword,
    sessionSecret,
    cookieSecure,
    cookieSameSite,
    trustProxy,
    onBeforeNavigate: (url) => {
      assertAllowedUrl(url, allowedDomains);
      assertNotProductionUrl(url, productionUrlPatterns);
    },
    onBeforeAction: (action: ActionDescriptor) => assertNotDestructive(action, DEFAULT_DESTRUCTIVE_PATTERNS),
    onBeforeRollbackDelete: (action: ActionDescriptor, verifiedMarkerMatch: boolean) =>
      assertRollbackDeleteAllowed(action, verifiedMarkerMatch),
  });

  const shutdown = async (): Promise<void> => {
    await app.close();
    await waitForInFlightRuns(SHUTDOWN_RUN_DRAIN_TIMEOUT_MS);
    await closeMongo(connection);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await app.listen({ port, host: "0.0.0.0" });
}

await main();
