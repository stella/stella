import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import nodePath from "node:path";

import { rejectionOf } from "@stll/property-testing/rejection";

import { withGatedTestClients } from "@/api/tests/gated-test-database";

import { runMigrations } from "./migration-runner";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const migrationsFolder = nodePath.resolve(import.meta.dir, "../../drizzle");
const applicationRoles = [
  "stella",
  "stella_case_law_analysis_reader",
  "stella_case_law_analysis_writer",
  "stella_caselaw_reader",
  "stella_corpus_sample_reader",
  "stella_entity_gate",
  "stella_ingestion",
  "stella_public_law_reader",
  "stella_public_sanctions_reader",
] as const;

describe.skipIf(!runPostgresTests || databaseUrl === undefined)(
  "database temporary-object privilege",
  () => {
    // timeout: applying the complete committed migration bundle is part of this PostgreSQL boundary test
    test("application roles cannot create temporary objects while the database owner can", async () => {
      const url = databaseUrl ?? panic("DATABASE_URL is required");
      await withGatedTestClients(url, async ({ openClient }) => {
        const admin = openClient().sql;
        const connection = await admin.reserve();
        try {
          await runMigrations({
            connection,
            migrationsFolder,
            databaseUrl: url,
            ebs: { type: "disabled" },
          });
        } finally {
          await connection.release();
        }

        const roles = await admin<[{ role: string }]>`SELECT rolname AS role
        FROM pg_roles WHERE rolname LIKE 'stella%' AND NOT rolcanlogin ORDER BY rolname`;
        expect(roles.map(({ role }) => role)).toEqual([...applicationRoles]);

        const publicPrivilege = await admin<
          [{ allowed: boolean }]
        >`SELECT has_database_privilege('public', current_database(), 'TEMPORARY') AS allowed`;
        expect(publicPrivilege.at(0)?.allowed).toBe(false);

        for (const role of applicationRoles) {
          const refusal = await rejectionOf(
            admin.begin(async (tx) => {
              await tx.unsafe(`SET LOCAL ROLE "${role}"`);
              await tx.unsafe(
                "CREATE TEMP TABLE temporary_privilege_probe (id integer)",
              );
            }),
          );
          expect(refusal).toMatchObject({
            code: "ERR_POSTGRES_SERVER_ERROR",
            errno: "42501",
          });
        }

        await admin.begin(async (tx) => {
          await tx`CREATE TEMP TABLE temporary_owner_probe (id integer) ON COMMIT DROP`;
          const created = await tx<
            [{ exists: boolean }]
          >`SELECT to_regclass('pg_temp.temporary_owner_probe') IS NOT NULL AS exists`;
          expect(created.at(0)?.exists).toBe(true);
        });
      });
    }, 30_000);
  },
);
