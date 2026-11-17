import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql, TransactionRollbackError } from "drizzle-orm";

import { publicLawDatabaseRolePermissionsSql } from "@/api/lib/public-law-read-db";
import type { PublicLawDatabaseRolePermissions } from "@/api/lib/public-law-read-db";
import {
  CENSUS_COLUMN_GRANTS_BY_RELATION,
  LEGISLATION_WORK_IDENTIFIER_COLUMN_GRANTS_BY_RELATION,
  PUBLIC_LAW_COLUMN_GRANTS_BY_RELATION,
} from "@/api/lib/public-law-relations";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)("staged public-law grants (postgres)", () => {
  test.each(
    Object.entries({
      ...CENSUS_COLUMN_GRANTS_BY_RELATION,
      ...LEGISLATION_WORK_IDENTIFIER_COLUMN_GRANTS_BY_RELATION,
    }),
  )(
    "permits absent and staged %s columns while refusing undeclared reads and writes",
    async (_relationName, columnGrants) => {
      const databaseUrl =
        process.env["DATABASE_URL"] ??
        panic("Postgres grant test requires DATABASE_URL");
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient({ max: 1 });
        const suffix = Bun.randomUUIDv7().replaceAll("-", "");
        const relation = `public_law_grants_${suffix}`;
        const role = sql.identifier(`public_law_reader_${suffix}`);
        const table = sql`${sql.identifier("public")}.${sql.identifier(relation)}`;
        const columns = Object.keys(columnGrants);
        const firstColumn =
          columns.at(0) ?? panic("Staged grants must not be empty");
        const columnList = sql.join(
          columns.map((column) => sql.identifier(column)),
          sql`, `,
        );
        const grants = {
          case_law_sources: { id: "required" },
          [relation]: columnGrants,
        } as const;

        // A unique relation and role exercise the production grant checker without
        // locking shared tables or changing another suite's reader privileges.
        try {
          await db.transaction(async (tx) => {
            await tx.execute(sql`CREATE ROLE ${role} NOLOGIN`);
            // CREATEROLE grants ADMIN without SET on PostgreSQL 16 and later.
            await tx.execute(
              sql`GRANT ${role} TO CURRENT_USER WITH INHERIT FALSE, SET TRUE`,
            );
            await tx.execute(sql`GRANT USAGE ON SCHEMA public TO ${role}`);
            await tx.execute(
              sql`GRANT SELECT (id) ON public.case_law_sources TO ${role}`,
            );
            const permissions = async () => {
              await tx.execute(sql`SET LOCAL ROLE ${role}`);
              const row =
                (
                  await tx.execute<PublicLawDatabaseRolePermissions>(
                    publicLawDatabaseRolePermissionsSql(grants),
                  )
                ).at(0) ?? panic("Reader grant attestation returned no result");
              await tx.execute(sql`RESET ROLE`);
              return row;
            };
            const accepted = {
              canReadPublicLaw: true,
              canReadOtherData: false,
              canWritePublicLaw: false,
            };
            expect(await permissions()).toMatchObject(accepted);

            // Keep the required lower bound non-vacuous even before the optional
            // staged relation exists.
            await tx.execute(
              sql`REVOKE SELECT (id) ON public.case_law_sources FROM ${role}`,
            );
            expect(await permissions()).toMatchObject({
              canReadPublicLaw: false,
            });
            await tx.execute(
              sql`GRANT SELECT (id) ON public.case_law_sources TO ${role}`,
            );

            await tx.execute(
              sql`CREATE TABLE ${table} (${sql.join(
                columns.map((column) => sql`${sql.identifier(column)} text`),
                sql`, `,
              )}, private_fixture text)`,
            );
            expect(await permissions()).toMatchObject(accepted);
            await tx.execute(
              sql`GRANT SELECT (${sql.identifier(firstColumn)}) ON ${table} TO ${role}`,
            );
            expect(await permissions()).toMatchObject(accepted);
            await tx.execute(
              sql`GRANT SELECT (${columnList}) ON ${table} TO ${role}`,
            );
            expect(await permissions()).toMatchObject(accepted);

            await tx.execute(
              sql`GRANT SELECT (private_fixture) ON ${table} TO ${role}`,
            );
            expect(await permissions()).toMatchObject({
              canReadOtherData: true,
            });
            await tx.execute(
              sql`REVOKE SELECT (private_fixture) ON ${table} FROM ${role}`,
            );
            expect(await permissions()).toMatchObject(accepted);

            await tx.execute(sql`GRANT SELECT ON ${table} TO ${role}`);
            expect(await permissions()).toMatchObject({
              canReadOtherData: true,
            });
            await tx.execute(sql`REVOKE SELECT ON ${table} FROM ${role}`);
            expect(await permissions()).toMatchObject(accepted);

            await tx.execute(
              sql`GRANT UPDATE (${sql.identifier(firstColumn)}) ON ${table} TO ${role}`,
            );
            expect(await permissions()).toMatchObject({
              canWritePublicLaw: true,
            });
            await tx.execute(
              sql`REVOKE UPDATE (${sql.identifier(firstColumn)}) ON ${table} FROM ${role}`,
            );
            expect(await permissions()).toMatchObject(accepted);
            await tx.execute(sql`GRANT INSERT ON ${table} TO ${role}`);
            expect(await permissions()).toMatchObject({
              canWritePublicLaw: true,
            });
            tx.rollback();
          });
        } catch (error) {
          if (!(error instanceof TransactionRollbackError)) {
            throw error;
          }
        }
      });
    },
  );

  test("keeps expansion readers available while census readers require every census column", async () => {
    const databaseUrl =
      process.env["DATABASE_URL"] ??
      panic("Postgres census grant test requires DATABASE_URL");
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient({ max: 1 });
      const suffix = Bun.randomUUIDv7().replaceAll("-", "");
      const relation = `census_grants_${suffix}`;
      const role = sql.identifier(`census_reader_${suffix}`);
      const table = sql`${sql.identifier("public")}.${sql.identifier(relation)}`;
      const columns = Object.keys(
        CENSUS_COLUMN_GRANTS_BY_RELATION.case_law_completeness_census,
      );
      const firstColumn =
        columns.at(0) ?? panic("Census grants must not be empty");
      const columnList = sql.join(
        columns.map((column) => sql.identifier(column)),
        sql`, `,
      );
      const expansionGrants = {
        case_law_sources: { id: "required" },
        [relation]:
          CENSUS_COLUMN_GRANTS_BY_RELATION.case_law_completeness_census,
      } as const;
      const currentGrants = {
        case_law_sources: { id: "required" },
        [relation]:
          PUBLIC_LAW_COLUMN_GRANTS_BY_RELATION.case_law_completeness_census,
      } as const;

      try {
        await db.transaction(async (tx) => {
          await tx.execute(sql`CREATE ROLE ${role} NOLOGIN`);
          // CREATEROLE grants ADMIN without SET on PostgreSQL 16 and later.
          await tx.execute(
            sql`GRANT ${role} TO CURRENT_USER WITH INHERIT FALSE, SET TRUE`,
          );
          await tx.execute(sql`GRANT USAGE ON SCHEMA public TO ${role}`);
          await tx.execute(
            sql`GRANT SELECT (id) ON public.case_law_sources TO ${role}`,
          );
          const permissions = async () => {
            await tx.execute(sql`SET LOCAL ROLE ${role}`);
            const expansion =
              (
                await tx.execute<PublicLawDatabaseRolePermissions>(
                  publicLawDatabaseRolePermissionsSql(expansionGrants),
                )
              ).at(0) ?? panic("Reader grant attestation returned no result");
            const current =
              (
                await tx.execute<PublicLawDatabaseRolePermissions>(
                  publicLawDatabaseRolePermissionsSql(currentGrants),
                )
              ).at(0) ??
              panic("Current reader grant attestation returned no result");
            await tx.execute(sql`RESET ROLE`);
            return { expansion, current };
          };
          const accepted = {
            canReadPublicLaw: true,
            canReadOtherData: false,
            canWritePublicLaw: false,
          };
          const bothAccepted = { expansion: accepted, current: accepted };
          const censusNotReady = {
            expansion: accepted,
            current: { ...accepted, canReadPublicLaw: false },
          };
          expect(await permissions()).toMatchObject(censusNotReady);

          await tx.execute(
            sql`CREATE TABLE ${table} (${sql.join(
              columns.map((column) => sql`${sql.identifier(column)} text`),
              sql`, `,
            )}, private_fixture text)`,
          );
          expect(await permissions()).toMatchObject(censusNotReady);
          await tx.execute(
            sql`GRANT SELECT (${sql.identifier(firstColumn)}) ON ${table} TO ${role}`,
          );
          expect(await permissions()).toMatchObject(censusNotReady);
          await tx.execute(
            sql`GRANT SELECT (${columnList}) ON ${table} TO ${role}`,
          );
          expect(await permissions()).toMatchObject(bothAccepted);

          await tx.execute(
            sql`GRANT SELECT (private_fixture) ON ${table} TO ${role}`,
          );
          expect(await permissions()).toMatchObject({
            expansion: { canReadOtherData: true },
            current: { canReadOtherData: true },
          });
          await tx.execute(
            sql`REVOKE SELECT (private_fixture) ON ${table} FROM ${role}`,
          );
          await tx.execute(sql`GRANT INSERT ON ${table} TO ${role}`);
          expect(await permissions()).toMatchObject({
            expansion: { canWritePublicLaw: true },
            current: { canWritePublicLaw: true },
          });
          tx.rollback();
        });
      } catch (error) {
        if (!(error instanceof TransactionRollbackError)) {
          throw error;
        }
      }
    });
  });
});
