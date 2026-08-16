import { BaselineSchema, type Baseline } from "@silly-rabbit/shared";
import type { Collection, Db } from "mongodb";
import { stripUndefinedKeys } from "./mongoDocument.js";

type BaselineDocument = Omit<Baseline, "screenId"> & { _id: string };

function toDocument(baseline: Baseline): BaselineDocument {
  const { screenId, ...rest } = baseline;
  return stripUndefinedKeys({ _id: screenId, ...rest });
}

function fromDocument(document: BaselineDocument): Baseline {
  const { _id, ...rest } = document;
  return BaselineSchema.parse({ screenId: _id, ...rest });
}

export class BaselineRepo {
  private readonly collection: Collection<BaselineDocument>;

  constructor(db: Db) {
    this.collection = db.collection<BaselineDocument>("baselines");
  }

  async getByScreenIds(screenIds: string[]): Promise<Baseline[]> {
    if (screenIds.length === 0) {
      return [];
    }
    const documents = await this.collection.find({ _id: { $in: screenIds } }).toArray();
    return documents.map(fromDocument);
  }

  async upsert(baseline: Baseline): Promise<void> {
    const document = toDocument(BaselineSchema.parse(baseline));
    await this.collection.replaceOne({ _id: document._id }, document, { upsert: true });
  }
}
