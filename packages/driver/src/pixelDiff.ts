import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

export function computePixelDiffScore(beforePng: Buffer, afterPng: Buffer): number | undefined {
  const before = PNG.sync.read(beforePng);
  const after = PNG.sync.read(afterPng);
  if (before.width !== after.width || before.height !== after.height) return undefined;

  const totalPixels = before.width * before.height;
  if (totalPixels === 0) return undefined;

  const mismatchedPixels = pixelmatch(before.data, after.data, undefined, before.width, before.height);
  return mismatchedPixels / totalPixels;
}
