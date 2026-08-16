import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptCredential, encryptCredential, resolveCredentialEncryptionKey } from "../credentialCrypto.js";

describe("resolveCredentialEncryptionKey (same auto-generation pattern as SESSION_SECRET)", () => {
  let directory: string;
  let keyPath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "silly-rabbit-credential-key-"));
    keyPath = join(directory, "credential-encryption-key");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("an explicit CREDENTIAL_ENCRYPTION_KEY in the environment always wins, no file touched", async () => {
    const key = await resolveCredentialEncryptionKey({ CREDENTIAL_ENCRYPTION_KEY: "explicit-key" }, keyPath);

    expect(key).toBe("explicit-key");
    await expect(readFile(keyPath, "utf8")).rejects.toThrow();
  });

  it("no env var, no file yet: generates a real crypto-random 32-byte key and persists it", async () => {
    const key = await resolveCredentialEncryptionKey({}, keyPath);

    expect(key).toMatch(/^[0-9a-f]{64}$/); // 32 bytes hex — real entropy, not a placeholder
    expect(await readFile(keyPath, "utf8")).toBe(key);
  });

  it(
    "survives a simulated restart: a second process-like call with no env var reads back the SAME " + "persisted key instead of generating a new one",
    async () => {
      const firstBoot = await resolveCredentialEncryptionKey({}, keyPath);
      const secondBoot = await resolveCredentialEncryptionKey({}, keyPath); // simulates a fresh process, same file

      expect(secondBoot).toBe(firstBoot);
    },
  );

  it("creates the parent directory if it doesn't exist yet (fresh .silly-rabbit/-style setup)", async () => {
    const nestedPath = join(directory, "nested", "does", "not", "exist", "credential-encryption-key");

    const key = await resolveCredentialEncryptionKey({}, nestedPath);

    expect(await readFile(nestedPath, "utf8")).toBe(key);
  });
});

describe("encryptCredential/decryptCredential (AES-256-GCM via node:crypto)", () => {
  it("round-trips a plaintext credential exactly", async () => {
    const key = await resolveCredentialEncryptionKey({}, join(await mkdtemp(join(tmpdir(), "silly-rabbit-crypto-")), "key"));

    const encrypted = encryptCredential("hunter2", key);
    expect(decryptCredential(encrypted, key)).toBe("hunter2");
  });

  it("the encrypted form never contains the plaintext as a substring", () => {
    const key = "0".repeat(64);
    const encrypted = encryptCredential("hunter2", key);

    expect(encrypted).not.toContain("hunter2");
    expect(encrypted.split(":")).toHaveLength(3);
  });

  it("two encryptions of the same plaintext produce different ciphertext (random IV per write)", () => {
    const key = "1".repeat(64);
    const first = encryptCredential("hunter2", key);
    const second = encryptCredential("hunter2", key);

    expect(first).not.toBe(second);
    expect(decryptCredential(first, key)).toBe("hunter2");
    expect(decryptCredential(second, key)).toBe("hunter2");
  });

  it("decrypting with the wrong key fails outright, no partial recovery", () => {
    const encrypted = encryptCredential("hunter2", "2".repeat(64));

    expect(() => decryptCredential(encrypted, "3".repeat(64))).toThrow();
  });
});
