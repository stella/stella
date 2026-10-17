import { Result, TaggedError } from "better-result";
import * as v from "valibot";

import { sha256Hex as hashSha256Hex } from "@stll/sha256/browser";

import {
  isCurrentStorageOwner,
  storageOwner,
  userStorageKey,
} from "@/lib/account/user-scoped-storage";
import {
  definePersistedState,
  keepInAnyScope,
  readPersistedState,
  removePersistedState,
  writePersistedState,
} from "@/lib/persisted-state/registry";
import { toSafeId } from "@/lib/safe-id";
import type { SafeId } from "@/lib/safe-id";
import { createUuid } from "@/lib/uuid";
import type { ImportCommitPayload } from "@/routes/_protected.contacts/-import-candidate";

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

const contactImportRequestEntry = definePersistedState({
  key: ({ storageKey }: { storageKey: string }) => storageKey,
  area: "session",
  version: 1,
  schema: v.nullable(v.pipe(v.string(), v.regex(UUID_PATTERN))),
  maxBytes: 256,
  defaultValue: () => null,
  scopeCheck: keepInAnyScope,
  restoredUi: false,
});

const operationStorageKey = async (
  payload: ImportCommitPayload,
  scope: ContactImportRequestScope,
): Promise<string> => {
  const [payloadHash, scopeHash] = await Promise.all([
    hashSha256Hex(JSON.stringify(payload)),
    hashSha256Hex(JSON.stringify(scope)),
  ]);
  return userStorageKey(
    `${CONTACT_IMPORT_REQUEST_STORAGE_PREFIX}${scopeHash}:${payloadHash}`,
    { kind: "user", userId: scope.userId },
  );
};

/**
 * The retry identity for one commit. It is keyed on the rows themselves, so
 * re-sending an unchanged batch after a failed request replays the original
 * result, while editing a row asks for a new request the server will accept.
 */
export const resolveContactImportRequest = async ({
  payload,
  scope,
  storage,
}: {
  payload: ImportCommitPayload;
  scope: ContactImportRequestScope;
  storage?: ContactImportRequestStorage | undefined;
}): Promise<PendingContactImportRequest> => {
  const owner = storageOwner();
  const storageKey = await operationStorageKey(payload, scope);
  const scopeIsCurrent =
    owner.kind === "user" &&
    owner.userId === scope.userId &&
    isCurrentStorageOwner(owner);
  if (!scopeIsCurrent) {
    throw new ContactImportRequestPersistenceError({
      message: "Contact import retry identity account changed",
    });
  }

  const storedId = readPersistedState(
    contactImportRequestEntry,
    { storageKey },
    storage,
  );
  const id = storedId ?? createUuid();

  if (id !== storedId) {
    const persisted = writePersistedState(
      contactImportRequestEntry,
      { storageKey },
      id,
      storage,
    );
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
  storage,
}: {
  storageKey: string;
  storage?: ContactImportRequestStorage | undefined;
}): void => {
  removePersistedState(contactImportRequestEntry, { storageKey }, storage);
};
