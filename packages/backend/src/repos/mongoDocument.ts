export function stripUndefinedKeys<T extends object>(document: T): T {
  for (const key of Object.keys(document) as (keyof T)[]) {
    if (document[key] === undefined) delete document[key];
  }
  return document;
}
