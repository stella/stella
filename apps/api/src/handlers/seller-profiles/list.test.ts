import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import listSellerProfiles from "./list";

type ListContext = Parameters<typeof listSellerProfiles.handler>[0];

describe("seller profile listing", () => {
  test("scopes the list to the active organization", async () => {
    let where: SQL | undefined;
    const tx = asTestRaw<Transaction>({
      select: () => ({
        from: () => ({
          where: (condition: SQL) => {
            where = condition;
            return {
              orderBy: () => ({ limit: async () => [] }),
            };
          },
        }),
      }),
    });
    const safeDb = asTestRaw<SafeDb>(async (operation) =>
      Result.ok(await operation(tx)),
    );
    const organizationId = toSafeId<"organization">("org_test");
    const context = asTestRaw<ListContext>({
      query: {},
      request: new Request("https://example.test/v1/seller-profiles"),
      route: "/v1/seller-profiles",
      safeDb,
      session: { activeOrganizationId: organizationId },
      memberRole: { role: "owner" },
      user: { id: toSafeId<"user">("user_test") },
      recordAuditEvent: async () => {},
    });

    const result = await listSellerProfiles.handler(context);

    expect(result).toMatchObject({ items: [] });
    if (!where) {
      throw new Error("Expected an organization-scoped list condition");
    }
    const compiled = new PgDialect().sqlToQuery(where);
    expect(compiled.params).toContain(organizationId);
  });
});
