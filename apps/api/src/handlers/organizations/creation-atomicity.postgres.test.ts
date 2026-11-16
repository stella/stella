import { APIError } from "better-auth/api";
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";

import { organization } from "@/api/db/auth-schema";
import { SETTING_USER_ID } from "@/api/db/rls";
import { createOrganizationForAccount, rootDb } from "@/api/db/root";
import {
  accountAuditLogs,
  organizationCreationRequests,
} from "@/api/db/schema";
import { createOrganizationInTransaction } from "@/api/lib/auth/create-organization-in-transaction";
import {
  brandPersistedOrganizationId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";
import { signInHuman } from "@/api/tests/helpers/human-session";

const auditFor = async (userId: string) =>
  await rootDb.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config(${SETTING_USER_ID}, ${userId}, true)`,
    );
    return await tx
      .select({
        eventType: accountAuditLogs.eventType,
        resourceId: accountAuditLogs.resourceId,
      })
      .from(accountAuditLogs)
      .where(eq(accountAuditLogs.userId, brandPersistedUserId(userId)));
  });

describe.skipIf(process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true")(
  "atomic organization creation (postgres)",
  () => {
    test("a failure after organization insertion rolls back the resource, lifecycle and receipt", async () => {
      const suffix = Bun.randomUUIDv7();
      const browser = await signInHuman(
        `organization-rollback-${suffix}@example.test`,
      );
      const slug = `rollback-${suffix}`;
      const result = await createOrganizationForAccount(
        {
          userId: brandPersistedUserId(browser.userId),
          name: "Rolled back organization",
          slug,
          evaluation: "none",
          idempotencyKey: suffix,
        },
        {
          createOrganization: async (input) => {
            const inserted = await createOrganizationInTransaction(input);
            expect(inserted.slug).toBe(slug);
            const visible = await input.transaction
              .select({ id: organization.id })
              .from(organization)
              .where(eq(organization.slug, slug));
            expect(visible).toEqual([{ id: inserted.id }]);
            throw new APIError("INTERNAL_SERVER_ERROR", {
              message: "Injected after organization insertion",
            });
          },
        },
      );
      expect(result.isErr()).toBe(true);
      expect(
        await rootDb
          .select({ id: organization.id })
          .from(organization)
          .where(eq(organization.slug, slug)),
      ).toEqual([]);
      expect(await auditFor(browser.userId)).toEqual([]);
      expect(
        await rootDb
          .select({ key: organizationCreationRequests.key })
          .from(organizationCreationRequests)
          .where(
            and(
              eq(
                organizationCreationRequests.userId,
                brandPersistedUserId(browser.userId),
              ),
              eq(organizationCreationRequests.key, suffix),
            ),
          ),
      ).toEqual([]);
    });

    test("successful creation commits its organization and account audit together", async () => {
      const suffix = Bun.randomUUIDv7();
      const browser = await signInHuman(
        `organization-commit-${suffix}@example.test`,
      );
      const result = await createOrganizationForAccount(
        {
          userId: brandPersistedUserId(browser.userId),
          name: "Committed organization",
          slug: `commit-${suffix}`,
          evaluation: "none",
          idempotencyKey: suffix,
        },
        { createOrganization: createOrganizationInTransaction },
      );
      if (result.isErr()) {
        panic("Successful fixture must create an organization", result.error);
      }
      expect(
        await rootDb
          .select({ id: organization.id })
          .from(organization)
          .where(
            eq(
              organization.id,
              brandPersistedOrganizationId(result.value.organizationId),
            ),
          ),
      ).toEqual([{ id: result.value.organizationId }]);
      expect(await auditFor(browser.userId)).toEqual([
        {
          eventType: "organization.created",
          resourceId: result.value.organizationId,
        },
      ]);
    });
  },
);
