import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { TransactionRollbackError } from "drizzle-orm/errors";
import * as v from "valibot";

import { rejectionOf } from "@stll/property-testing/rejection";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawCitations } from "@/api/db/schema";
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
            await tx.execute(sql`CREATE TEMP TABLE case_law_decisions (
          id uuid PRIMARY KEY, country text, language text, sections jsonb
        ) ON COMMIT DROP`);
            await tx.execute(sql`CREATE TEMP TABLE case_law_polarity_rules (
          id uuid PRIMARY KEY, kind text, polarity text, source text, pattern text
        ) ON COMMIT DROP`);
            await tx.execute(sql`CREATE TEMP TABLE case_law_citations (
          id uuid PRIMARY KEY, citing_decision_id uuid, citation_key text,
          citation_text text, section_index ${sql.raw(caseLawCitations.sectionIndex.getSQLType())}, polarity text, polarity_rule_id uuid,
          polarity_source text, polarity_classifier_version text, polarity_window_start ${sql.raw(caseLawCitations.polarityWindowStart.getSQLType())},
          polarity_window_end ${sql.raw(caseLawCitations.polarityWindowEnd.getSQLType())}, polarity_confidence ${sql.raw(caseLawCitations.polarityConfidence.getSQLType())}, cited_part text
        ) ON COMMIT DROP`);
            await tx.execute(sql`CREATE TEMP TABLE case_law_citation_reviews (
          citing_decision_id uuid, citation_key text
        ) ON COMMIT DROP`);
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
            await tx.execute(sql`INSERT INTO case_law_polarity_rules VALUES
          (${formId}, 'form', 'neutral', 'manual', 'compare'), (${stanceId}, 'stance', 'negative', 'manual', 'reject')`);
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
              const sections = JSON.stringify([
                {
                  text:
                    fixture.name === "rejection"
                      ? "reject, compare A 12/2020"
                      : "compare A 12/2020",
                },
              ]);
              await tx.execute(
                sql`INSERT INTO case_law_decisions VALUES (${fixture.decisionId}, 'XXX', 'en', ${sections}::text::jsonb)`,
              );
              await tx.execute(sql`INSERT INTO case_law_citations
            (id, citing_decision_id, citation_key, citation_text, section_index, polarity, polarity_rule_id)
            VALUES (${fixture.id}, ${fixture.decisionId}, ${fixture.name}, 'A 12/2020', 0, 'supportive', ${fixture.name === "stance" ? stanceId : formId})`);
              if (fixture.name === "reviewed") {
                await tx.execute(
                  sql`INSERT INTO case_law_citation_reviews VALUES (${fixture.decisionId}, ${fixture.name})`,
                );
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
                await tx.execute(
                  sql`INSERT INTO case_law_citation_reviews VALUES (${fixture.decisionId}, ${fixture.name})`,
                );
              }
              if (fixture.name === "label-changed") {
                await tx.execute(
                  sql`UPDATE case_law_citations SET polarity = 'negative' WHERE id = ${fixture.id}`,
                );
              }
              if (fixture.name === "text-changed") {
                await tx.execute(
                  sql`UPDATE case_law_decisions SET sections = '[{"text":"compare A 12/2020 changed"}]'::jsonb WHERE id = ${fixture.decisionId}`,
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
            expect(
              v
                .parse(
                  v.array(
                    v.object({
                      citation_key: v.string(),
                      polarity: v.string(),
                      polarity_source: v.nullable(v.string()),
                    }),
                  ),
                  executedRows(after),
                )
                .filter((row) => row.polarity === "neutral"),
            ).toEqual([
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
