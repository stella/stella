import { describe, expect, test } from "bun:test";
import { getTableName, sql } from "drizzle-orm";
import { TransactionRollbackError } from "drizzle-orm/errors";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { rejectionOf } from "@stll/property-testing/rejection";
import { sha256Hex } from "@stll/sha256/bun";

import {
  caseLawCitationDoctrineReviews,
  caseLawCitationReviews,
  caseLawCitations,
  caseLawDecisions,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import { DOCTRINE_LABEL_DOMAIN } from "@/api/scripts/apply-reviewed-citation-labels-doctrine";
import {
  applyReviewedCitationLabels,
  planReviewedCitationLabels,
} from "@/api/scripts/apply-reviewed-citation-labels-plan";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

import { CITATION_REVIEW_ORIGIN } from "./consts";
import { applyCitationReviews, applyDoctrineReviews } from "./reviews";
import { citationTextRevisionFingerprintSql } from "./text-revision";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)("review text revisions on Postgres", () => {
  test("both model domains expire before precedence while human reviews survive", async () => {
    if (!databaseUrl) {
      throw new TypeError("Postgres test requires DATABASE_URL");
    }
    const directory = await mkdtemp(path.join(tmpdir(), "reviews-postgres-"));
    try {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const outcome = await rejectionOf(
          db.transaction(async (tx) => {
            // Use migrated columns, defaults and checks, isolated from the public corpus.
            for (const table of [
              caseLawDecisions,
              caseLawCitations,
              caseLawCitationReviews,
              caseLawCitationDoctrineReviews,
            ]) {
              const name = sql.identifier(getTableName(table));
              await tx.execute(sql`CREATE TEMP TABLE ${name}
                (LIKE public.${name} INCLUDING ALL) ON COMMIT DROP`);
            }
            const decisionId = createSafeId<"caseLawDecision">();
            const passage = "The earlier ruling does not apply to these facts.";
            await tx.insert(caseLawDecisions).values({
              id: decisionId,
              sourceId: createSafeId<"caseLawSource">(),
              caseNumber: "Review revision fixture",
              court: "Fixture court",
              country: "CZE",
              language: "en",
              sections: [
                { index: 0, type: "argumentation", title: null, text: passage },
              ],
              contentHash: "a".repeat(64),
            });
            const citation = {
              id: createSafeId<"caseLawCitation">(),
              citingDecisionId: decisionId,
              citationKey: "fixture-key",
              citationText: "A 12/2020",
              sectionIndex: 0,
              polarity: "negative",
              doctrinalTreatment: null,
            } as const satisfies typeof caseLawCitations.$inferInsert;
            await tx.insert(caseLawCitations).values(citation);
            const fingerprint = async () => {
              const rows = executedRows(
                await tx.execute(sql`
                SELECT ${citationTextRevisionFingerprintSql({
                  contentHash: caseLawDecisions.contentHash,
                  sections: caseLawDecisions.sections,
                })} AS digest FROM ${caseLawDecisions} WHERE id = ${decisionId}::uuid
              `),
              );
              return v.parse(v.object({ digest: v.string() }), rows.at(0))
                .digest;
            };
            const transact: Parameters<
              typeof planReviewedCitationLabels
            >[0]["transact"] = async (run) => await run(tx);
            const apply = async (input: readonly unknown[]) => {
              const applied = await applyReviewedCitationLabels({
                transact,
                input,
                domain: DOCTRINE_LABEL_DOMAIN,
                resultsPath: path.join(directory, "results.jsonl"),
              });
              if (applied.isErr()) {
                throw applied.error;
              }
              return applied.value;
            };
            const restore = async () =>
              await applyDoctrineReviews(
                tx,
                await applyCitationReviews(tx, [citation]),
              );
            const ids = {
              citingDecisionId: decisionId,
              citationKey: citation.citationKey,
            };
            const provenance = {
              origin: CITATION_REVIEW_ORIGIN.AI_ADJUDICATED,
              model: "fixture-model",
              promptVersion: "fixture-v1",
              promptSha256: "b".repeat(64),
              evidenceSha256: sha256Hex(passage),
              textRevisionSha256: await fingerprint(),
              runId: "fixture-original",
              producedAt: "2026-10-07T08:00:00Z",
            };
            const stance = {
              ...ids,
              polarity: "positive",
              reviewRef: "stance",
              ...provenance,
            };
            const doctrine = {
              ...ids,
              kind: "doctrine",
              doctrinalTreatment: "distinguishes",
              passage,
              evidenceQuote: "does not apply",
              reviewRef: "doctrine",
              ...provenance,
            };
            expect(await apply([stance, doctrine])).toMatchObject({
              summary: { applied: 2 },
              relabelled: 2,
            });
            expect(await restore()).toMatchObject([
              { polarity: "positive", doctrinalTreatment: "distinguishes" },
            ]);
            // Sections alone change the digest even when the corpus content hash is unchanged.
            await tx.execute(sql`UPDATE case_law_decisions
              SET sections = sections || '[{"index":1,"type":"argumentation","title":null,"text":"Costs are considered separately."}]'::jsonb
              WHERE id = ${decisionId}::uuid`);
            const revision = await fingerprint();
            expect(revision).not.toBe(provenance.textRevisionSha256);
            expect(await restore()).toMatchObject([
              { polarity: "negative", doctrinalTreatment: null },
            ]);
            const currentProvenance = {
              ...provenance,
              origin: CITATION_REVIEW_ORIGIN.AI_ANNOTATION,
              textRevisionSha256: revision,
              runId: "fixture-current",
            };
            const entries = [
              stance,
              doctrine,
              { ...stance, ...currentProvenance, polarity: "neutral" },
              {
                ...doctrine,
                ...currentProvenance,
                doctrinalTreatment: "limits",
              },
            ];
            const planned = await planReviewedCitationLabels({
              transact,
              input: entries,
              domain: DOCTRINE_LABEL_DOMAIN,
            });
            expect(planned.summary).toMatchObject({
              stale: 2,
              applied: 2,
              invalid: 0,
              "refused-precedence": 0,
            });
            expect((await apply(entries)).rows).toEqual(planned.rows);
            expect(await restore()).toMatchObject([
              { polarity: "neutral", doctrinalTreatment: "limits" },
            ]);
            await apply([
              {
                ...ids,
                polarity: "positive",
                reviewRef: "human-stance",
                origin: CITATION_REVIEW_ORIGIN.HUMAN_REVIEW,
              },
              {
                ...ids,
                kind: "doctrine",
                doctrinalTreatment: "distinguishes",
                passage,
                evidenceQuote: "does not apply",
                reviewRef: "human-doctrine",
                origin: CITATION_REVIEW_ORIGIN.HUMAN_REVIEW,
              },
            ]);
            await tx.execute(
              sql`UPDATE case_law_decisions SET content_hash = ${"c".repeat(64)} WHERE id = ${decisionId}::uuid`,
            );
            expect(await restore()).toMatchObject([
              { polarity: "positive", doctrinalTreatment: "distinguishes" },
            ]);
            tx.rollback();
          }),
        );
        expect(outcome).toBeInstanceOf(TransactionRollbackError);
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
