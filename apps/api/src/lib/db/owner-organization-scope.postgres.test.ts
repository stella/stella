import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";

import { rejectionOf } from "@stll/property-testing/rejection";

import { organization } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { contacts } from "@/api/db/schema";
import {
  createScopedDb,
  createTenantlessDb,
  markRlsDatabase,
} from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import { withOwnerOrganizationScope } from "@/api/lib/db/owner-organization-scope";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { insertOwnerContacts } from "@/api/tests/helpers/owner-contacts";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const OWNER_ONLY = /runs only as the contacts table owner/u;

const readSetting = async (tx: Transaction) =>
  (
    await tx.execute<{ organization_id: string }>(
      sql`SELECT coalesce(current_setting('app.organization_id', true), '') AS organization_id`,
    )
  ).at(0)?.organization_id;

describe.skipIf(!enabled)("owner organization scope (postgres)", () => {
  test("only the table owner enters: application-role transactions, tenantless or scoped, are refused", async () => {
    const databaseUrl =
      process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient();
      const application = markRlsDatabase(openClient().db);
      const firmId = mintAuthProviderId<"organization">();
      const otherFirmId = mintAuthProviderId<"organization">();
      await db.insert(organization).values(
        [firmId, otherFirmId].map((id) => ({
          id,
          name: "Advokátní kancelář Novotná",
          slug: id,
          createdAt: new Date(),
        })),
      );
      try {
        const otherContactId = createSafeId<"contact">();
        await insertOwnerContacts(db, [
          {
            id: otherContactId,
            organizationId: otherFirmId,
            type: "person",
            displayName: "Tomáš Bureš",
          },
        ]);
        const readOther = async (tx: Transaction) =>
          await withOwnerOrganizationScope(
            tx,
            otherFirmId,
            async (scoped) =>
              await scoped
                .select({ id: contacts.id })
                .from(contacts)
                .where(eq(contacts.id, otherContactId)),
          );
        expect(
          String(await rejectionOf(createTenantlessDb(application)(readOther))),
        ).toMatch(OWNER_ONLY);
        expect(
          String(
            await rejectionOf(
              createScopedDb(application, [], firmId, null)(readOther),
            ),
          ),
        ).toMatch(OWNER_ONLY);
        // An RLS-marked application database does not typecheck as a handle.
        const applicationHandle = async () =>
          await withOwnerOrganizationScope(
            // @ts-expect-error The application database carries the RLS marker.
            application,
            firmId,
            async () => undefined,
          );
        // Type-level only: the marker is what keeps it out at compile time.
        expect(applicationHandle).toBeInstanceOf(Function);
        // The owner reads it inside its own organization.
        expect(await db.transaction(readOther)).toEqual([
          { id: otherContactId },
        ]);
      } finally {
        await db
          .delete(organization)
          .where(inArray(organization.id, [firmId, otherFirmId]));
      }
    });
  });

  test("an owner transaction keeps its organization, refuses another, and gets its setting back", async () => {
    const databaseUrl =
      process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient();
      const firmId = mintAuthProviderId<"organization">();
      const otherFirmId = mintAuthProviderId<"organization">();
      const seen = await db.transaction(async (tx) => {
        const before = await readSetting(tx);
        const inside = await withOwnerOrganizationScope(
          tx,
          firmId,
          async (scoped) => {
            const nested = await withOwnerOrganizationScope(
              scoped,
              firmId,
              async (again) => await readSetting(again),
            );
            const refused = String(
              await rejectionOf(
                withOwnerOrganizationScope(
                  scoped,
                  otherFirmId,
                  async () => undefined,
                ),
              ),
            );
            return { nested, refused, after: await readSetting(scoped) };
          },
        );
        return { before, inside, after: await readSetting(tx) };
      });
      expect(seen).toEqual({
        before: "",
        inside: {
          nested: firmId,
          refused: expect.stringMatching(/cannot enter another organization/u),
          after: firmId,
        },
        after: "",
      });
    });
  });
});
