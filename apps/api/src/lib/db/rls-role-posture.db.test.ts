import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import {
  assertApplicationRlsRolePosture,
  reportDatabaseLoginPosture,
} from "@/api/lib/db/assert-migrations-applied";

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
    test("accepts the migrated application role", async () => {
      expect(await capturePostureRejection()).toBeNull();
    });

    test("reports the connecting login's attributes", async () => {
      const [current] = await rootDb.execute<{ name: string }>(
        sql`SELECT CURRENT_USER AS name`,
      );
      const posture = await reportDatabaseLoginPosture();

      expect(posture?.loginName).toBe(current?.name);
      // Tests run as the login that applied the migrations, which owns them.
      expect(posture?.ownedPolicyTables).toBeGreaterThan(0);
    });
  });
}
