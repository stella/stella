import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { organization } from "@/api/db/auth-schema";
import { contacts } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { getPgErrorCode } from "@/api/lib/pg-error";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)(
  "contacts organization row security (postgres)",
  () => {
    test("forces the table owner through the active organization policy", async () => {
      const databaseUrl =
        process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const organizationA = mintAuthProviderId<"organization">();
        const organizationB = mintAuthProviderId<"organization">();
        const contactA = createSafeId<"contact">();

        await db.insert(organization).values([
          {
            id: organizationA,
            name: "Organization A",
            slug: organizationA,
            createdAt: new Date(),
          },
          {
            id: organizationB,
            name: "Organization B",
            slug: organizationB,
            createdAt: new Date(),
          },
        ]);

        try {
          await db.transaction(async (tx) => {
            await tx.execute(
              sql`SELECT set_config('app.organization_id', ${organizationA}, true)`,
            );
            await tx.insert(contacts).values({
              id: contactA,
              organizationId: organizationA,
              type: "person",
              displayName: "Contact A",
            });
          });

          // WITH CHECK: an organization can neither write a contact for
          // another organization nor move its own contact there.
          const sqlStateOf = async (operation: () => Promise<unknown>) => {
            const outcome = await Result.tryPromise(operation);
            return outcome.isErr()
              ? getPgErrorCode(outcome.error)
              : "committed";
          };
          expect(
            await sqlStateOf(
              async () =>
                await db.transaction(async (tx) => {
                  await tx.execute(
                    sql`SELECT set_config('app.organization_id', ${organizationA}, true)`,
                  );
                  await tx.insert(contacts).values({
                    id: createSafeId<"contact">(),
                    organizationId: organizationB,
                    type: "person",
                    displayName: "Contact B",
                  });
                }),
            ),
          ).toBe("42501");
          expect(
            await sqlStateOf(
              async () =>
                await db.transaction(async (tx) => {
                  await tx.execute(
                    sql`SELECT set_config('app.organization_id', ${organizationA}, true)`,
                  );
                  await tx
                    .update(contacts)
                    .set({ organizationId: organizationB })
                    .where(eq(contacts.id, contactA));
                }),
            ),
          ).toBe("42501");

          await db.transaction(async (tx) => {
            const settings = await tx.execute<{
              current_user: string;
              owner_name: string;
              relforcerowsecurity: boolean;
            }>(sql`SELECT current_user,
              pg_catalog.pg_get_userbyid(relowner) AS owner_name,
              relforcerowsecurity
            FROM pg_catalog.pg_class
            WHERE oid = 'public.contacts'::regclass`);
            const setting = settings.at(0);
            if (setting === undefined) {
              throw new Error("Contacts relation metadata was not found");
            }
            expect(settings).toEqual([
              {
                current_user: setting.owner_name,
                owner_name: setting.owner_name,
                relforcerowsecurity: true,
              },
            ]);

            await tx.execute(
              sql`SELECT set_config('app.organization_id', ${organizationB}, true)`,
            );
            expect(await tx.select().from(contacts)).toEqual([]);
            expect(
              await tx
                .update(contacts)
                .set({ displayName: "Changed" })
                .where(eq(contacts.id, contactA))
                .returning({ id: contacts.id }),
            ).toEqual([]);
            expect(
              await tx
                .delete(contacts)
                .where(eq(contacts.id, contactA))
                .returning({ id: contacts.id }),
            ).toEqual([]);

            await tx.execute(
              sql`SELECT set_config('app.organization_id', '', true)`,
            );
            expect(await tx.select().from(contacts)).toEqual([]);
          });

          await db.transaction(async (tx) => {
            await tx.execute(
              sql`SELECT set_config('app.organization_id', ${organizationA}, true)`,
            );
            expect(await tx.select({ id: contacts.id }).from(contacts)).toEqual(
              [{ id: contactA }],
            );
            await tx.delete(contacts).where(eq(contacts.id, contactA));
          });
        } finally {
          await db
            .delete(organization)
            .where(eq(organization.id, organizationA));
          await db
            .delete(organization)
            .where(eq(organization.id, organizationB));
        }
      });
    });
  },
);
