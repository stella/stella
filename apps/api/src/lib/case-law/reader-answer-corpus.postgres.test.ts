import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { compareCodeUnit } from "@stll/collation";
import type { DocumentAst } from "@stll/legal-ast/document-ast";

import {
  caseLawCitations,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";

import { readReaderAnswerRelated } from "./reader-answer-corpus";
import type {
  ReaderAnswerRelatedDirection,
  ReaderAnswerRelatedExcerpt,
} from "./reader-answer-corpus";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

type DecisionFixtureOptions = {
  decisionId: ReaderAnswerRelatedExcerpt["decisionId"];
  paragraphId: string;
  text: string;
  court: string;
  decisionDate: string;
};
const decisionAst = ({
  decisionId,
  paragraphId,
  text,
  court,
  decisionDate,
}: DecisionFixtureOptions) =>
  ({
    version: 1,
    source: {
      system: "reader-direction-fixture",
      documentId: decisionId,
      webUrl: "",
      printUrl: "",
    },
    metadata: {
      family: "decision",
      caseNumber: `Fixture ${decisionId}`,
      ecli: null,
      court,
      decisionDate,
      decisionType: null,
      keywords: [],
      statutes: [],
    },
    blocks: [
      {
        type: "paragraph",
        id: `block-${paragraphId}`,
        anchorId: paragraphId,
        number: 1,
        plainText: text,
        inlines: [{ type: "text", text }],
      },
    ],
  }) satisfies DocumentAst;

if (!databaseUrl || !runPostgres) {
  describe.skip("reader answer related citation directions (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  describe("reader answer related citation directions (postgres)", () => {
    test.each(["both", "cited", "citing"] as const)(
      "%s reader query preserves the real citation direction, court and date of every excerpt",
      async (direction) => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const db = openClient().db;
          const sourceId = createSafeId<"caseLawSource">();
          const originId = createSafeId<"caseLawDecision">();
          const citedId = createSafeId<"caseLawDecision">();
          const citingId = createSafeId<"caseLawDecision">();
          const cited = {
            decisionId: citedId,
            direction: "cited",
            paragraphId: "cited-p-1",
            text: "Civil liability outgoing precedent.",
            court: "Synthetic cited court",
            decisionDate: "2002-02-02",
          } satisfies ReaderAnswerRelatedExcerpt;
          const citing = {
            decisionId: citingId,
            direction: "citing",
            paragraphId: "citing-p-1",
            text: "Civil liability incoming precedent.",
            court: "Synthetic citing court",
            decisionDate: "2004-04-04",
          } satisfies ReaderAnswerRelatedExcerpt;
          const expectedByDirection = {
            both: [cited, citing],
            cited: [cited],
            citing: [citing],
          } satisfies Record<
            ReaderAnswerRelatedDirection,
            ReaderAnswerRelatedExcerpt[]
          >;
          try {
            await db.insert(caseLawSources).values(
              caseLawSourceRow({
                id: sourceId,
                adapterKey: `reader-direction-${sourceId}`,
                enabled: false,
                descriptor: {
                  license: "public-domain",
                  attribution: null,
                  allowsRedistribution: true,
                  allowsDerivedAi: true,
                },
              }),
            );
            await db.insert(caseLawDecisions).values([
              {
                id: originId,
                sourceId,
                country: "CZE",
                court: "Synthetic origin court",
                caseNumber: `Fixture ${originId}`,
                language: "cs",
                decisionDate: "2003-03-03",
                documentAst: decisionAst({
                  decisionId: originId,
                  paragraphId: "origin-p-1",
                  text: "Civil liability origin reasoning.",
                  court: "Synthetic origin court",
                  decisionDate: "2003-03-03",
                }),
              },
              ...[cited, citing].map((excerpt) => ({
                id: excerpt.decisionId,
                sourceId,
                country: "CZE",
                court: excerpt.court,
                caseNumber: `Fixture ${excerpt.decisionId}`,
                language: "cs",
                decisionDate: excerpt.decisionDate,
                documentAst: decisionAst(excerpt),
              })),
            ]);
            await db.insert(caseLawCitations).values([
              {
                id: createSafeId<"caseLawCitation">(),
                citingDecisionId: originId,
                citedDecisionId: citedId,
                citationText: "Synthetic outgoing precedent",
              },
              {
                id: createSafeId<"caseLawCitation">(),
                citingDecisionId: citingId,
                citedDecisionId: originId,
                citationText: "Synthetic incoming precedent",
              },
            ]);
            // No dependency overrides: graph candidates and paragraphs use the production reader.
            const result = await readReaderAnswerRelated({
              decisionId: originId,
              paragraphId: "origin-p-1",
              direction,
              query: "civil liability precedent",
            });
            if (result.isErr()) {
              throw result.error;
            }
            expect(
              result.value.toSorted((left, right) =>
                compareCodeUnit(left.decisionId, right.decisionId),
              ),
            ).toEqual(
              expectedByDirection[direction].toSorted((left, right) =>
                compareCodeUnit(left.decisionId, right.decisionId),
              ),
            );
          } finally {
            await db
              .delete(caseLawSources)
              .where(eq(caseLawSources.id, sourceId));
          }
        });
      },
      30_000,
    );
  });
}
