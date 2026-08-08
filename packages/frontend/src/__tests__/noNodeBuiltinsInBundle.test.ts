import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { build } from "vite";

const FORBIDDEN_PATTERNS = ["node:crypto", "node:fs", "node:path", "node:os", "node:child_process", "createCipheriv"];

describe("frontend production bundle", () => {
  it("contains no node: builtin imports (Vite would externalize and crash at runtime)", async () => {
    const root = process.cwd();
    const result = await build({
      root,
      configFile: resolve(root, "vite.config.ts"),
      logLevel: "silent",
      build: { write: false },
    });

    if (!("output" in result) || !Array.isArray(result.output)) {
      throw new Error("expected a single build output with an output array, got an array of outputs or a watcher");
    }

    const chunkSources = result.output
      .filter((chunk): chunk is typeof chunk & { type: "chunk"; code: string } => chunk.type === "chunk")
      .map((chunk) => chunk.code)
      .join("\n");

    for (const pattern of FORBIDDEN_PATTERNS) {
      expect(chunkSources).not.toContain(pattern);
    }
  }, 60_000);
});
