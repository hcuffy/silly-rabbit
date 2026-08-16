import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;

/**
 * Same auto-generate-and-persist pattern as resolveSessionSecret (sessionSecret.ts) — an
 * explicit env var always wins, otherwise generate once and persist to the gitignored
 * .silly-rabbit/ convention so it survives restarts. Unlike SESSION_SECRET, losing or
 * rotating this key is NOT recoverable: SESSION_SECRET only signs sessions, so losing it
 * just forces everyone to log in again; this key decrypts every stored TargetProfile's
 * email/password fields, so losing it (or overwriting it with a different value) makes
 * every already-encrypted credential permanently undecryptable — there is no partial
 * recovery. Back this file up like any other real secret.
 */
export async function resolveCredentialEncryptionKey(environment: NodeJS.ProcessEnv, path: string): Promise<string> {
  const fromEnvironment = environment.CREDENTIAL_ENCRYPTION_KEY;
  if (fromEnvironment) {
    return fromEnvironment;
  }

  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (existing) {
      return existing;
    }
  } catch {
    /* empty */
  }

  const generated = randomBytes(KEY_BYTES).toString("hex");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, generated, "utf8");
  return generated;
}

export function encryptCredential(plaintext: string, keyHex: string): string {
  const key = Buffer.from(keyHex, "hex");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

export function decryptCredential(encrypted: string, keyHex: string): string {
  const [ivHex, authTagHex, ciphertextHex] = encrypted.split(":");
  if (!ivHex || !authTagHex || !ciphertextHex) {
    throw new Error('decryptCredential: malformed encrypted value, expected "iv:authTag:ciphertext"');
  }

  const key = Buffer.from(keyHex, "hex");
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextHex, "hex")), decipher.final()]);
  return plaintext.toString("utf8");
}
