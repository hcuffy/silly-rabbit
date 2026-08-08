import { mkdtemp, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { enforceScreenshotStorageCap } from "../screenshotRetention.js";

async function writeAgedFile(directory: string, name: string, sizeBytes: number, ageSeconds: number): Promise<void> {
  await writeFile(join(directory, name), Buffer.alloc(sizeBytes));
  const mtime = new Date(Date.now() - ageSeconds * 1000);
  await utimes(join(directory, name), mtime, mtime);
}

function makeTemporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "silly-rabbit-screenshot-retention-"));
}

describe("enforceScreenshotStorageCap (screenshot-retention-spec Option C + purge-on-write)", () => {
  it("does nothing when total size is under the cap", async () => {
    const directory = await makeTemporaryDirectory();
    await writeAgedFile(directory, "a.png", 100, 60);
    await writeAgedFile(directory, "b.png", 100, 30);

    await enforceScreenshotStorageCap(directory, 1000);

    expect((await readdir(directory)).sort()).toEqual(["a.png", "b.png"]);
  });

  it("deletes the oldest file(s) first once the cap is exceeded, keeping the newest", async () => {
    const directory = await makeTemporaryDirectory();
    await writeAgedFile(directory, "oldest.png", 100, 300);
    await writeAgedFile(directory, "middle.png", 100, 200);
    await writeAgedFile(directory, "newest.png", 100, 100);

    await enforceScreenshotStorageCap(directory, 250);

    expect((await readdir(directory)).sort()).toEqual(["middle.png", "newest.png"]);
  });

  it("deletes multiple oldest files if needed to get back under the cap", async () => {
    const directory = await makeTemporaryDirectory();
    await writeAgedFile(directory, "oldest.png", 100, 300);
    await writeAgedFile(directory, "middle.png", 100, 200);
    await writeAgedFile(directory, "newest.png", 100, 100);

    await enforceScreenshotStorageCap(directory, 100);

    expect(await readdir(directory)).toEqual(["newest.png"]);
  });

  it("is a no-op on a directory that doesn't exist yet — never throws", async () => {
    const directory = join(await makeTemporaryDirectory(), "does-not-exist");
    await expect(enforceScreenshotStorageCap(directory, 1000)).resolves.toBeUndefined();
  });

  it("leaves everything in place when total size exactly equals the cap", async () => {
    const directory = await makeTemporaryDirectory();
    await writeAgedFile(directory, "a.png", 100, 60);
    await writeAgedFile(directory, "b.png", 100, 30);

    await enforceScreenshotStorageCap(directory, 200);

    expect((await readdir(directory)).sort()).toEqual(["a.png", "b.png"]);
  });
});
