import { TargetProfileSchema, type TargetProfile } from "@silly-rabbit/shared";
import { decryptCredential } from "@silly-rabbit/shared/node";
import type { Db } from "mongodb";

type TargetProfileDocument = Omit<TargetProfile, "id"> & { _id: string };

function fromDocument(document: TargetProfileDocument, credentialEncryptionKey: string): TargetProfile {
  const { _id, email, password, ...rest } = document;
  return TargetProfileSchema.parse({
    id: _id,
    ...rest,
    email: email !== undefined ? decryptCredential(email, credentialEncryptionKey) : undefined,
    password: password !== undefined ? decryptCredential(password, credentialEncryptionKey) : undefined,
  });
}

export async function resolveTargetProfileByNameOrId(
  db: Db,
  nameOrId: string,
  credentialEncryptionKey: string,
): Promise<TargetProfile | undefined> {
  const collection = db.collection<TargetProfileDocument>("targetProfiles");
  const document = (await collection.findOne({ _id: nameOrId })) ?? (await collection.findOne({ name: nameOrId }));
  return document ? fromDocument(document, credentialEncryptionKey) : undefined;
}
