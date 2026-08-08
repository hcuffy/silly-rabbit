import { mkdir, mkdtemp, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { enforceSessionCaptureStorageCap } from "../sessionCaptureRetention.js";

interface AgedCaptureOptions {
  captureDirectory: string;
  sessionId: string;
  name: string;
  sizeBytes: number;
  ageSeconds: number;
}

async function writeAgedCapture(options: AgedCaptureOptions): Promise<void> {
  const sessionDirectory = join(options.captureDirectory, options.sessionId);
  await mkdir(sessionDirectory, { recursive: true });
  const path = join(sessionDirectory, options.name);
  await writeFile(path, Buffer.alloc(options.sizeBytes));
  const mtime = new Date(Date.now() - options.ageSeconds * 1000);
  await utimes(path, mtime, mtime);
}

function makeTemporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "silly-rabbit-session-capture-retention-"));
}

async function listAllCaptureFiles(captureDirectory: string): Promise<string[]> {
  const sessionDirectories = await readdir(captureDirectory);
  const files: string[] = [];
  for (const sessionDirectory of sessionDirectories) {
    const names = await readdir(join(captureDirectory, sessionDirectory));
    files.push(...names.map((name) => `${sessionDirectory}/${name}`));
  }
  return files.sort();
}

describe("enforceSessionCaptureStorageCap (mirrors enforceScreenshotStorageCap's Option C + " +
  "purge-on-write, applied across session subdirectories)", () => {
  it("does nothing when total size is under the cap", async () => {
    const directory = await makeTemporaryDirectory();
    await writeAgedCapture({ captureDirectory: directory, sessionId: "session-a", name: "0.json", sizeBytes: 100, ageSeconds: 60 });
    await writeAgedCapture({ captureDirectory: directory, sessionId: "session-b", name: "0.json", sizeBytes: 100, ageSeconds: 30 });

    await enforceSessionCaptureStorageCap(directory, 1000);

    expect(await listAllCaptureFiles(directory)).toEqual(["session-a/0.json", "session-b/0.json"]);
  });

  it("deletes the oldest capture(s) first once the cap is exceeded, keeping the newest, across session " +
    "subdirectories (not just within one)", async () => {
    const directory = await makeTemporaryDirectory();
    await writeAgedCapture({ captureDirectory: directory, sessionId: "session-a", name: "0.json", sizeBytes: 100, ageSeconds: 300 });
    await writeAgedCapture({ captureDirectory: directory, sessionId: "session-b", name: "0.json", sizeBytes: 100, ageSeconds: 200 });
    await writeAgedCapture({ captureDirectory: directory, sessionId: "session-c", name: "0.json", sizeBytes: 100, ageSeconds: 100 });

    await enforceSessionCaptureStorageCap(directory, 250);

    expect(await listAllCaptureFiles(directory)).toEqual(["session-b/0.json", "session-c/0.json"]);
  });

  it("deletes multiple oldest captures if needed to get back under the cap", async () => {
    const directory = await makeTemporaryDirectory();
    await writeAgedCapture({ captureDirectory: directory, sessionId: "session-a", name: "0.json", sizeBytes: 100, ageSeconds: 300 });
    await writeAgedCapture({ captureDirectory: directory, sessionId: "session-b", name: "0.json", sizeBytes: 100, ageSeconds: 200 });
    await writeAgedCapture({ captureDirectory: directory, sessionId: "session-c", name: "0.json", sizeBytes: 100, ageSeconds: 100 });

    await enforceSessionCaptureStorageCap(directory, 100);

    expect(await listAllCaptureFiles(directory)).toEqual(["session-c/0.json"]);
  });

  it("is a no-op on a directory that doesn't exist yet — never throws", async () => {
    const directory = join(await makeTemporaryDirectory(), "does-not-exist");
    await expect(enforceSessionCaptureStorageCap(directory, 1000)).resolves.toBeUndefined();
  });

  it("leaves everything in place when total size exactly equals the cap", async () => {
    const directory = await makeTemporaryDirectory();
    await writeAgedCapture({ captureDirectory: directory, sessionId: "session-a", name: "0.json", sizeBytes: 100, ageSeconds: 60 });
    await writeAgedCapture({ captureDirectory: directory, sessionId: "session-b", name: "0.json", sizeBytes: 100, ageSeconds: 30 });

    await enforceSessionCaptureStorageCap(directory, 200);

    expect(await listAllCaptureFiles(directory)).toEqual(["session-a/0.json", "session-b/0.json"]);
  });
});
