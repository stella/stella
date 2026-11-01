import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";

import { compareCodeUnit } from "@stll/collation";

import { organization } from "@/api/db/auth-schema";
import { contacts } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { withOwnerOrganizationScope } from "@/api/lib/db/owner-organization-scope";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { insertOwnerContacts } from "@/api/tests/helpers/owner-contacts";

import { createContactVatIdRepair } from "./contact-vat-id-repair";
import { createUngatedTableGateForTests } from "./online-ddl";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const MIGRATION_PATH = new URL(
  "../../drizzle/20261031200838_contact_vat_id_check/migration.sql",
  import.meta.url,
);

const checkMigrationStatements = async () =>
  (await Bun.file(MIGRATION_PATH).text())
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

describe.skipIf(!enabled)("contacts RLS maintenance (postgres)", () => {
  test("repairs VAT ids in every organization, one organization scope at a time", async () => {
    const databaseUrl =
      process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      // One connection: the repair runs on a single migration session.
      const { db, sql: client } = openClient({ max: 1 });
      const organizations = [
        mintAuthProviderId<"organization">(),
        mintAuthProviderId<"organization">(),
      ];
      const [firstOrganizationId, secondOrganizationId] = organizations;
      if (
        firstOrganizationId === undefined ||
        secondOrganizationId === undefined
      ) {
        return panic("Fixture organizations missing");
      }
      const fixture = [
        {
          id: createSafeId<"contact">(),
          organizationId: firstOrganizationId,
          type: "organization" as const,
          displayName: "Novák stavby s.r.o.",
          taxId: "CZ12345678",
        },
        {
          id: createSafeId<"contact">(),
          organizationId: secondOrganizationId,
          type: "organization" as const,
          displayName: "Brückner Logistik GmbH",
          taxId: "DE298765432",
        },
        {
          id: createSafeId<"contact">(),
          organizationId: secondOrganizationId,
          type: "person" as const,
          displayName: "Jana Svobodová",
          taxId: "8551011234",
        },
      ];
      await db.insert(organization).values(
        organizations.map((id) => ({
          id,
          name: "VAT repair organization",
          slug: id,
          createdAt: new Date(),
        })),
      );
      // Contacts as the deploy finds them: written before the check, which
      // the migration then adds NOT VALID.
      await client.unsafe(
        'ALTER TABLE public.contacts DROP CONSTRAINT IF EXISTS "contacts_vat_id_check"',
      );
      try {
        await insertOwnerContacts(db, fixture);
        await client.begin(async (tx) => {
          for (const statement of await checkMigrationStatements()) {
            await tx.unsafe(statement);
          }
        });
        const connection = {
          execute: async (query: string, params: readonly unknown[] = []) => {
            await client.unsafe(query, [...params]);
          },
          query: async (query: string, params: readonly unknown[] = []) =>
            await client.unsafe(query, [...params]),
          release: () => {},
        };
        const repair = createContactVatIdRepair({
          sleep: async () => {},
          readVerdict: async () => ({ kind: "normal", signals: [] }),
        });
        // Completion reads the catalog, not the contacts: an unvalidated check
        // is owed work (pending once a pass recorded its checkpoint).
        expect((await repair.readCompletion(connection)).type).not.toBe(
          "complete",
        );
        expect(
          await repair.repair(
            connection,
            createUngatedTableGateForTests(connection),
          ),
        ).toEqual({ type: "complete" });
        expect((await repair.readCompletion(connection)).type).toBe("complete");
        // Each step named its organization inside its own transaction, so
        // the migration session ends without one.
        expect(
          await client`SELECT coalesce(current_setting('app.organization_id', true), '') AS organization_id`,
        ).toEqual([{ organization_id: "" }]);
        const repaired = await Promise.all(
          organizations.map(
            async (organizationId) =>
              await withOwnerOrganizationScope(
                db,
                organizationId,
                async (tx) =>
                  await tx
                    .select({
                      id: contacts.id,
                      organizationId: contacts.organizationId,
                      taxId: contacts.taxId,
                      vatId: contacts.vatId,
                    })
                    .from(contacts)
                    .where(
                      inArray(
                        contacts.id,
                        fixture.map(({ id }) => id),
                      ),
                    ),
              ),
          ),
        );
        // Each organization scope returns its own contacts only.
        expect(
          repaired.map((rows) =>
            rows.toSorted((left, right) => compareCodeUnit(left.id, right.id)),
          ),
        ).toEqual(
          organizations.map((organizationId) =>
            fixture
              .filter((row) => row.organizationId === organizationId)
              .map(({ id, taxId }) =>
                taxId.startsWith("CZ") || taxId.startsWith("DE")
                  ? { id, organizationId, taxId: null, vatId: taxId }
                  : { id, organizationId, taxId, vatId: null },
              )
              .toSorted((left, right) => compareCodeUnit(left.id, right.id)),
          ),
        );
      } finally {
        await db
          .delete(organization)
          .where(inArray(organization.id, organizations));
        // Leave the shared table with its validated check.
        await client.unsafe(
          'ALTER TABLE public.contacts DROP CONSTRAINT IF EXISTS "contacts_vat_id_check"',
        );
        await client.begin(async (tx) => {
          for (const statement of await checkMigrationStatements()) {
            await tx.unsafe(statement);
          }
        });
        await client.unsafe(
          'ALTER TABLE public.contacts VALIDATE CONSTRAINT "contacts_vat_id_check"',
        );
      }
    });
  });
});
