import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import * as v from "valibot";

import { stellaPublicLawReader } from "@/api/db/rls";
import { rootDb } from "@/api/db/root";
import { toSafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import { runWithPublicReadScope } from "@/api/lib/legal-search/public-read-timeout-context";
import {
  configureReadTransaction,
  EXTERNAL_PUBLIC_LAW_READ_GUARDS,
  publicLawReadDb,
  setSharedPublicLawReaderRole,
} from "@/api/lib/public-law-read-db";
import { withMcpPublicReadAdmission } from "@/api/lib/rate-limit/mcp-public-read-admission";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

const sessionRows = (value: unknown) =>
  v.parse(
    v.array(v.object({ role: v.string(), pid: v.number() })),
    executedRows(value),
  );

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)("public-law reader transaction role", () => {
  test.each(["read-committed", "repeatable-read"] as const)(
    "%s reads use the reader and restore the shared pool role",
    async (isolation) => {
      const before = sessionRows(
        await rootDb.execute(
          sql`SELECT current_user AS role, pg_backend_pid() AS pid`,
        ),
      );
      const during = await publicLawReadDb(
        async (tx) =>
          executedRows(
            await tx.execute(
              sql`SELECT current_user AS role, pg_backend_pid() AS pid`,
            ),
          ),
        { isolation },
      );
      const after = sessionRows(
        await rootDb.execute(
          sql`SELECT current_user AS role, pg_backend_pid() AS pid`,
        ),
      );
      expect(sessionRows(during).map(({ role }) => role)).toEqual([
        stellaPublicLawReader.name,
      ]);
      expect(after.map(({ role }) => role)).toEqual(
        before.map(({ role }) => role),
      );
    },
  );

  test.each(["read-committed", "repeatable-read"] as const)(
    "%s role setup does not leak into the next transaction on the same pooled backend",
    async (isolation) => {
      const url =
        process.env["DATABASE_URL"] ?? panic("PostgreSQL URL required");
      await withGatedTestClients(url, async ({ openClient }) => {
        const { db } = openClient({ max: 1 });
        const before = sessionRows(
          await db.execute(
            sql`SELECT current_user AS role, pg_backend_pid() AS pid`,
          ),
        );
        const during = await db.transaction(async (tx) => {
          await setSharedPublicLawReaderRole(tx);
          await configureReadTransaction(
            tx,
            isolation,
            EXTERNAL_PUBLIC_LAW_READ_GUARDS,
          );
          return sessionRows(
            await tx.execute(
              sql`SELECT current_user AS role, pg_backend_pid() AS pid`,
            ),
          );
        });
        const after = await db.transaction(async (tx) =>
          sessionRows(
            await tx.execute(
              sql`SELECT current_user AS role, pg_backend_pid() AS pid`,
            ),
          ),
        );
        expect(during).toEqual([
          { role: stellaPublicLawReader.name, pid: before.at(0)?.pid },
        ]);
        expect(after).toEqual(before);
      });
    },
  );

  test("cancelled and denied admission never enter the reader transaction", async () => {
    let entered = 0;
    const read = async () =>
      await publicLawReadDb(async () => {
        entered += 1;
      });
    const controller = new AbortController();
    controller.abort(new DOMException("Read cancelled", "AbortError"));
    const cancelled = await runWithPublicReadScope(
      { budgetMs: 1000, signal: controller.signal },
      read,
    );
    expect(Result.isError(cancelled)).toBe(true);
    const denied = await withMcpPublicReadAdmission({
      caller: {
        organizationId: toSafeId<"organization">("reader_role_org"),
        userId: toSafeId<"user">("reader_role_user"),
        clientId: "reader_role_client",
      },
      limit: 1,
      redis: { send: async () => [0, 1000] },
      run: read,
    });
    if (Result.isOk(denied)) {
      panic("Admission must refuse the occupied slot");
    }
    expect(entered).toBe(0);
  });
});
