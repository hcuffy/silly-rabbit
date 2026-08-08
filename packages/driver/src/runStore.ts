import { RunSchema, type Run } from "@silly-rabbit/shared";
import { MongoClient, type Collection, type Db } from "mongodb";
import { z } from "zod";

type RunDocument = Omit<Run, "id"> & { _id: string };

const RunPatchSchema = RunSchema.omit({ id: true, charter: true, targetBaseUrl: true, startedAt: true }).partial();
export type RunPatch = z.infer<typeof RunPatchSchema>;

export function stripUndefinedKeys<T extends object>(document: T): T {
  for (const key of Object.keys(document) as (keyof T)[]) {
    if (document[key] === undefined) delete document[key];
  }
  return document;
}

function toDocument(run: Run): RunDocument {
  const { id, ...rest } = run;
  return stripUndefinedKeys({ _id: id, ...rest });
}

export interface RunStoreConnection {
  client: MongoClient;
  db: Db;
}

export async function connectMongo(uri: string): Promise<RunStoreConnection> {
  const client = new MongoClient(uri);
  await client.connect();
  return { client, db: client.db() };
}

export async function closeMongo(connection: RunStoreConnection): Promise<void> {
  await connection.client.close();
}

export class RunStore {
  private readonly collection: Collection<RunDocument>;

  constructor(db: Db) {
    this.collection = db.collection<RunDocument>("runs");
  }

  async create(run: Run): Promise<void> {
    await this.collection.insertOne(toDocument(RunSchema.parse(run)));
  }

  async updateStatus(id: string, patch: RunPatch): Promise<void> {
    await this.collection.updateOne({ _id: id }, { $set: RunPatchSchema.parse(patch) });
  }
}
