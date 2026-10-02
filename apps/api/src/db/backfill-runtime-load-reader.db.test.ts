import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { createDatabaseLoadVerdictReader } from "@/api/db/backfill-runtime";
import type { Transaction } from "@/api/db/root";
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled || databaseUrl === undefined)(
  "database load admission with restricted statistics visibility",
  () => {
    if (databaseUrl === undefined) {
      return;
    }
    const { db } = openGatedTestDatabase(databaseUrl, { max: 1 });

    test("ingestion role returns unknown before reading load signals", async () => {
      let transactions = 0;
      const read = createDatabaseLoadVerdictReader(
        {
          transaction: async (fn) =>
            await db.transaction(async (tx) => {
              transactions += 1;
              await tx.execute(sql`SET LOCAL ROLE stella_ingestion`);
              const role = (
                await tx.execute(sql`
                  SELECT current_user AS role,
                    pg_has_role(current_user, 'pg_read_all_stats', 'USAGE')
                      OR EXISTS (
                        SELECT 1 FROM pg_roles
                        WHERE rolname = current_user AND rolsuper
                      ) AS visible
                `)
              ).at(0);
              expect(role?.["role"]).toBe("stella_ingestion");
              // Assert the real deployment privilege boundary, rather than
              // fabricating a false visibility result for the reader.
              expect(role?.["visible"]).toBe(false);
              return await fn(asTestRaw<Transaction>(tx));
            }),
        },
        "case_law_decisions",
      );

      expect(await read()).toEqual({
        kind: "unknown",
        signals: [
          {
            indicator: "long_transaction",
            kind: "unknown",
            value: null,
            threshold: null,
            observedAt: null,
            reason: "Statistics visibility is unavailable",
          },
        ],
      });
      expect(transactions).toBe(1);
    });
  },
);
