import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { main } from "../cli.js";
import { closeMongo, connectMongo, type RunStoreConnection } from "../runStore.js";
import { getTriggeredBy } from "../triggeredBy.js";

describe("cli main() — run identification (run-identification-feature)", () => {
  let mongod: MongoMemoryServer;
  let connection: RunStoreConnection;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await connectMongo(mongod.getUri());
    process.env.MONGO_URI = mongod.getUri();
  });

  afterAll(async () => {
    delete process.env.MONGO_URI;
    await closeMongo(connection);
    await mongod.stop();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a fresh run against the mock target reports runId and triggeredBy in its JSON summary", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const runId = randomUUID();
    const stateDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-cli-state-"));
    const outputDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-cli-out-"));

    await main([
      "--charter",
      "test the locations flow",
      "--run",
      runId,
      "--state",
      join(stateDirectory, "driver-state.json"),
      "--out",
      outputDirectory,
    ]);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const summary = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as { runId: string; triggeredBy: string };
    expect(summary.runId).toBe(runId);
    expect(summary.triggeredBy).toBe(getTriggeredBy());
  });

  it("writes a COMPLETED Run document to Mongo, in the same shape the backend's RunRepo/dashboard reads", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const stateDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-cli-state-"));
    const outputDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-cli-out-"));

    const before = await connection.db.collection("runs").countDocuments();

    await main([
      "--charter",
      "test the locations flow",
      "--run",
      randomUUID(),
      "--state",
      join(stateDirectory, "driver-state.json"),
      "--out",
      outputDirectory,
    ]);

    const documents = await connection.db.collection("runs").find().toArray();
    expect(documents.length).toBe(before + 1);
    const written = documents[documents.length - 1];
    expect(written?.status).toBe("COMPLETED");
    expect(written?.charter).toBe("test the locations flow");
    expect(written?.targetBaseUrl).toBe("http://mock.local");
    expect(typeof written?.stepsUsed).toBe("number");
  });

  it("--help prints real usage/examples and exits cleanly — no charter/run required, no Mongo/browser " +
    "touched (onboarding-friction fix)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const before = await connection.db.collection("runs").countDocuments();

    await main(["--help"]);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const helpText = logSpy.mock.calls[0]?.[0] as string;
    expect(helpText).toContain("explore --charter");
    expect(helpText).toContain('pnpm --filter driver explore --charter "test the locations flow" --run demo-1');
    expect(helpText).toContain("changed-regression");
    expect(await connection.db.collection("runs").countDocuments()).toBe(before);
  });

  it("-h is a real shorthand for --help, not just documented in the text", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await main(["-h"]);

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0] as string).toContain("Usage:");
  });

  it("missing --charter/--run still throws a usage error that mentions --help, unchanged behavior " +
    "otherwise", async () => {
    await expect(main([])).rejects.toThrow(/--help/);
  });
});
