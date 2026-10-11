import { describe, expect, test } from "bun:test";
import { getTableName, sql } from "drizzle-orm";
import { TransactionRollbackError } from "drizzle-orm/errors";
import * as v from "valibot";

import { rejectionOf } from "@stll/property-testing/rejection";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawCitationReviews,
  caseLawCitations,
  caseLawDecisions,
  caseLawPolarityRules,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { CaseLawRootHandle } from "@/api/lib/case-law/maintenance-lane";
import { executedRows } from "@/api/lib/db/executed-rows";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import { applyFormRepairs, previewFormRepairs } from "./form-repair";
import { compileRules } from "./rule-engine";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)(
  "form repair preview and compare-and-swap on Postgres",
  () => {
    test("repairs only unchanged neutral rereadings of unreviewed form-derived rows", async () => {
      if (!databaseUrl) {
        throw new TypeError("Postgres test requires DATABASE_URL");
      }
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const outcome = await rejectionOf(
          db.transaction(async (tx) => {
            // Clone the migrated schema so query columns, defaults and checks cannot drift.
            for (const table of [
              caseLawDecisions,
              caseLawPolarityRules,
              caseLawCitations,
              caseLawCitationReviews,
            ]) {
              const name = sql.identifier(getTableName(table));
              await tx.execute(sql`CREATE TEMP TABLE ${name}
                (LIKE public.${name} INCLUDING ALL) ON COMMIT DROP`);
            }
            const formId = createSafeId<"caseLawPolarityRule">();
            const stanceId = createSafeId<"caseLawPolarityRule">();
            const rules = compileRules([
              {
                id: formId,
                kind: "form",
                polarity: "neutral",
                pattern: "compare",
                confidence: 1,
              },
              {
                id: stanceId,
                kind: "stance",
                polarity: "negative",
                pattern: "reject",
                confidence: 1,
              },
            ]);
            await tx.insert(caseLawPolarityRules).values([
              {
                id: formId,
                kind: "form",
                polarity: "neutral",
                language: "en",
                pattern: "compare",
              },
              {
                id: stanceId,
                kind: "stance",
                polarity: "negative",
                language: "en",
                pattern: "reject",
              },
            ]);
            const fixtures = [
              "unchanged",
              "reviewed",
              "late-review",
              "label-changed",
              "text-changed",
              "stance",
              "rejection",
            ].map((name) => ({
              name,
              id: createSafeId<"caseLawCitation">(),
              decisionId: createSafeId<"caseLawDecision">(),
            }));
            for (const fixture of fixtures) {
              const sections = [
                {
                  index: 0,
                  type: "argumentation" as const,
                  title: null,
                  text:
                    fixture.name === "rejection"
                      ? "reject, compare A 12/2020"
                      : "compare A 12/2020",
                },
              ];
              await tx.insert(caseLawDecisions).values({
                id: fixture.decisionId,
                sourceId: createSafeId<"caseLawSource">(),
                caseNumber: fixture.name,
                court: "Fixture court",
                country: "CZE",
                language: "en",
                sections,
                contentHash: "a".repeat(64),
              });
              await tx.execute(sql`INSERT INTO case_law_citations
            (id, citing_decision_id, citation_key, citation_text, section_index, polarity, polarity_rule_id)
            VALUES (${fixture.id}, ${fixture.decisionId}, ${fixture.name}, 'A 12/2020', 0, 'supportive', ${fixture.name === "stance" ? stanceId : formId})`);
              if (fixture.name === "reviewed") {
                await tx.insert(caseLawCitationReviews).values({
                  citingDecisionId: fixture.decisionId,
                  citationKey: fixture.name,
                  polarity: "supportive",
                  reviewRef: "fixture",
                  origin: "human-review",
                });
              }
            }
            const scopedDb: ScopedDb = async (run) => await run(tx);
            const transaction = asTestRaw<CaseLawRootHandle["transaction"]>(
              async (run: (handle: typeof tx) => Promise<unknown>) =>
                await run(tx),
            );
            const plan = await previewFormRepairs({
              scopedDb,
              language: "en",
              rules,
              after: null,
              limit: 100,
            });
            expect(plan.rows.length).toBe(4);
            expect(plan.results.length).toBe(5);
            const before = await tx.execute(
              sql`SELECT polarity FROM case_law_citations`,
            );
            expect(
              v
                .parse(
                  v.array(v.object({ polarity: v.string() })),
                  executedRows(before),
                )
                .every((row) => row.polarity === "supportive"),
            ).toBe(true);
            for (const fixture of fixtures) {
              if (fixture.name === "late-review") {
                await tx.insert(caseLawCitationReviews).values({
                  citingDecisionId: fixture.decisionId,
                  citationKey: fixture.name,
                  polarity: "supportive",
                  reviewRef: "fixture",
                  origin: "human-review",
                });
              }
              if (fixture.name === "label-changed") {
                await tx.execute(
                  sql`UPDATE case_law_citations SET polarity = 'negative' WHERE id = ${fixture.id}`,
                );
              }
              if (fixture.name === "text-changed") {
                await tx.execute(
                  sql`UPDATE case_law_decisions SET sections = '[{"index":0,"type":"argumentation","title":null,"text":"compare A 12/2020 changed"}]'::jsonb, content_hash = ${"b".repeat(64)} WHERE id = ${fixture.decisionId}`,
                );
              }
            }
            expect(
              await applyFormRepairs({ transaction, plan, rules }),
            ).toEqual({
              applied: 1,
              skipped: 3,
            });
            const after = await tx.execute(
              sql`SELECT citation_key, polarity, polarity_source FROM case_law_citations ORDER BY citation_key`,
            );
            const stored = v.parse(
              v.array(
                v.object({
                  citation_key: v.string(),
                  polarity: v.string(),
                  polarity_source: v.nullable(v.string()),
                }),
              ),
              executedRows(after),
            );
            expect(
              stored.find((row) => row.citation_key === "text-changed"),
            ).toMatchObject({
              polarity: "supportive",
              polarity_source: null,
            });
            expect(stored.filter((row) => row.polarity === "neutral")).toEqual([
              {
                citation_key: "unchanged",
                polarity: "neutral",
                polarity_source: "rule",
              },
            ]);
            expect(
              await applyFormRepairs({ transaction, plan, rules }),
            ).toEqual({
              applied: 0,
              skipped: 4,
            });
            tx.rollback();
          }),
        );
        expect(outcome).toBeInstanceOf(TransactionRollbackError);
      });
    });
  },
);
