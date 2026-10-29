import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql, TransactionRollbackError } from "drizzle-orm";

import { compareCodeUnit } from "@stll/collation";
import { rejectionOf } from "@stll/property-testing/rejection";

import { stella, stellaPublicLawReader } from "@/api/db/rls";
import type { Transaction } from "@/api/db/root";
import { caseLawCoverageSummaries, caseLawSources } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { readNonRedistributableCaseLawSourceIdsQuery } from "@/api/lib/case-law/non-redistributable-sources";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { CASE_LAW_COVERAGE_SNAPSHOT_FIXTURE } from "@/api/tests/helpers/case-law-coverage-fixture";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";

const databaseUrl = process.env["DATABASE_URL"];
const WITHHELD_DESCRIPTOR = {
  license: "restricted",
  attribution: null,
  allowsRedistribution: false,
  allowsDerivedAi: false,
} as const;
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

type WithSummaryRoleOptions = {
  role: string;
  /** Source rows as they stood when the summary was computed. */
  before?: (tx: Transaction) => Promise<void>;
  /** Source changes made after the summary was stored. */
  after?: (tx: Transaction) => Promise<void>;
  read: (tx: Transaction) => Promise<void>;
};

// The runner applies the committed migrations; fixtures change only rows and
// transaction-local role membership, preserving the migrated grants and policies.
const withSummaryRole = async ({
  role,
  before,
  after,
  read,
}: WithSummaryRoleOptions) => {
  await withGatedTestClients(
    databaseUrl ?? panic("DATABASE_URL is required"),
    async ({ openClient }) => {
      const { db } = openClient({ max: 1 });
      try {
        await db.transaction(async (tx) => {
          await before?.(tx);
          const policy = await readNonRedistributableCaseLawSourceIdsQuery(tx);
          const summary = {
            key: "current",
            sourcePolicy: JSON.stringify(policy.toSorted(compareCodeUnit)),
            answer: CASE_LAW_COVERAGE_SNAPSHOT_FIXTURE,
            generatedAt: new Date(
              CASE_LAW_COVERAGE_SNAPSHOT_FIXTURE.generatedAt,
            ),
          };
          await tx
            .insert(caseLawCoverageSummaries)
            .values(summary)
            .onConflictDoUpdate({
              target: caseLawCoverageSummaries.key,
              set: summary,
            });
          await after?.(tx);
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
    test("the public reader receives exactly the stored summary through both functions", async () => {
      await withSummaryRole({
        role: stellaPublicLawReader.name,
        read: async (tx) => {
          const rows = await tx.execute(
            sql`SELECT public.stella_case_law_coverage_summary_v2() AS summary`,
          );
          expect(rows).toHaveLength(1);
          expect(rows.at(0)?.["summary"]).toEqual({
            answer: CASE_LAW_COVERAGE_SNAPSHOT_FIXTURE,
            policyCurrent: true,
          });
          // The reader of releases before the versioned function, unchanged.
          const previous = await tx.execute(
            sql`SELECT public.stella_case_law_coverage_summary() AS answer`,
          );
          expect(previous.at(0)?.["answer"]).toEqual(
            CASE_LAW_COVERAGE_SNAPSHOT_FIXTURE,
          );
        },
      });
    });

    test("a source the summary counted that is no longer redistributable refuses it", async () => {
      const countedSourceId = createSafeId<"caseLawSource">();
      const readSummary = async (tx: Transaction) =>
        (
          await tx.execute(
            sql`SELECT public.stella_case_law_coverage_summary_v2() AS summary`,
          )
        ).at(0)?.["summary"];
      const generatedAt = new Date(
        CASE_LAW_COVERAGE_SNAPSHOT_FIXTURE.generatedAt,
      );
      await withSummaryRole({
        role: stellaPublicLawReader.name,
        before: async (tx) => {
          await tx.insert(caseLawSources).values(
            caseLawSourceRow({
              id: countedSourceId,
              adapterKey: `coverage-counted-${countedSourceId}`,
              createdAt: new Date(generatedAt.getTime() - 60_000),
            }),
          );
        },
        after: async (tx) => {
          // Added after the summary and withheld from the start: not counted.
          const laterSourceId = createSafeId<"caseLawSource">();
          await tx.insert(caseLawSources).values(
            caseLawSourceRow({
              id: laterSourceId,
              adapterKey: `coverage-later-${laterSourceId}`,
              descriptor: WITHHELD_DESCRIPTOR,
              createdAt: new Date(generatedAt.getTime() + 60_000),
            }),
          );
        },
        read: async (tx) => {
          expect(await readSummary(tx)).toEqual({
            answer: CASE_LAW_COVERAGE_SNAPSHOT_FIXTURE,
            policyCurrent: false,
          });
          await tx.execute(sql`RESET ROLE`);
          await tx
            .update(caseLawSources)
            .set({ descriptor: WITHHELD_DESCRIPTOR })
            .where(eq(caseLawSources.id, countedSourceId));
          await tx.execute(
            sql`SET LOCAL ROLE ${sql.identifier(stellaPublicLawReader.name)}`,
          );
          expect(await readSummary(tx)).toBeNull();
        },
      });
    });

    // A definer function that does not name pg_temp searches the caller's
    // temporary schema first for relations; the reader may create one.
    test("relations the public reader creates in its temporary schema do not change either answer", async () => {
      const forgedSourceId = createSafeId<"caseLawSource">();
      await withSummaryRole({
        role: stellaPublicLawReader.name,
        read: async (tx) => {
          // TEMP is granted to PUBLIC by default and no migration revokes it.
          await tx.execute(sql`
            CREATE TEMP TABLE case_law_coverage_summaries (
              key text, source_policy text, answer jsonb, generated_at timestamptz
            ) ON COMMIT DROP
          `);
          await tx.execute(sql`
            INSERT INTO case_law_coverage_summaries
            VALUES ('current', '[]', '{"forged":true}', now())
          `);
          await tx.execute(sql`
            CREATE TEMP TABLE case_law_sources (
              id uuid, adapter_key text, descriptor jsonb, created_at timestamptz
            ) ON COMMIT DROP
          `);
          await tx.execute(sql`
            INSERT INTO case_law_sources
            VALUES (${forgedSourceId}, 'forged-feed', ${JSON.stringify(WITHHELD_DESCRIPTOR)}::text::jsonb, now())
          `);
          const current = await tx.execute(
            sql`SELECT public.stella_case_law_coverage_summary_v2() AS summary`,
          );
          expect(current.at(0)?.["summary"]).toEqual({
            answer: CASE_LAW_COVERAGE_SNAPSHOT_FIXTURE,
            policyCurrent: true,
          });
          const previous = await tx.execute(
            sql`SELECT public.stella_case_law_coverage_summary() AS answer`,
          );
          expect(previous.at(0)?.["answer"]).toEqual(
            CASE_LAW_COVERAGE_SNAPSHOT_FIXTURE,
          );
          // Both bodies qualify their relations, so the answers above hold
          // either way; the configuration is what keeps a later unqualified
          // reference from reading the caller's temporary schema.
          for (const reader of [
            "public.stella_case_law_coverage_summary()",
            "public.stella_case_law_coverage_summary_v2()",
          ]) {
            const rows = await tx.execute(
              sql`SELECT proconfig AS config FROM pg_proc WHERE oid = ${reader}::regprocedure`,
            );
            expect(rows.at(0)?.["config"]).toEqual([
              "search_path=pg_catalog, public, pg_temp",
            ]);
          }
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
