import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import { contacts } from "@/api/db/schema";
import { createSafeDb, markRlsDatabase } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { auditRecorderDouble } from "@/api/tests/helpers/audit-recorder-double";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import {
  NO_DB,
  createTestHandlerContext,
} from "@/api/tests/helpers/handler-context";

import updateContact from "./update";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !runPostgresTests) {
  describe.skip("contact currency restatement (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  test("contact currency restatement rounds exactly and refuses unsafe values", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient();
      const organizationId = mintAuthProviderId<"organization">();
      const userId = mintAuthProviderId<"user">();
      const contactId = createSafeId<"contact">();
      let userInserted = false;
      let organizationInserted = false;
      try {
        await db.insert(user).values({
          id: userId,
          name: "Billing",
          email: `${userId}@billing.test`,
        });
        userInserted = true;
        await db.insert(organization).values({
          id: organizationId,
          name: "Billing",
          slug: organizationId,
          createdAt: new Date(),
        });
        organizationInserted = true;
        await db.insert(member).values({
          id: mintAuthProviderIdValue(),
          organizationId,
          userId,
          role: "owner",
          createdAt: new Date(),
        });
        await db.insert(contacts).values({
          id: contactId,
          organizationId,
          type: "person",
          displayName: "Billing",
          currency: "USD",
          defaultHourlyRate: cents(15_050),
        });
        const update = async (currency: string) =>
          await updateContact.handler(
            createTestHandlerContext<
              Parameters<typeof updateContact.handler>[0]
            >({
              scopedDb: NO_DB,
              audit: auditRecorderDouble(),
              memberRole: sessionMemberRole("owner"),
              session: { activeOrganizationId: organizationId },
              user: { id: userId },
              params: { contactId },
              safeDb: createSafeDb(
                markRlsDatabase(db),
                [],
                organizationId,
                userId,
              ),
              body: { currency },
            }),
          );
        const read = async () =>
          (
            await db
              .select({
                currency: contacts.currency,
                rate: contacts.defaultHourlyRate,
              })
              .from(contacts)
              .where(eq(contacts.id, contactId))
          ).at(0);
        expect(await update("JPY")).toEqual({ id: contactId });
        expect(await read()).toEqual({ currency: "JPY", rate: cents(151) });
        expect(await update("KWD")).toEqual({ id: contactId });
        expect(await read()).toEqual({ currency: "KWD", rate: cents(151_000) });
        await db
          .update(contacts)
          .set({ currency: "JPY", defaultHourlyRate: cents(9_007_199_254_740) })
          .where(eq(contacts.id, contactId));
        expect(await update("KWD")).toEqual({ id: contactId });
        expect(await read()).toEqual({
          currency: "KWD",
          rate: cents(9_007_199_254_740_000),
        });
        await db
          .update(contacts)
          .set({ currency: "JPY", defaultHourlyRate: cents(9_007_199_254_741) })
          .where(eq(contacts.id, contactId));
        expect(await update("KWD")).toEqual({
          code: 400,
          response: {
            message: "Currency change would put the contact rate out of range",
          },
        });
        expect(await read()).toEqual({
          currency: "JPY",
          rate: cents(9_007_199_254_741),
        });
      } finally {
        if (organizationInserted) {
          await db
            .delete(organization)
            .where(eq(organization.id, organizationId));
        }
        if (userInserted) {
          await db.delete(user).where(eq(user.id, userId));
        }
      }
    });
  });
}
