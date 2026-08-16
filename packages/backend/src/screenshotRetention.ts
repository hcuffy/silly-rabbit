import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

interface ScreenshotFileInfo {
  path: string;
  size: number;
  mtimeMs: number;
}

async function listScreenshotFiles(screenshotDirectory: string): Promise<ScreenshotFileInfo[]> {
  const entries = await readdir(screenshotDirectory).catch(() => []);
  return Promise.all(
    entries
      .filter((name) => name.endsWith(".png"))
      .map(async (name) => {
        const path = join(screenshotDirectory, name);
        const info = await stat(path);
        return { path, size: info.size, mtimeMs: info.mtimeMs };
      }),
  );
}

export async function enforceScreenshotStorageCap(screenshotDirectory: string, maxTotalBytes: number): Promise<void> {
  const files = await listScreenshotFiles(screenshotDirectory);
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);

  let totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  for (const file of files) {
    if (totalBytes <= maxTotalBytes) {
      break;
    }
    await unlink(file.path);
    totalBytes -= file.size;
  }
}
