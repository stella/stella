import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import type { ApiRoutePath } from "@/api/http/api-route-types";
import { toSafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import bulkDeleteContacts, {
  bulkDeleteContactsBodySchema,
  CONTACT_BULK_DELETE_LIMIT,
} from "./bulk/delete";

type BulkDeleteContext = Parameters<typeof bulkDeleteContacts.handler>[0];

const createContext = (
  contactIds: string[],
  overrides: Pick<
    BulkDeleteContext,
    "recordAuditEvent" | "safeDb" | "scopedDb"
  >,
): BulkDeleteContext =>
  asTestRaw<BulkDeleteContext>({
    body: { contactIds },
    request: new Request("https://example.test/v1/contacts", {
      method: "DELETE",
    }),
    route: "/v1/contacts" satisfies ApiRoutePath,
    ...overrides,
    memberRole: sessionMemberRole("owner"),
    session: {
      activeOrganizationId: toSafeId<"organization">("org_test123"),
    },
    user: { id: toSafeId<"user">("user_test123") },
    orgAIConfig: null,
  });

describe("bulkDeleteContacts", () => {
  test("tenant-scopes contact selection and deletion", async () => {
    const source = await Bun.file(`${import.meta.dir}/bulk/delete.ts`).text();
    expect(
      source.match(/eq\(contacts\.organizationId, organizationId\)/gu),
    ).toHaveLength(2);
  });

  test("deletes owned contacts, hides other organizations, and audits each deletion", async () => {
    const ownId = toSafeId<"contact">(Bun.randomUUIDv7());
    const otherOrganizationId = toSafeId<"contact">(Bun.randomUUIDv7());
    let selectCall = 0;
    let deleted = false;
    let auditCount = 0;

    const { safeDb, scopedDb } = createScopedDbMock({
      select: () => ({
        from: () => ({
          where: () => {
            selectCall += 1;
            if (selectCall === 1) {
              return {
                orderBy: () => ({
                  limit: async () => [{ id: ownId, displayName: "Owned" }],
                }),
              };
            }
            return [];
          },
        }),
      }),
      delete: () => ({
        where: () => ({
          returning: async () => {
            deleted = true;
            return [{ id: ownId }];
          },
        }),
      }),
    });

    const response = await bulkDeleteContacts.handler(
      createContext([ownId, otherOrganizationId], {
        safeDb,
        scopedDb,
        recordAuditEvent: async () => {
          auditCount += 1;
        },
      }),
    );

    expect(response).toEqual({
      outcomes: [
        { contactId: ownId, status: "deleted" },
        { contactId: otherOrganizationId, status: "not_found" },
      ],
    });
    expect(deleted).toBe(true);
    expect(auditCount).toBe(1);
  });

  test("keeps a matter's client and deletes the rest of the batch", async () => {
    const clientId = toSafeId<"contact">(Bun.randomUUIDv7());
    const plainId = toSafeId<"contact">(Bun.randomUUIDv7());
    let selectCall = 0;
    const auditedIds: unknown[] = [];

    const { safeDb, scopedDb } = createScopedDbMock({
      select: () => ({
        from: () => ({
          where: () => {
            selectCall += 1;
            if (selectCall === 1) {
              return {
                orderBy: () => ({
                  limit: async () => [
                    { id: clientId, displayName: "Client" },
                    { id: plainId, displayName: "Plain" },
                  ],
                }),
              };
            }
            return [];
          },
        }),
      }),
      delete: () => ({
        where: () => ({ returning: async () => [{ id: plainId }] }),
      }),
    });

    const response = await bulkDeleteContacts.handler(
      createContext([clientId, plainId], {
        safeDb,
        scopedDb,
        recordAuditEvent: async (_tx, events) => {
          for (const { resourceId } of [events].flat()) {
            auditedIds.push(resourceId);
          }
        },
      }),
    );

    expect(response).toEqual({
      outcomes: [
        { contactId: clientId, status: "blocked" },
        { contactId: plainId, status: "deleted" },
      ],
    });
    expect(auditedIds).toEqual([plainId]);
  });

  test("rejects a batch above the import limit", () => {
    const result = v.safeParse(bulkDeleteContactsBodySchema, {
      contactIds: Array.from({ length: CONTACT_BULK_DELETE_LIMIT + 1 }, () =>
        Bun.randomUUIDv7(),
      ),
    });

    expect(result.success).toBe(false);
  });
});
