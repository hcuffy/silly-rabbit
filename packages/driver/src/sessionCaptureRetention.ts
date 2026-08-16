import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

interface SessionCaptureFileInfo {
  path: string;
  size: number;
  mtimeMs: number;
}

async function listSessionCaptureFiles(captureDirectory: string): Promise<SessionCaptureFileInfo[]> {
  const sessionDirectoryNames = await readdir(captureDirectory).catch(() => []);
  const files: SessionCaptureFileInfo[] = [];

  for (const sessionDirectoryName of sessionDirectoryNames) {
    const sessionDirectoryPath = join(captureDirectory, sessionDirectoryName);
    const sessionDirectoryInfo = await stat(sessionDirectoryPath).catch(() => undefined);
    if (!sessionDirectoryInfo?.isDirectory()) {
      continue;
    }

    const captureFileNames = await readdir(sessionDirectoryPath).catch(() => []);
    for (const captureFileName of captureFileNames) {
      if (!captureFileName.endsWith(".json")) {
        continue;
      }
      const path = join(sessionDirectoryPath, captureFileName);
      const info = await stat(path);
      files.push({ path, size: info.size, mtimeMs: info.mtimeMs });
    }
  }
  return files;
}

export async function enforceSessionCaptureStorageCap(captureDirectory: string, maxTotalBytes: number): Promise<void> {
  const files = await listSessionCaptureFiles(captureDirectory);
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
