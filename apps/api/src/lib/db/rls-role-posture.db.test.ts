import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { assertApplicationRlsRolePosture } from "@/api/lib/db/assert-migrations-applied";

import { APPLICATION_RLS_ROLE_NAME } from "../../db/role-names";

const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const capturePostureRejection = async () =>
  await assertApplicationRlsRolePosture().then(
    () => null,
    (error: unknown) => error,
  );

if (!runPostgresTests) {
  describe.skip("application RLS role database posture", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true", () => {
      expect(runPostgresTests).toBe(false);
    });
  });
} else {
  describe("application RLS role database posture", () => {
    test("rejects BYPASSRLS", async () => {
      await rootDb.execute(
        sql.raw(`ALTER ROLE ${APPLICATION_RLS_ROLE_NAME} BYPASSRLS`),
      );
      try {
        const rejection = await capturePostureRejection();
        expect(rejection).toMatchObject({
          message: "Application RLS role must not bypass row security.",
        });
      } finally {
        await rootDb.execute(
          sql.raw(`ALTER ROLE ${APPLICATION_RLS_ROLE_NAME} NOBYPASSRLS`),
        );
      }
    });

    test("rejects SUPERUSER", async () => {
      await rootDb.execute(
        sql.raw(`ALTER ROLE ${APPLICATION_RLS_ROLE_NAME} SUPERUSER`),
      );
      try {
        const rejection = await capturePostureRejection();
        expect(rejection).toMatchObject({
          message: "Application RLS role must not bypass row security.",
        });
      } finally {
        await rootDb.execute(
          sql.raw(`ALTER ROLE ${APPLICATION_RLS_ROLE_NAME} NOSUPERUSER`),
        );
      }
    });
  });
}
