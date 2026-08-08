import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function resolveSessionSecret(environment: NodeJS.ProcessEnv, path: string): Promise<string> {
  const fromEnvironment = environment.SESSION_SECRET;
  if (fromEnvironment) return fromEnvironment;

  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (existing) return existing;
  } catch {
    /* empty */
  }

  const generated = randomBytes(32).toString("hex");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, generated, "utf8");
  return generated;
}
