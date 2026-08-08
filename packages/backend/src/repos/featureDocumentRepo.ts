import { FeatureDocumentSchema, type FeatureDocument } from "@silly-rabbit/shared";
import type { Collection, Db } from "mongodb";
import { stripUndefinedKeys } from "./mongoDocument.js";

type FeatureDocumentDocument = Omit<FeatureDocument, "id"> & { _id: string };

function toDocument(featureDocument: FeatureDocument): FeatureDocumentDocument {
  const { id, ...rest } = featureDocument;
  return stripUndefinedKeys({ _id: id, ...rest });
}

function fromDocument(document: FeatureDocumentDocument): FeatureDocument {
  const { _id, ...rest } = document;
  return FeatureDocumentSchema.parse({ id: _id, ...rest });
}

export class FeatureDocumentRepo {
  private readonly collection: Collection<FeatureDocumentDocument>;

  constructor(db: Db) {
    this.collection = db.collection<FeatureDocumentDocument>("featureDocs");
  }

  async create(featureDocument: FeatureDocument): Promise<void> {
    await this.collection.insertOne(toDocument(FeatureDocumentSchema.parse(featureDocument)));
  }

  async findByFeatureId(featureId: string): Promise<FeatureDocument[]> {
    const documents = await this.collection.find({ featureId }).sort({ generatedAt: -1 }).toArray();
    return documents.map(fromDocument);
  }

  async findLatestByFeatureId(featureId: string): Promise<FeatureDocument | null> {
    const document = await this.collection.find({ featureId }).sort({ generatedAt: -1 }).limit(1).next();
    return document ? fromDocument(document) : null;
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ featureId: 1, generatedAt: -1 });
  }
}
