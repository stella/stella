import { panic } from "better-result";
import { describe, expect, expectTypeOf, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import { ValiError } from "valibot";

import { rejectionOf } from "@stll/property-testing/rejection";

import { organization } from "@/api/db/auth-schema";
import { contacts, entities, workspaces } from "@/api/db/schema";
import { markRlsDatabase } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { createRootOrganizationBackgroundDb } from "@/api/lib/root-scoped-db";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const organizationRows = () => ({
  organizationId: mintAuthProviderId<"organization">(),
  workspaceId: createSafeId<"workspace">(),
  entityId: createSafeId<"entity">(),
  contactId: createSafeId<"contact">(),
});

type BackgroundFixture = {
  db: GatedTestDb;
  primary: ReturnType<typeof organizationRows>;
  other: ReturnType<typeof organizationRows>;
};

const withFixture = async (
  run: (fixture: BackgroundFixture) => Promise<void>,
) => {
  const url =
    databaseUrl ??
    panic("PostgreSQL background scope tests require DATABASE_URL");
  await withGatedTestClients(url, async ({ openClient }) => {
    const { db } = openClient({ max: 1 });
    const primary = organizationRows();
    const other = organizationRows();
    const rows = [primary, other];
    await db.insert(organization).values(
      rows.map(({ organizationId }) => ({
        id: organizationId,
        name: "Background scope fixture",
        slug: organizationId,
        createdAt: new Date(),
      })),
    );
    try {
      await db.insert(workspaces).values(
        rows.map(({ organizationId, workspaceId }) => ({
          id: workspaceId,
          organizationId,
          name: "Background scope matter",
          reference: workspaceId,
        })),
      );
      await db.insert(entities).values(
        rows.map(({ workspaceId, entityId }) => ({
          id: entityId,
          workspaceId,
          name: "Protected matter row",
        })),
      );
      await db.insert(contacts).values(
        rows.map(({ organizationId, contactId }) => ({
          id: contactId,
          organizationId,
          type: "person" as const,
          displayName: "Organization row",
        })),
      );
      await run({ db, primary, other });
    } finally {
      await db.delete(organization).where(
        inArray(
          organization.id,
          rows.map(({ organizationId }) => organizationId),
        ),
      );
    }
  });
};

describe.skipIf(!runPostgresTests)(
  "organization background scopes on PostgreSQL",
  () => {
    test("construction requires the organization brand and validates runtime identifiers", async () => {
      type OrganizationArgument = Parameters<
        typeof createRootOrganizationBackgroundDb
      >[0];
      expectTypeOf<OrganizationArgument>().toEqualTypeOf<
        SafeId<"organization">
      >();
      expectTypeOf<string>().not.toExtend<OrganizationArgument>();
      expectTypeOf<undefined>().not.toExtend<OrganizationArgument>();
      expectTypeOf<SafeId<"workspace">>().not.toExtend<OrganizationArgument>();
      expectTypeOf<[]>().not.toExtend<
        Parameters<typeof createRootOrganizationBackgroundDb>
      >();
      await withFixture(async ({ db, primary }) => {
        const database = markRlsDatabase(db);
        for (const invalid of [undefined, null, "", {}, 1, "\ud800"]) {
          expect(() =>
            Reflect.apply(createRootOrganizationBackgroundDb, undefined, [
              invalid,
              database,
            ]),
          ).toThrow(ValiError);
        }
        const scoped = createRootOrganizationBackgroundDb(
          primary.organizationId,
          database,
        );
        expect(
          await scoped(
            async (tx) => await tx.select({ id: contacts.id }).from(contacts),
          ),
        ).toEqual([{ id: primary.contactId }]);
      });
    });

    test("both organization scopes deny every fixture's matter reads and writes", async () => {
      await withFixture(async ({ db, primary, other }) => {
        const rows = [primary, other];
        for (const actor of rows) {
          const scoped = createRootOrganizationBackgroundDb(
            actor.organizationId,
            markRlsDatabase(db),
          );
          const createdWorkspaceId = createSafeId<"workspace">();
          const workspaceInsertError = await rejectionOf(
            scoped(
              async (tx) =>
                await tx.insert(workspaces).values({
                  id: createdWorkspaceId,
                  organizationId: actor.organizationId,
                  name: "Denied background matter",
                  reference: createdWorkspaceId,
                }),
            ),
          );
          expect(workspaceInsertError).toMatchObject({
            cause: { code: "ERR_POSTGRES_SERVER_ERROR", errno: "42501" },
          });
          expect(
            await scoped(
              async (tx) => await tx.select({ id: entities.id }).from(entities),
            ),
          ).toEqual([]);
          expect(
            await scoped(
              async (tx) =>
                await tx.select({ id: workspaces.id }).from(workspaces),
            ),
          ).toEqual([]);
          for (const target of rows) {
            expect(
              await scoped(
                async (tx) =>
                  await tx
                    .update(workspaces)
                    .set({ name: "Denied" })
                    .where(eq(workspaces.id, target.workspaceId))
                    .returning({ id: workspaces.id }),
              ),
            ).toEqual([]);
            expect(
              await scoped(
                async (tx) =>
                  await tx
                    .delete(workspaces)
                    .where(eq(workspaces.id, target.workspaceId))
                    .returning({ id: workspaces.id }),
              ),
            ).toEqual([]);
            expect(
              await scoped(
                async (tx) =>
                  await tx
                    .update(entities)
                    .set({ name: "Denied" })
                    .where(eq(entities.id, target.entityId))
                    .returning({ id: entities.id }),
              ),
            ).toEqual([]);
            expect(
              await scoped(
                async (tx) =>
                  await tx
                    .delete(entities)
                    .where(eq(entities.id, target.entityId))
                    .returning({ id: entities.id }),
              ),
            ).toEqual([]);
            const error = await rejectionOf(
              scoped(
                async (tx) =>
                  await tx.insert(entities).values({
                    id: createSafeId<"entity">(),
                    workspaceId: target.workspaceId,
                    name: "Denied",
                  }),
              ),
            );
            expect(error).toMatchObject({
              cause: { code: "ERR_POSTGRES_SERVER_ERROR", errno: "42501" },
            });
          }
        }
        expect(
          await db
            .select({ name: entities.name })
            .from(entities)
            .where(
              inArray(
                entities.id,
                rows.map(({ entityId }) => entityId),
              ),
            ),
        ).toEqual([
          { name: "Protected matter row" },
          { name: "Protected matter row" },
        ]);
      });
    });

    test("binds only the validated organization and clears prior user and matter scope", async () => {
      await withFixture(async ({ db, primary, other }) => {
        await db.execute(
          sql`SELECT set_config('app.workspace_ids', ${`{${primary.workspaceId},${other.workspaceId}}`}, false), set_config('app.user_id', 'prior-user', false), set_config('app.workspace_access_mode', 'explicit', false), set_config('app.organization_id', ${other.organizationId}, false)`,
        );
        for (const actor of [primary, other]) {
          const scoped = createRootOrganizationBackgroundDb(
            actor.organizationId,
            markRlsDatabase(db),
          );
          const scope = await scoped(
            async (tx) =>
              await tx.execute(
                sql`SELECT current_user AS role, current_setting('app.organization_id') AS organization, current_setting('app.user_id') AS actor, current_setting('app.workspace_ids') AS workspaces, current_setting('app.workspace_access_mode') AS mode`,
              ),
          );
          expect(scope.at(0)).toEqual({
            role: "stella",
            organization: actor.organizationId,
            actor: "",
            workspaces: "{}",
            mode: "membership",
          });
          expect(
            await scoped(
              async (tx) => await tx.select({ id: contacts.id }).from(contacts),
            ),
          ).toEqual([{ id: actor.contactId }]);
          const crossOrganization = actor === primary ? other : primary;
          expect(
            await scoped(
              async (tx) =>
                await tx
                  .select({ id: contacts.id })
                  .from(contacts)
                  .where(
                    eq(
                      contacts.organizationId,
                      crossOrganization.organizationId,
                    ),
                  ),
            ),
          ).toEqual([]);
          expect(
            await scoped(
              async (tx) => await tx.select({ id: entities.id }).from(entities),
            ),
          ).toEqual([]);
        }
      });
    });
  },
);
