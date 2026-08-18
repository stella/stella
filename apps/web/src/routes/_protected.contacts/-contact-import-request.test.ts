import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/lib/safe-id";
import {
  clearContactImportRequest,
  resolveContactImportRequest,
} from "@/routes/_protected.contacts/-contact-import-request";
import type { ImportCommitPayload } from "@/routes/_protected.contacts/-import-candidate";

const ROW_ID = toSafeId<"contact">("4f1a1a2e-1b23-4c56-9def-0123456789ab");

const PAYLOAD = {
  taxIdScheme: "br_cpf_cnpj",
  rows: [{ id: ROW_ID, type: "person", displayName: "Jane Doe" }],
} as const satisfies ImportCommitPayload;

const EDITED_PAYLOAD = {
  taxIdScheme: "br_cpf_cnpj",
  rows: [{ id: ROW_ID, type: "person", displayName: "Jane Doerr" }],
} as const satisfies ImportCommitPayload;

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
  test("reuses a pending key when the reviewed rows are unchanged", async () => {
    const storage = createStorage();

    const first = await resolveContactImportRequest({
      payload: PAYLOAD,
      scope: SCOPE,
      storage,
    });
    const retry = await resolveContactImportRequest({
      payload: PAYLOAD,
      scope: SCOPE,
      storage,
    });

    expect(retry).toEqual(first);
  });

  test("asks for a new request once a reviewed row is edited", async () => {
    const storage = createStorage();

    const first = await resolveContactImportRequest({
      payload: PAYLOAD,
      scope: SCOPE,
      storage,
    });
    const afterEdit = await resolveContactImportRequest({
      payload: EDITED_PAYLOAD,
      scope: SCOPE,
      storage,
    });

    expect(PAYLOAD.rows[0].displayName).not.toBe(
      EDITED_PAYLOAD.rows[0].displayName,
    );
    expect(afterEdit.storageKey).not.toBe(first.storageKey);
    expect(afterEdit.id).not.toBe(first.id);
  });

  test("clears a completed request so a deliberate later import is new", async () => {
    const storage = createStorage();
    const first = await resolveContactImportRequest({
      payload: PAYLOAD,
      scope: SCOPE,
      storage,
    });

    clearContactImportRequest({ storageKey: first.storageKey, storage });
    const later = await resolveContactImportRequest({
      payload: PAYLOAD,
      scope: SCOPE,
      storage,
    });

    expect(later.id).not.toBe(first.id);
  });

  test("isolates pending requests by each scope field", async () => {
    const storage = createStorage();
    const originalScope = await resolveContactImportRequest({
      payload: PAYLOAD,
      scope: SCOPE,
      storage,
    });
    const otherUser = await resolveContactImportRequest({
      payload: PAYLOAD,
      scope: { organizationId: SCOPE.organizationId, userId: "user-b" },
      storage,
    });
    const otherOrganization = await resolveContactImportRequest({
      payload: PAYLOAD,
      scope: { organizationId: "org-b", userId: SCOPE.userId },
      storage,
    });

    clearContactImportRequest({ storageKey: otherUser.storageKey, storage });
    clearContactImportRequest({
      storageKey: otherOrganization.storageKey,
      storage,
    });
    const originalScopeRetry = await resolveContactImportRequest({
      payload: PAYLOAD,
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
    const result = await Result.tryPromise({
      try: async () =>
        await resolveContactImportRequest({
          payload: PAYLOAD,
          scope: SCOPE,
          storage: {
            ...createStorage(),
            setItem: () => {
              throw new DOMException("Quota exceeded", "QuotaExceededError");
            },
          },
        }),
      catch: (cause) => cause,
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toMatchObject({
        _tag: "ContactImportRequestPersistenceError",
      });
    }
  });
});
