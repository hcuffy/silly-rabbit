import {
  assertAllowedUrl,
  assertNotDestructive,
  assertNotProductionUrl,
  DEFAULT_DESTRUCTIVE_PATTERNS,
  parseAllowedDomains,
  parseProductionUrlPatterns,
  SafetyViolation,
  type ActionDescriptor,
  type NetworkCapture,
  type SessionRecordingStep,
} from "@silly-rabbit/shared";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { closeMongo, connectMongo } from "./runStore.js";
import { attachSessionCapture, type RawNetworkCapture } from "./sessionCapture.js";
import { enforceSessionCaptureStorageCap } from "./sessionCaptureRetention.js";
import { SessionRecordingStore } from "./sessionRecordingStore.js";

const DEFAULT_MONGO_URI = "mongodb://localhost:27017/silly-rabbit";
const DEFAULT_SESSION_CAPTURE_DIR = "./session-captures";
const DEFAULT_SESSION_CAPTURE_STORAGE_CAP_MB = 500;
const BYTES_PER_MB = 1024 * 1024;

async function persistNetworkCaptures(
  sessionId: string,
  rawCaptures: RawNetworkCapture[],
  captureDirectory: string,
  captureStorageCapBytes: number,
): Promise<NetworkCapture[]> {
  if (rawCaptures.length === 0) return [];

  const sessionDirectory = join(captureDirectory, sessionId);
  await mkdir(sessionDirectory, { recursive: true });

  const persisted: NetworkCapture[] = [];
  for (const [index, raw] of rawCaptures.entries()) {
    const bodyPath = join(sessionDirectory, `${index}.json`);
    await writeFile(bodyPath, raw.body);
    await enforceSessionCaptureStorageCap(captureDirectory, captureStorageCapBytes);
    persisted.push({ url: raw.url, method: raw.method, status: raw.status, bodyPath, timestampOffsetMs: raw.timestampOffsetMs });
  }
  return persisted;
}

export function logDestructiveAttempt(step: SessionRecordingStep): void {
  if (step.action !== "click" || step.selectorStrategy !== "role" || !step.role || !step.accessibleName) return;

  const action: ActionDescriptor = { role: step.role, accessibleName: step.accessibleName };
  try {
    assertNotDestructive(action, DEFAULT_DESTRUCTIVE_PATTERNS);
  } catch (error) {
    if (!(error instanceof SafetyViolation)) throw error;
    console.warn(`[record-session] DESTRUCTIVE ACTION CLICKED (not blocked — recording is passive-logger only): ${error.message}`);
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { target: { type: "string" } } });

  if (!values.target) {
    throw new Error('usage: record-session --target "https://dev.example.com/app"');
  }
  const target = values.target;

  const allowedDomains = parseAllowedDomains(process.env.ALLOWED_DOMAINS);
  const productionUrlPatterns = parseProductionUrlPatterns(process.env.PROD_URL_PATTERNS);
  assertAllowedUrl(target, allowedDomains);
  assertNotProductionUrl(target, productionUrlPatterns);

  const sessionId = randomUUID();
  const recordedAt = new Date();

  const browser = await chromium.launch({ headless: false });
  try {
    const page = await browser.newPage();
    const targetOrigin = new URL(target).origin;
    const capture = await attachSessionCapture(page, recordedAt, targetOrigin, { onStep: logDestructiveAttempt });
    await page.goto(target);

    console.log(`[record-session] recording started (session ${sessionId}) — drive the browser, close it when done.`);
    await new Promise<void>((resolve) => browser.on("disconnected", () => resolve()));

    const steps = capture.getSteps();
    const rawNetworkCaptures = capture.getNetworkCaptures();
    console.log(
      `[record-session] recording ended — ${steps.length} step(s), ${rawNetworkCaptures.length} network response(s) captured.`,
    );

    const captureDirectory = process.env.SESSION_CAPTURE_DIR ?? DEFAULT_SESSION_CAPTURE_DIR;
    const captureStorageCapBytes =
      Number(process.env.SESSION_CAPTURE_STORAGE_CAP_MB ?? DEFAULT_SESSION_CAPTURE_STORAGE_CAP_MB) * BYTES_PER_MB;
    const networkCaptures = await persistNetworkCaptures(sessionId, rawNetworkCaptures, captureDirectory, captureStorageCapBytes);

    const mongoConnection = await connectMongo(process.env.MONGO_URI ?? DEFAULT_MONGO_URI);
    try {
      const store = new SessionRecordingStore(mongoConnection.db);
      await store.create({ sessionId, targetBaseUrl: target, recordedAt, steps, networkCaptures });
      console.log(`[record-session] session ${sessionId} persisted (${steps.length} step(s)).`);
    } finally {
      await closeMongo(mongoConnection);
    }
  } finally {
    if (browser.isConnected()) await browser.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
