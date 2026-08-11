import { Result, TaggedError } from "better-result";

import type { ContactImportMapping } from "@stll/api-contract";

import { toSafeId } from "@/lib/safe-id";
import type { SafeId } from "@/lib/safe-id";

const CONTACT_IMPORT_REQUEST_STORAGE_PREFIX = "contact-import-request:v1:";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type ContactImportRequestStorage = Pick<
  Storage,
  "getItem" | "removeItem" | "setItem"
>;

export type PendingContactImportRequest = {
  id: SafeId<"contactImportRequest">;
  storageKey: string;
};

export type ContactImportRequestScope = {
  organizationId: string;
  userId: string;
};

class ContactImportRequestPersistenceError extends TaggedError(
  "ContactImportRequestPersistenceError",
)<{
  message: string;
  cause?: unknown;
}> {}

const sessionStorageOrUndefined = (): ContactImportRequestStorage | undefined =>
  Result.try(() =>
    typeof window === "undefined" ? undefined : window.sessionStorage,
  ).unwrapOr(undefined);

const sha256Hex = async (input: BufferSource): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

const operationStorageKey = async (
  file: Blob,
  mapping: ContactImportMapping,
  scope: ContactImportRequestScope,
): Promise<string> => {
  const [fileHash, mappingHash, scopeHash] = await Promise.all([
    sha256Hex(await file.arrayBuffer()),
    sha256Hex(new TextEncoder().encode(JSON.stringify(mapping))),
    sha256Hex(new TextEncoder().encode(JSON.stringify(scope))),
  ]);
  return `${CONTACT_IMPORT_REQUEST_STORAGE_PREFIX}${scopeHash}:${fileHash}:${mappingHash}`;
};

export const resolveContactImportRequest = async ({
  file,
  mapping,
  scope,
  storage = sessionStorageOrUndefined(),
}: {
  file: Blob;
  mapping: ContactImportMapping;
  scope: ContactImportRequestScope;
  storage?: ContactImportRequestStorage | undefined;
}): Promise<PendingContactImportRequest> => {
  const storageKey = await operationStorageKey(file, mapping, scope);
  if (!storage) {
    throw new ContactImportRequestPersistenceError({
      message: "Contact import retry identity storage is unavailable",
    });
  }

  const stored = Result.try(() => storage.getItem(storageKey));
  if (Result.isError(stored)) {
    throw new ContactImportRequestPersistenceError({
      message: "Contact import retry identity could not be read",
      cause: stored.error,
    });
  }
  const storedId = stored.value;
  const id =
    storedId && UUID_PATTERN.test(storedId) ? storedId : crypto.randomUUID();

  if (id !== storedId) {
    const persisted = Result.try(() => storage.setItem(storageKey, id));
    if (Result.isError(persisted)) {
      throw new ContactImportRequestPersistenceError({
        message: "Contact import retry identity could not be stored",
        cause: persisted.error,
      });
    }
  }

  return { id: toSafeId<"contactImportRequest">(id), storageKey };
};

export const clearContactImportRequest = ({
  storageKey,
  storage = sessionStorageOrUndefined(),
}: {
  storageKey: string;
  storage?: ContactImportRequestStorage | undefined;
}): void => {
  if (storage) {
    Result.try(() => storage.removeItem(storageKey)).unwrapOr(undefined);
  }
};
