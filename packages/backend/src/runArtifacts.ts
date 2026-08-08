import { generateReproSpec } from "@silly-rabbit/driver";
import type { CapturedObservation } from "@silly-rabbit/engine";
import type { Baseline, Finding } from "@silly-rabbit/shared";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { enforceScreenshotStorageCap } from "./screenshotRetention.js";

export interface ScreenInfo {
  observation: CapturedObservation;
  screenId: string;
  normalizedUrl: string;
  headingAnchor: string;
}

export async function attachReproSpecs(
  findings: Finding[],
  screens: ScreenInfo[],
  reproSpecDirectory: string,
): Promise<Finding[]> {
  const urlByScreenId = new Map(screens.map((screen) => [screen.screenId, screen.observation.url]));
  const result: Finding[] = [];

  for (const finding of findings) {
    if (finding.verdict !== "REGRESSION") {
      result.push(finding);
      continue;
    }
    const url = urlByScreenId.get(finding.screenId);
    if (!url) {
      result.push(finding);
      continue;
    }

    await mkdir(reproSpecDirectory, { recursive: true });
    const reproSpecPath = join(reproSpecDirectory, `${finding.id}.spec.ts`);
    await writeFile(reproSpecPath, generateReproSpec({ finding, url }), "utf8");
    result.push({ ...finding, reproSpecPath });
  }

  return result;
}

function buildScreenshotBufferMap(screens: ScreenInfo[]): Map<string, Buffer> {
  return new Map(
    screens
      .filter((screen): screen is ScreenInfo & { observation: { screenshotBuffer: Buffer } } =>
        Boolean(screen.observation.screenshotBuffer),
      )
      .map((screen) => [screen.screenId, screen.observation.screenshotBuffer]),
  );
}

async function writeScreenshotFile(
  screenshotDirectory: string,
  fileName: string,
  buffer: Buffer,
  screenshotStorageCapBytes: number,
): Promise<string> {
  await mkdir(screenshotDirectory, { recursive: true });
  const path = join(screenshotDirectory, fileName);
  await writeFile(path, buffer);
  await enforceScreenshotStorageCap(screenshotDirectory, screenshotStorageCapBytes);
  return path;
}

export async function attachScreenshots(
  findings: Finding[],
  screens: ScreenInfo[],
  screenshotDirectory: string,
  screenshotStorageCapBytes: number,
): Promise<Finding[]> {
  const bufferByScreenId = buildScreenshotBufferMap(screens);
  if (bufferByScreenId.size === 0) return findings;

  const result: Finding[] = [];
  for (const finding of findings) {
    const buffer = bufferByScreenId.get(finding.screenId);
    if (!buffer) {
      result.push(finding);
      continue;
    }
    const screenshotPath = await writeScreenshotFile(screenshotDirectory, `${finding.id}.png`, buffer, screenshotStorageCapBytes);
    result.push({ ...finding, screenshotPath });
  }

  return result;
}

export async function attachBaselineScreenshots(
  baselines: Baseline[],
  screens: ScreenInfo[],
  screenshotDirectory: string,
  screenshotStorageCapBytes: number,
): Promise<Baseline[]> {
  const bufferByScreenId = buildScreenshotBufferMap(screens);
  if (bufferByScreenId.size === 0) return baselines;

  const result: Baseline[] = [];
  for (const baseline of baselines) {
    const buffer = bufferByScreenId.get(baseline.screenId);
    if (!buffer) {
      result.push(baseline);
      continue;
    }
    const fileName = `baseline-${baseline.screenId}.png`;
    const baselineScreenshotPath = await writeScreenshotFile(screenshotDirectory, fileName, buffer, screenshotStorageCapBytes);
    result.push({ ...baseline, baselineScreenshotPath });
  }

  return result;
}
