import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "vite";

let outputDirectory: string;
let builtIndexHtml: string;

describe("frontend production build — favicon and public/ logo assets", () => {
  beforeAll(async () => {
    const root = process.cwd();
    outputDirectory = mkdtempSync(join(tmpdir(), "silly-rabbit-frontend-build-"));
    await build({
      root,
      configFile: resolve(root, "vite.config.ts"),
      logLevel: "silent",
      build: { outDir: outputDirectory, emptyOutDir: true },
    });
    builtIndexHtml = readFileSync(join(outputDirectory, "index.html"), "utf-8");
  }, 60_000);

  afterAll(() => {
    rmSync(outputDirectory, { recursive: true, force: true });
  });

  it("emits 16px and 32px favicon <link rel=icon> tags in the built HTML", () => {
    expect(builtIndexHtml).toMatch(
      /<link rel="icon" type="image\/png" sizes="16x16" href="\/images\/silly-rabbit-favicon-16[^"]*\.png" ?\/?>/,
    );
    expect(builtIndexHtml).toMatch(
      /<link rel="icon" type="image\/png" sizes="32x32" href="\/images\/silly-rabbit-favicon-32[^"]*\.png" ?\/?>/,
    );
  });

  it("emits an apple-touch-icon link using the 180px appicon", () => {
    expect(builtIndexHtml).toMatch(
      /<link rel="apple-touch-icon" sizes="180x180" href="\/images\/silly-rabbit-appicon-180[^"]*\.png" ?\/?>/,
    );
  });

  it("copies every public/images logo asset into the build output at its real Vite static-asset path", () => {
    for (const filename of [
      "silly-rabbit-favicon-16.png",
      "silly-rabbit-favicon-32.png",
      "silly-rabbit-appicon-180.png",
      "silly-rabbit-logo-detailed-1024.png",
    ]) {
      expect(existsSync(join(outputDirectory, "images", filename))).toBe(true);
    }
  });
});
