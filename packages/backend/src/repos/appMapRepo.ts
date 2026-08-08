import { AppMapSchema, type AppMap } from "@silly-rabbit/shared";
import type { Collection, Db } from "mongodb";
import { stripUndefinedKeys } from "./mongoDocument.js";

type AppMapDocument = Omit<AppMap, "id"> & { _id: string };

function toDocument(appMap: AppMap): AppMapDocument {
  const { id, ...rest } = appMap;
  return stripUndefinedKeys({ _id: id, ...rest });
}

function fromDocument(document: AppMapDocument): AppMap {
  const { _id, ...rest } = document;
  return AppMapSchema.parse({ id: _id, ...rest });
}

export class AppMapRepo {
  private readonly collection: Collection<AppMapDocument>;

  constructor(db: Db) {
    this.collection = db.collection<AppMapDocument>("appMap");
  }

  async get(): Promise<AppMap | null> {
    const document = await this.collection.findOne({});
    return document ? fromDocument(document) : null;
  }

  async upsert(appMap: AppMap): Promise<void> {
    const document = toDocument(AppMapSchema.parse(appMap));
    await this.collection.replaceOne({ _id: document._id }, document, { upsert: true });
  }
}
