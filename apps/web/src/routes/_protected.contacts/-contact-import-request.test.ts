import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  CONTACT_IMPORT_SCHEMA_VERSION,
  type ContactImportMapping,
} from "@stll/api-contract";

import {
  clearContactImportRequest,
  resolveContactImportRequest,
} from "@/routes/_protected.contacts/-contact-import-request";

const MAPPING = {
  version: CONTACT_IMPORT_SCHEMA_VERSION,
  defaultType: "person",
  generateDisplayName: false,
  columns: [{ sourceIndex: 0, targetField: "display_name" }],
} as const satisfies ContactImportMapping;

const SCOPE = { organizationId: "org-a", userId: "user-a" };

const createStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
};

describe("contact import request identity", () => {
  test("reuses a pending key for the same file and mapping across reloads", async () => {
    const storage = createStorage();
    const file = new Blob(["Name\nJane Doe"]);

    const first = await resolveContactImportRequest({
      file,
      mapping: MAPPING,
      scope: SCOPE,
      storage,
    });
    const afterReload = await resolveContactImportRequest({
      file,
      mapping: MAPPING,
      scope: SCOPE,
      storage,
    });

    expect(afterReload).toEqual(first);
  });

  test("clears a completed request so a deliberate later import is new", async () => {
    const storage = createStorage();
    const file = new Blob(["Name\nJane Doe"]);
    const first = await resolveContactImportRequest({
      file,
      mapping: MAPPING,
      scope: SCOPE,
      storage,
    });

    clearContactImportRequest({ storageKey: first.storageKey, storage });
    const later = await resolveContactImportRequest({
      file,
      mapping: MAPPING,
      scope: SCOPE,
      storage,
    });

    expect(later.id).not.toBe(first.id);
  });

  test("isolates pending requests by each scope field", async () => {
    const storage = createStorage();
    const file = new Blob(["Name\nJane Doe"]);
    const originalScope = await resolveContactImportRequest({
      file,
      mapping: MAPPING,
      scope: SCOPE,
      storage,
    });
    const otherUser = await resolveContactImportRequest({
      file,
      mapping: MAPPING,
      scope: { organizationId: SCOPE.organizationId, userId: "user-b" },
      storage,
    });
    const otherOrganization = await resolveContactImportRequest({
      file,
      mapping: MAPPING,
      scope: { organizationId: "org-b", userId: SCOPE.userId },
      storage,
    });

    clearContactImportRequest({ storageKey: otherUser.storageKey, storage });
    clearContactImportRequest({
      storageKey: otherOrganization.storageKey,
      storage,
    });
    const originalScopeRetry = await resolveContactImportRequest({
      file,
      mapping: MAPPING,
      scope: SCOPE,
      storage,
    });

    expect(otherUser.id).not.toBe(originalScope.id);
    expect(otherUser.storageKey).not.toBe(originalScope.storageKey);
    expect(otherOrganization.id).not.toBe(originalScope.id);
    expect(otherOrganization.storageKey).not.toBe(originalScope.storageKey);
    expect(originalScopeRetry).toEqual(originalScope);
  });

  test("rejects a new request when its retry identity cannot be stored", async () => {
    const file = new Blob(["Name\nJane Doe"]);

    const result = await Result.tryPromise(
      async () =>
        await resolveContactImportRequest({
          file,
          mapping: MAPPING,
          scope: SCOPE,
          storage: {
            ...createStorage(),
            setItem: () => {
              throw new DOMException("Quota exceeded", "QuotaExceededError");
            },
          },
        }),
    );

    expect(result).toMatchObject({
      error: { _tag: "ContactImportRequestPersistenceError" },
      status: "error",
    });
  });
});
