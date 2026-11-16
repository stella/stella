import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import * as v from "valibot";

import { toSafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { withQueryPerfRollback } from "@/api/tests/query-perf/rollback";

import { organization } from "./auth-schema";
import { organizationDataExports } from "./schema/data-exports";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const fixtures = [
  {
    id: toSafeId<"dataExport">("01990000-00c1-7000-8000-000000000001"),
    organizationId: toSafeId<"organization">(
      "01990000-00c2-7000-8000-000000000001",
    ),
  },
  {
    id: toSafeId<"dataExport">("01990000-00c1-7000-8000-000000000002"),
    organizationId: toSafeId<"organization">(
      "01990000-00c2-7000-8000-000000000002",
    ),
  },
];
const rowIds = (result: unknown) =>
  v
    .parse(v.array(v.object({ id: v.string() })), executedRows(result))
    .map(({ id }) => id)
    .toSorted();

describe.skipIf(!enabled)("data export owner policy (postgres)", () => {
  for (const ownership of ["original", "transferred"] as const) {
    test(`${ownership} table owner retains maintenance access without widening tenant or reset scope`, async () => {
      await withGatedTestClients(
        process.env["DATABASE_URL"] ?? panic("DATABASE_URL required"),
        async ({ openClient }) => {
          const { db } = openClient({ max: 1 });
          // The exclusive runner supplies a fresh worker clone; roll back roles, ownership and every row too.
          await withQueryPerfRollback(db, async (tx) => {
            const identity = v.parse(
              v.object({
                actor: v.string(),
                login: v.string(),
                owner: v.string(),
                relrowsecurity: v.boolean(),
                relforcerowsecurity: v.boolean(),
              }),
              executedRows(
                await tx.execute(sql`SELECT current_user AS actor, session_user AS login,
              pg_catalog.pg_get_userbyid(relowner) AS owner, relrowsecurity, relforcerowsecurity
              FROM pg_catalog.pg_class WHERE oid = 'public.organization_data_exports'::regclass`),
              ).at(0),
            );
            const owner = identity.actor;
            expect(identity.login).toBe(owner);
            expect(identity.owner).toBe(owner);
            expect(identity.relrowsecurity).toBe(true);
            expect(identity.relforcerowsecurity).toBe(true);
            const roles = v.parse(
              v.array(
                v.object({
                  rolsuper: v.boolean(),
                  rolbypassrls: v.boolean(),
                }),
              ),
              executedRows(
                await tx.execute(sql`SELECT rolsuper, rolbypassrls
              FROM pg_roles WHERE rolname IN (${owner}, 'stella')`),
              ),
            );
            expect(roles).toHaveLength(2);
            for (const role of roles) {
              expect(role.rolsuper).toBe(false);
              expect(role.rolbypassrls).toBe(false);
            }
            await tx.insert(organization).values(
              fixtures.map(({ organizationId }) => ({
                id: organizationId,
                name: "Export policy fixture",
                slug: organizationId,
                createdAt: new Date("2026-01-01T00:00:00Z"),
              })),
            );
            for (const fixture of fixtures) {
              await tx.execute(sql`SELECT set_config('role', 'stella', true),
                set_config('app.organization_id', ${fixture.organizationId}, true)`);
              await tx
                .insert(organizationDataExports)
                .values({ ...fixture, versionScope: "all" });
            }
            await tx.execute(sql`SELECT set_config('role', ${owner}, true)`);
            await tx.execute(
              sql`CREATE TEMP TABLE organization_data_exports (shadow_table text)`,
            );
            const tableOwner =
              ownership === "original"
                ? owner
                : "stella_export_policy_fixture_owner";
            if (ownership === "transferred") {
              await tx.execute(
                sql`CREATE ROLE stella_export_policy_fixture_owner NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT`,
              );
              await tx.execute(
                sql`GRANT stella_export_policy_fixture_owner TO CURRENT_USER WITH INHERIT FALSE, SET TRUE`,
              );
              await tx.execute(
                sql`GRANT CREATE, USAGE ON SCHEMA public TO stella_export_policy_fixture_owner`,
              );
              await tx.execute(
                sql`ALTER TABLE public.organization_data_exports OWNER TO stella_export_policy_fixture_owner`,
              );
              await tx.execute(
                sql`SELECT set_config('role', ${tableOwner}, true)`,
              );
              await tx.execute(
                sql`GRANT SELECT, UPDATE, DELETE ON public.organization_data_exports TO ${sql.identifier(owner)}`,
              );
              await tx.execute(sql`SELECT set_config('role', ${owner}, true)`);
            }
            const actors =
              ownership === "original"
                ? [owner, "stella"]
                : [owner, "stella", tableOwner];
            const scopes = [
              "",
              ...fixtures.map(({ organizationId }) => organizationId),
            ];
            const contexts = actors.flatMap((actor) =>
              scopes.flatMap((active) =>
                scopes.flatMap((reset) =>
                  ["public, pg_temp", "pg_temp, public"].map((path) => ({
                    actor,
                    active,
                    reset,
                    path,
                  })),
                ),
              ),
            );
            for (const { actor, active, reset, path } of contexts) {
              await tx.execute(sql`SAVEPOINT policy_case`);
              await tx.execute(sql`SELECT set_config('role', ${actor}, true),
                set_config('app.organization_id', ${active}, true),
                set_config('app.correspondence_review_reset_organization_id', ${reset}, true),
                set_config('search_path', ${path}, true)`);
              expect(
                executedRows(
                  await tx.execute(sql`SELECT current_user AS actor, session_user AS login,
                'organization_data_exports'::regclass::oid = 'public.organization_data_exports'::regclass::oid AS resolves_public`),
                ),
              ).toEqual([
                {
                  actor,
                  login: owner,
                  resolves_public: path === "public, pg_temp",
                },
              ]);
              const selected = rowIds(
                await tx.execute(
                  sql`SELECT id::text AS id FROM public.organization_data_exports`,
                ),
              );
              const updated = rowIds(
                await tx.execute(
                  sql`UPDATE public.organization_data_exports SET failures = failures RETURNING id::text AS id`,
                ),
              );
              const deleted = rowIds(
                await tx.execute(
                  sql`DELETE FROM public.organization_data_exports RETURNING id::text AS id`,
                ),
              );
              const readable = fixtures.filter(
                ({ organizationId }) =>
                  actor === tableOwner ||
                  (actor === "stella" && organizationId === active),
              );
              const deletable = fixtures.filter(
                ({ organizationId }) =>
                  (actor === tableOwner && organizationId === reset) ||
                  (actor === "stella" && organizationId === active),
              );
              const context = JSON.stringify({
                ownership,
                actor,
                active,
                reset,
                path,
              });
              expect(selected, context).toEqual(
                readable.map(({ id }) => id).toSorted(),
              );
              expect(updated, context).toEqual(
                readable.map(({ id }) => id).toSorted(),
              );
              expect(deleted, context).toEqual(
                deletable.map(({ id }) => id).toSorted(),
              );
              await tx.execute(sql`ROLLBACK TO SAVEPOINT policy_case`);
              await tx.execute(sql`RELEASE SAVEPOINT policy_case`);
            }
          });
        },
      );
    });
  }
});
