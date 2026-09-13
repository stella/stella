import { Result } from "better-result";
import { desc, eq, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawDecisions,
  caseLawMatterLinks,
  caseLawSources,
} from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { readDecisionHeadnote } from "@/api/lib/case-law/decision-text";
import { readPublicDecisionLanguageAlternatesByGroup } from "@/api/lib/case-law/language-alternates";
import { publisherSummaryMetadataSql } from "@/api/lib/case-law/publisher-summary";
import { redistributableCaseLawSource } from "@/api/lib/case-law/redistribution";
import { LIMITS } from "@/api/lib/limits";

type ListMatterLinksProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  /** The public corpus gate the language versions are read through. */
  caseLawDb: CaseLawPublicReadDb;
};

export const listMatterLinksHandler = async ({
  caseLawDb,
  scopedDb,
  workspaceId,
}: ListMatterLinksProps) => {
  const rows = await scopedDb((tx) =>
    tx
      .select({
        id: caseLawMatterLinks.id,
        decisionId: caseLawMatterLinks.decisionId,
        note: caseLawMatterLinks.note,
        linkedBy: caseLawMatterLinks.linkedBy,
        createdAt: caseLawMatterLinks.createdAt,
        caseNumber: caseLawDecisions.caseNumber,
        slug: caseLawDecisions.slug,
        ecli: caseLawDecisions.ecli,
        court: caseLawDecisions.court,
        country: caseLawDecisions.country,
        language: caseLawDecisions.language,
        languageGroupKey: caseLawDecisions.languageGroupKey,
        decisionDate: caseLawDecisions.decisionDate,
        decisionType: caseLawDecisions.decisionType,
        citationCount: caseLawDecisions.citationCount,
        // Publisher text follows the source's terms, exactly as the search
        // hit does: a source that withholds redistribution contributes the
        // row's own facts and no borrowed prose.
        headnote: sql<string | null>`CASE WHEN ${redistributableCaseLawSource}
          THEN ${publisherSummaryMetadataSql(caseLawDecisions.metadata)}
        END`,
      })
      .from(caseLawMatterLinks)
      .innerJoin(
        caseLawDecisions,
        eq(caseLawDecisions.id, caseLawMatterLinks.decisionId),
      )
      .innerJoin(
        caseLawSources,
        eq(caseLawSources.id, caseLawDecisions.sourceId),
      )
      .where(eq(caseLawMatterLinks.workspaceId, workspaceId))
      .orderBy(desc(caseLawMatterLinks.createdAt), desc(caseLawMatterLinks.id))
      .limit(LIMITS.caseLawMatterLinksPerWorkspace),
  );

  // The versions of each linked decision, through the same helper the search
  // hit uses: a multilingual decision the client cannot tell apart from a
  // monolingual one loses the language segment of its route, and the slug
  // lookup then resolves whichever translation matches.
  const alternatesByGroupKey =
    await readPublicDecisionLanguageAlternatesByGroup({
      caseLawDb,
      languageGroupKeys: [
        ...new Set(
          rows
            .map((row) => row.languageGroupKey)
            .filter((value): value is string => value !== null),
        ),
      ],
    });

  return {
    links: rows.map((row) => ({
      id: row.id,
      decisionId: row.decisionId,
      note: row.note,
      linkedBy: row.linkedBy,
      createdAt: row.createdAt,
      decision: {
        id: row.decisionId,
        caseNumber: row.caseNumber,
        slug: row.slug,
        ecli: row.ecli,
        court: row.court,
        country: row.country,
        language: row.language,
        languageAlternates: alternatesByGroupKey.alternatesFor(
          row.languageGroupKey,
        ),
        decisionDate: row.decisionDate,
        decisionType: row.decisionType,
        citationCount: row.citationCount,
        // The same preview the search hit renders, so a linked decision reads
        // identically in the matter and in the results table.
        headnote: readDecisionHeadnote(row.headnote),
      },
    })),
  };
};

const config = {
  description:
    "List the case-law decisions linked to the current matter, newest link " +
    "first, each with its note and the decision's row facts: case number, " +
    "slug, ECLI, court, country, language, the decision's other language " +
    "versions, date, type, citation count and headnote preview. Returns the " +
    "whole set up to the per-matter link cap; there is no pagination.",
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "legal_corpus_admin" },
  access: "read",
} satisfies HandlerConfig;

const listMatterLinks = createSafeHandler(
  config,
  async function* ({ scopedDb, workspaceId }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await listMatterLinksHandler({
            workspaceId,
            scopedDb,
            caseLawDb: caseLawPublicReadDb,
          }),
      ),
    );

    return Result.ok(response);
  },
);

export default listMatterLinks;
