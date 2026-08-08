import { TargetProfileSchema, type TargetProfile } from "@silly-rabbit/shared";
import { decryptCredential, encryptCredential } from "@silly-rabbit/shared/node";
import type { Collection, Db } from "mongodb";
import { z } from "zod";
import { stripUndefinedKeys } from "./mongoDocument.js";

type TargetProfileDocument = Omit<TargetProfile, "id"> & { _id: string };

const TargetProfilePatchSchema = TargetProfileSchema.omit({ id: true, createdAt: true }).partial();
export type TargetProfilePatch = z.infer<typeof TargetProfilePatchSchema>;

/**
 * Encryption/decryption happens ONLY here — every caller above this repo (routes,
 * profile-resolution, any future settings UI) sees and sends plain strings, same as any
 * other field. See @silly-rabbit/shared's credentialCrypto.ts for the algorithm and the
 * key's non-recoverable-loss caveat.
 */
export class TargetProfileRepo {
  private readonly collection: Collection<TargetProfileDocument>;
  private readonly credentialEncryptionKey: string;

  constructor(db: Db, credentialEncryptionKey: string) {
    this.collection = db.collection<TargetProfileDocument>("targetProfiles");
    this.credentialEncryptionKey = credentialEncryptionKey;
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ name: 1 });
  }

  async create(profile: TargetProfile): Promise<void> {
    await this.collection.insertOne(this.toDocument(TargetProfileSchema.parse(profile)));
  }

  async get(id: string): Promise<TargetProfile | null> {
    const document = await this.collection.findOne({ _id: id });
    return document ? this.fromDocument(document) : null;
  }

  async list(): Promise<TargetProfile[]> {
    const documents = await this.collection.find().sort({ name: 1 }).toArray();
    return documents.map((document) => this.fromDocument(document));
  }

  async update(id: string, patch: TargetProfilePatch): Promise<void> {
    const parsed = TargetProfilePatchSchema.parse(patch);
    const { email, password, ...rest } = parsed;
    const update = stripUndefinedKeys({
      ...rest,
      email: email !== undefined ? encryptCredential(email, this.credentialEncryptionKey) : undefined,
      password: password !== undefined ? encryptCredential(password, this.credentialEncryptionKey) : undefined,
      updatedAt: new Date(),
    });
    await this.collection.updateOne({ _id: id }, { $set: update });
  }

  async delete(id: string): Promise<void> {
    await this.collection.deleteOne({ _id: id });
  }

  private toDocument(profile: TargetProfile): TargetProfileDocument {
    const { id, email, password, ...rest } = profile;
    return stripUndefinedKeys({
      _id: id,
      ...rest,
      email: email !== undefined ? encryptCredential(email, this.credentialEncryptionKey) : undefined,
      password: password !== undefined ? encryptCredential(password, this.credentialEncryptionKey) : undefined,
    });
  }

  private fromDocument(document: TargetProfileDocument): TargetProfile {
    const { _id, email, password, ...rest } = document;
    return TargetProfileSchema.parse({
      id: _id,
      ...rest,
      email: email !== undefined ? decryptCredential(email, this.credentialEncryptionKey) : undefined,
      password: password !== undefined ? decryptCredential(password, this.credentialEncryptionKey) : undefined,
    });
  }
}
