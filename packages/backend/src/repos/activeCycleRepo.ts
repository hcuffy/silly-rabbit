import { ActiveCycleSchema, type ActiveCycle } from "@silly-rabbit/shared";
import type { Collection, Db } from "mongodb";

type ActiveCycleDocument = ActiveCycle & { _id: string };

const SINGLETON_ID = "active";

export class ActiveCycleRepo {
  private readonly collection: Collection<ActiveCycleDocument>;

  constructor(db: Db) {
    this.collection = db.collection<ActiveCycleDocument>("activeCycle");
  }

  async get(): Promise<ActiveCycle | null> {
    const document = await this.collection.findOne({ _id: SINGLETON_ID });
    if (!document) return null;
    return ActiveCycleSchema.parse({ cycleId: document.cycleId, updatedAt: document.updatedAt });
  }

  async set(cycleId: string): Promise<void> {
    const pointer = ActiveCycleSchema.parse({ cycleId, updatedAt: new Date() });
    await this.collection.updateOne({ _id: SINGLETON_ID }, { $set: pointer }, { upsert: true });
  }

  async clear(): Promise<void> {
    await this.collection.deleteOne({ _id: SINGLETON_ID });
  }
}
