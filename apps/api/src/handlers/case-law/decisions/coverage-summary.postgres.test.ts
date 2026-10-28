import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql, TransactionRollbackError } from "drizzle-orm";

import { compareCodeUnit } from "@stll/collation";
import { rejectionOf } from "@stll/property-testing/rejection";

import { stella, stellaPublicLawReader } from "@/api/db/rls";
import type { Transaction } from "@/api/db/root";
import { caseLawCoverageSummaries } from "@/api/db/schema";
import { readNonRedistributableCaseLawSourceIdsQuery } from "@/api/lib/case-law/non-redistributable-sources";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { CASE_LAW_COVERAGE_FIXTURE } from "@/api/tests/helpers/case-law-coverage-fixture";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

type WithSummaryRoleOptions = {
  role: string;
  read: (tx: Transaction) => Promise<void>;
};

// The runner applies the committed migrations; fixtures change only rows and
// transaction-local role membership, preserving the migrated grants and policies.
const withSummaryRole = async ({ role, read }: WithSummaryRoleOptions) => {
  await withGatedTestClients(
    databaseUrl ?? panic("DATABASE_URL is required"),
    async ({ openClient }) => {
      const { db } = openClient({ max: 1 });
      try {
        await db.transaction(async (tx) => {
          const policy = await readNonRedistributableCaseLawSourceIdsQuery(tx);
          const summary = {
            key: "current",
            sourcePolicy: JSON.stringify(policy.toSorted(compareCodeUnit)),
            answer: CASE_LAW_COVERAGE_FIXTURE,
            generatedAt: new Date(CASE_LAW_COVERAGE_FIXTURE.generatedAt),
          };
          await tx
            .insert(caseLawCoverageSummaries)
            .values(summary)
            .onConflictDoUpdate({
              target: caseLawCoverageSummaries.key,
              set: summary,
            });
          await tx.execute(
            sql`GRANT ${sql.identifier(role)} TO CURRENT_USER WITH INHERIT FALSE, SET TRUE`,
          );
          await tx.execute(sql`SET LOCAL ROLE ${sql.identifier(role)}`);
          await read(tx);
          tx.rollback();
        });
      } catch (error) {
        if (!(error instanceof TransactionRollbackError)) {
          throw error;
        }
      }
    },
  );
};

describe.skipIf(!runPostgresTests)(
  "coverage summary on migrated PostgreSQL",
  () => {
    test("the public reader receives exactly the stored summary through the function", async () => {
      await withSummaryRole({
        role: stellaPublicLawReader.name,
        read: async (tx) => {
          const rows = await tx.execute(
            sql`SELECT public.stella_case_law_coverage_summary() AS answer`,
            "objects",
          );
          expect(rows).toHaveLength(1);
          expect(rows.at(0)?.["answer"]).toEqual(CASE_LAW_COVERAGE_FIXTURE);
        },
      });
    });

    for (const role of [stellaPublicLawReader.name, stella.name]) {
      test(`${role} cannot select the stored summary table`, async () => {
        const failure = await rejectionOf(
          withSummaryRole({
            role,
            read: async (tx) => {
              await tx.execute(
                sql`SELECT * FROM public.case_law_coverage_summaries`,
              );
            },
          }),
        );
        expect(failure).toMatchObject({
          cause: {
            message: expect.stringContaining(
              "permission denied for table case_law_coverage_summaries",
            ),
          },
        });
      });
    }
  },
);
