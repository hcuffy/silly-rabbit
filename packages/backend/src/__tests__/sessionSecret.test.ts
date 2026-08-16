import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSessionSecret } from "../sessionSecret.js";

describe("resolveSessionSecret (onboarding-friction fix — SESSION_SECRET auto-generation)", () => {
  let directory: string;
  let secretPath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "silly-rabbit-session-secret-"));
    secretPath = join(directory, "session-secret");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("an explicit SESSION_SECRET in the environment always wins, no file touched", async () => {
    const secret = await resolveSessionSecret({ SESSION_SECRET: "explicit-secret" }, secretPath);

    expect(secret).toBe("explicit-secret");
    await expect(readFile(secretPath, "utf8")).rejects.toThrow();
  });

  it("no env var, no file yet: generates a real crypto-random secret and persists it", async () => {
    const secret = await resolveSessionSecret({}, secretPath);

    expect(secret).toMatch(/^[0-9a-f]{64}$/); // 32 bytes hex — real entropy, not a placeholder
    expect(await readFile(secretPath, "utf8")).toBe(secret);
  });

  it(
    "survives a simulated restart: a second process-like call with no env var reads back the " +
      "SAME persisted secret instead of generating a new one — the actual point of this fix, proven " +
      "not assumed",
    async () => {
      const firstBoot = await resolveSessionSecret({}, secretPath);
      const secondBoot = await resolveSessionSecret({}, secretPath); // simulates a fresh process, same file

      expect(secondBoot).toBe(firstBoot);
    },
  );

  it("creates the parent directory if it doesn't exist yet (fresh .silly-rabbit/-style setup)", async () => {
    const nestedPath = join(directory, "nested", "does", "not", "exist", "session-secret");

    const secret = await resolveSessionSecret({}, nestedPath);

    expect(await readFile(nestedPath, "utf8")).toBe(secret);
  });

  it(
    "a present but empty/whitespace-only persisted file is treated as absent — regenerates rather " + "than returning an empty signing secret",
    async () => {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(secretPath, "   \n", "utf8");

      const secret = await resolveSessionSecret({}, secretPath);

      expect(secret.trim().length).toBeGreaterThan(0);
      expect(await readFile(secretPath, "utf8")).toBe(secret);
    },
  );
});
