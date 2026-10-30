import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { organization } from "@/api/db/auth-schema";
import { contacts } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

import { createContactVatIdRepair } from "./contact-vat-id-repair";
import { createUngatedTableGateForTests } from "./online-ddl";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)("contacts RLS maintenance (postgres)", () => {
  test("repairs a concrete VAT id through an organization scope", async () => {
    const databaseUrl =
      process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db, sql: client } = openClient();
      const organizationId = mintAuthProviderId<"organization">();
      const contactId = createSafeId<"contact">();
      await db.insert(organization).values({
        id: organizationId,
        name: "VAT repair organization",
        slug: organizationId,
        createdAt: new Date(),
      });
      try {
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT set_config('app.organization_id', ${organizationId}, true)`,
          );
          await tx.insert(contacts).values({
            id: contactId,
            organizationId,
            type: "organization",
            displayName: "VAT repair contact",
            taxId: "DE298765432",
          });
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
        expect((await repair.readCompletion(connection)).type).toBe(
          "incomplete",
        );
        await repair.repair(
          connection,
          createUngatedTableGateForTests(connection),
        );
        const repaired = await db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT set_config('app.organization_id', ${organizationId}, true)`,
          );
          return await tx
            .select({
              id: contacts.id,
              taxId: contacts.taxId,
              vatId: contacts.vatId,
            })
            .from(contacts)
            .where(eq(contacts.id, contactId));
        });
        expect(repaired).toEqual([
          { id: contactId, taxId: null, vatId: "DE298765432" },
        ]);
      } finally {
        await db
          .delete(organization)
          .where(eq(organization.id, organizationId));
      }
    });
  });
});
