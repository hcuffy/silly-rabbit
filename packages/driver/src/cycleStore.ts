import { CycleSchema, type Cycle } from "@silly-rabbit/shared";
import type { Db } from "mongodb";

type CycleDocument = Omit<Cycle, "id"> & { _id: string };

function fromDocument(document: CycleDocument): Cycle {
  const { _id, ...rest } = document;
  return CycleSchema.parse({ id: _id, ...rest });
}

export async function resolveCycleByNameOrId(db: Db, nameOrId: string): Promise<Cycle | undefined> {
  const collection = db.collection<CycleDocument>("cycles");
  const document = (await collection.findOne({ _id: nameOrId })) ?? (await collection.findOne({ name: nameOrId }));
  return document ? fromDocument(document) : undefined;
}

export async function incrementAndGetRunNumber(db: Db, cycleId: string): Promise<number | undefined> {
  const collection = db.collection<CycleDocument>("cycles");
  const result = await collection.findOneAndUpdate(
    { _id: cycleId },
    { $inc: { runCounter: 1 } },
    { returnDocument: "after" },
  );
  return result?.runCounter;
}
