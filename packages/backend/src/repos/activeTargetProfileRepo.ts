import { ActiveTargetProfileSchema, type ActiveTargetProfile } from "@silly-rabbit/shared";
import type { Collection, Db } from "mongodb";

type ActiveTargetProfileDocument = ActiveTargetProfile & { _id: string };

const SINGLETON_ID = "active";

export class ActiveTargetProfileRepo {
  private readonly collection: Collection<ActiveTargetProfileDocument>;

  constructor(db: Db) {
    this.collection = db.collection<ActiveTargetProfileDocument>("activeTargetProfile");
  }

  async get(): Promise<ActiveTargetProfile | null> {
    const document = await this.collection.findOne({ _id: SINGLETON_ID });
    if (!document) return null;
    return ActiveTargetProfileSchema.parse({ profileId: document.profileId, updatedAt: document.updatedAt });
  }

  async set(profileId: string): Promise<void> {
    const pointer = ActiveTargetProfileSchema.parse({ profileId, updatedAt: new Date() });
    await this.collection.updateOne({ _id: SINGLETON_ID }, { $set: pointer }, { upsert: true });
  }

  async clear(): Promise<void> {
    await this.collection.deleteOne({ _id: SINGLETON_ID });
  }
}
