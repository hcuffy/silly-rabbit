import { NavMapSchema, type NavMap, type NavMapPageStructure } from "@silly-rabbit/shared";
import type { Collection, Db } from "mongodb";
import { stripUndefinedKeys } from "./mongoDocument.js";

type NavMapDocument = Omit<NavMap, "id"> & { _id: string };

export interface NavMapEntryVerificationPatch {
  isStale: boolean;
  label?: string;
  lastVerifiedAt?: Date;
  lastRelabeledAt?: Date;
  pageStructure?: NavMapPageStructure;
}

function toDocumentPageStructure(pageStructure: NavMapPageStructure): NavMapPageStructure {
  return stripUndefinedKeys({
    ...pageStructure,
    elements: pageStructure.elements.map((element) => stripUndefinedKeys({ ...element })),
  });
}

function toDocument(navMap: NavMap): NavMapDocument {
  const { id, entries, ...rest } = navMap;
  return stripUndefinedKeys({
    _id: id,
    ...rest,
    entries: entries.map((entry) => stripUndefinedKeys({ ...entry })),
  });
}

function fromDocument(document: NavMapDocument): NavMap {
  const { _id, ...rest } = document;
  return NavMapSchema.parse({ id: _id, ...rest });
}

export class NavMapRepo {
  private readonly collection: Collection<NavMapDocument>;

  constructor(db: Db) {
    this.collection = db.collection<NavMapDocument>("navMaps");
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ baseUrl: 1 }, { unique: true });
  }

  async getByBaseUrl(baseUrl: string): Promise<NavMap | null> {
    const document = await this.collection.findOne({ baseUrl });
    return document ? fromDocument(document) : null;
  }

  async upsert(navMap: NavMap): Promise<void> {
    const document = toDocument(NavMapSchema.parse(navMap));
    await this.collection.replaceOne({ _id: document._id }, document, { upsert: true });
  }

  async delete(baseUrl: string): Promise<void> {
    await this.collection.deleteOne({ baseUrl });
  }

  // eslint-disable-next-line max-params -- named patch param, not a raw scalar
  async updateEntryVerification(baseUrl: string, role: string, label: string, patch: NavMapEntryVerificationPatch): Promise<void> {
    const setFields: Record<string, unknown> = { "entries.$[entry].isStale": patch.isStale };
    if (patch.label) {
      setFields["entries.$[entry].label"] = patch.label;
    }
    if (patch.lastVerifiedAt) {
      setFields["entries.$[entry].lastVerifiedAt"] = patch.lastVerifiedAt;
    }
    if (patch.lastRelabeledAt) {
      setFields["entries.$[entry].lastRelabeledAt"] = patch.lastRelabeledAt;
    }
    if (patch.pageStructure) {
      setFields["entries.$[entry].pageStructure"] = toDocumentPageStructure(patch.pageStructure);
    }

    await this.collection.updateOne({ baseUrl }, { $set: setFields }, { arrayFilters: [{ "entry.role": role, "entry.label": label }] });
  }
}
