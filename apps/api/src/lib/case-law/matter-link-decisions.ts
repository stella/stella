import { and, eq, inArray, sql } from "drizzle-orm";

import { caseLawSources, publishedCaseLawDecisions } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";

import {
  publisherHeadnoteMetadataSql,
  publisherKeywordsMetadataSql,
} from "./publisher-summary";
import { redistributableCaseLawSource } from "./redistribution";

export const readMatterLinkDecisions = async (
  caseLawDb: CaseLawPublicReadDb,
  ids: readonly SafeId<"caseLawDecision">[],
) => {
  if (ids.length === 0) {
    return [];
  }
  return await caseLawDb((tx) =>
    tx
      .select({
        decisionId: publishedCaseLawDecisions.id,
        caseNumber: publishedCaseLawDecisions.caseNumber,
        slug: publishedCaseLawDecisions.slug,
        ecli: publishedCaseLawDecisions.ecli,
        court: publishedCaseLawDecisions.court,
        country: publishedCaseLawDecisions.country,
        language: publishedCaseLawDecisions.language,
        languageGroupKey: publishedCaseLawDecisions.languageGroupKey,
        decisionDate: publishedCaseLawDecisions.decisionDate,
        decisionType: publishedCaseLawDecisions.decisionType,
        citationCount: publishedCaseLawDecisions.citationCount,
        descriptor: caseLawSources.descriptor,
        // Publisher text follows the source's terms, exactly as the search
        // hit does: a source that withholds redistribution contributes the
        // row's own facts and no borrowed prose.
        headnote: sql<string | null>`CASE WHEN ${redistributableCaseLawSource}
          THEN ${publisherHeadnoteMetadataSql(publishedCaseLawDecisions.metadata)}
        END`,
        keywords: sql<string[] | null>`CASE WHEN ${redistributableCaseLawSource}
          THEN ${publisherKeywordsMetadataSql(publishedCaseLawDecisions.metadata)}
        END`,
      })
      .from(publishedCaseLawDecisions)
      .innerJoin(
        caseLawSources,
        eq(caseLawSources.id, publishedCaseLawDecisions.sourceId),
      )
      .where(and(inArray(publishedCaseLawDecisions.id, [...ids])))
      .limit(ids.length),
  );
};
