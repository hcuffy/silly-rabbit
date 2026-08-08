import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import Anthropic from "@anthropic-ai/sdk";
import type { LoginCreds } from "@silly-rabbit/driver";
import { resolveCredentialEncryptionKey } from "@silly-rabbit/shared/node";
import { closeMongo, connectMongo } from "./db/connection.js";
import { registerMcpCancelDeleteTools } from "./mcpCancelDeleteTools.js";
import { registerMcpNavMapTools } from "./mcpNavMapTools.js";
import { registerMcpTools, type McpToolDeps } from "./mcpTools.js";
import { AppMapRepo } from "./repos/appMapRepo.js";
import { BaselineRepo } from "./repos/baselineRepo.js";
import { FindingRepo } from "./repos/findingRepo.js";
import { CycleRepo } from "./repos/cycleRepo.js";
import { LearningRepo } from "./repos/learningRepo.js";
import { NavMapRepo } from "./repos/navMapRepo.js";
import { RunRepo } from "./repos/runRepo.js";
import { SessionRecordingRepo } from "./repos/sessionRecordingRepo.js";
import { SessionReplayRunRepo } from "./repos/sessionReplayRunRepo.js";
import { TargetProfileRepo } from "./repos/targetProfileRepo.js";
import { TestRunRepo } from "./repos/testRunRepo.js";
import {
  assertNotDestructive,
  DEFAULT_DESTRUCTIVE_PATTERNS,
  parseAllowedDomains,
  parseProductionUrlPatterns,
  warnIfAllowedDomainsEmpty,
} from "./safety.js";

const BYTES_PER_MB = 1024 * 1024;
const DEFAULT_SCREENSHOT_STORAGE_CAP_MB = 500;
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

async function main(): Promise<void> {
  const mongoUri = process.env.MONGO_URI ?? "mongodb://localhost:27017/silly-rabbit";
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
  const charterNav = { locationsPath: process.env.TARGET_LOCATIONS_PATH || undefined };

  const credentialEncryptionKeyPath = process.env.CREDENTIAL_ENCRYPTION_KEY_PATH || DEFAULT_CREDENTIAL_ENCRYPTION_KEY_PATH;
  const credentialEncryptionKey = await resolveCredentialEncryptionKey(process.env, credentialEncryptionKeyPath);

  const connection = await connectMongo(mongoUri);

  const runRepo = new RunRepo(connection.db);
  const findingRepo = new FindingRepo(connection.db);
  const baselineRepo = new BaselineRepo(connection.db);
  const appMapRepo = new AppMapRepo(connection.db);
  const testRunRepo = new TestRunRepo(connection.db);
  const learningRepo = new LearningRepo(connection.db);
  const sessionRecordingRepo = new SessionRecordingRepo(connection.db);
  const sessionReplayRunRepo = new SessionReplayRunRepo(connection.db);
  const targetProfileRepo = new TargetProfileRepo(connection.db, credentialEncryptionKey);
  const navMapRepo = new NavMapRepo(connection.db);
  const cycleRepo = new CycleRepo(connection.db);
  await runRepo.ensureIndexes();
  await findingRepo.ensureIndexes();
  await testRunRepo.ensureIndexes();
  await learningRepo.ensureIndexes();
  await sessionRecordingRepo.ensureIndexes();
  await sessionReplayRunRepo.ensureIndexes();
  await targetProfileRepo.ensureIndexes();
  await navMapRepo.ensureIndexes();
  await cycleRepo.ensureIndexes();
  await cycleRepo.ensureDefaultCycle();

  let judgeClient: Anthropic | undefined;
  const judgeClientFactory = (): Anthropic => (judgeClient ??= new Anthropic());

  const mcpToolDeps: McpToolDeps = {
    runRepo,
    findingRepo,
    baselineRepo,
    appMapRepo,
    testRunRepo,
    learningRepo,
    sessionRecordingRepo,
    sessionReplayRunRepo,
    targetProfileRepo,
    navMapRepo,
    cycleRepo,
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
    onBeforeAction: (action) => assertNotDestructive(action, DEFAULT_DESTRUCTIVE_PATTERNS),
  };

  const mcpServer = new McpServer({ name: "silly-rabbit", version: "1.0.0" });
  registerMcpTools(mcpServer, mcpToolDeps);
  registerMcpCancelDeleteTools(mcpServer, mcpToolDeps);
  registerMcpNavMapTools(mcpServer, mcpToolDeps);

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  process.on("SIGINT", () => void closeMongo(connection).then(() => process.exit(0)));
  process.on("SIGTERM", () => void closeMongo(connection).then(() => process.exit(0)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
