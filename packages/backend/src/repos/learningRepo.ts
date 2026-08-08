import { LearningSchema, type Learning } from "@silly-rabbit/shared";
import type { Collection, Db } from "mongodb";
import { stripUndefinedKeys } from "./mongoDocument.js";

type LearningDocument = Omit<Learning, "id"> & { _id: string };

function toDocument(learning: Learning): LearningDocument {
  const { id, ...rest } = learning;
  return stripUndefinedKeys({ _id: id, ...rest });
}

function fromDocument(document: LearningDocument): Learning {
  const { _id, ...rest } = document;
  return LearningSchema.parse({ id: _id, ...rest });
}

export class LearningRepo {
  private readonly collection: Collection<LearningDocument>;

  constructor(db: Db) {
    this.collection = db.collection<LearningDocument>("learnings");
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ featureId: 1, status: 1 });
  }

  async findActiveByFeatureId(featureId: string): Promise<Learning[]> {
    const documents = await this.collection.find({ featureId, status: "active" }).toArray();
    return documents.map(fromDocument);
  }

  async findByDedupKey(featureId: string, dedupKey: string): Promise<Learning | null> {
    const document = await this.collection.findOne({ featureId, dedupKey });
    return document ? fromDocument(document) : null;
  }

  async upsert(learning: Learning): Promise<void> {
    const document = toDocument(LearningSchema.parse(learning));
    await this.collection.replaceOne({ _id: document._id }, document, { upsert: true });
  }
}
