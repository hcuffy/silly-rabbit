import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { computePixelDiffScore } from "../pixelDiff.js";

function solidColorPng(width: number, height: number, [red, green, blue]: [number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let pixelIndex = 0; pixelIndex < width * height; pixelIndex++) {
    const offset = pixelIndex * 4;
    png.data[offset] = red;
    png.data[offset + 1] = green;
    png.data[offset + 2] = blue;
    png.data[offset + 3] = 255;
  }
  return PNG.sync.write(png);
}

function halfBlackHalfWhitePng(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const value = x < width / 2 ? 0 : 255;
      png.data[offset] = value;
      png.data[offset + 1] = value;
      png.data[offset + 2] = value;
      png.data[offset + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

describe("computePixelDiffScore (pixel-diff phase 1 — computation only, no verdict/confidence logic)", () => {
  it("returns 0 for two identical images", () => {
    const before = solidColorPng(10, 10, [255, 0, 0]);
    const after = solidColorPng(10, 10, [255, 0, 0]);
    expect(computePixelDiffScore(before, after)).toBe(0);
  });

  it("returns 1 for two fully mismatched images", () => {
    const before = solidColorPng(10, 10, [255, 0, 0]);
    const after = solidColorPng(10, 10, [0, 255, 0]);
    expect(computePixelDiffScore(before, after)).toBe(1);
  });

  it("returns a partial score proportional to the mismatched fraction", () => {
    const before = solidColorPng(10, 10, [0, 0, 0]);
    const after = halfBlackHalfWhitePng(10, 10);
    expect(computePixelDiffScore(before, after)).toBeCloseTo(0.5, 1);
  });

  it("returns undefined when the two images have different dimensions — cannot fake a comparison", () => {
    const before = solidColorPng(10, 10, [255, 0, 0]);
    const after = solidColorPng(20, 20, [255, 0, 0]);
    expect(computePixelDiffScore(before, after)).toBeUndefined();
  });
});
