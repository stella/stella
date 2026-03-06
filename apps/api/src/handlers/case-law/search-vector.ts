import { sql } from "drizzle-orm";

import { db } from "@/api/db";
import { caseLawDecisions } from "@/api/db/schema";
import type { DecisionSection } from "./types";

const sectionsToPlainText = (sections: DecisionSection[] | null): string =>
  sections?.map((s) => s.text).join(" ") ?? "";

/**
 * Recompute and persist the tsvector search column for a
 * single decision. Called after ingestion insert/update.
 *
 * Uses the 'simple' configuration (language-agnostic) since
 * decisions span multiple languages (Czech, Slovak, etc.).
 */
export const updateDecisionSearchVector = async (
  decisionId: string,
  caseNumber: string,
  court: string,
  fulltext: string | null,
  sections: DecisionSection[] | null,
) => {
  const bodyText = fulltext ?? sectionsToPlainText(sections);

  await db
    .update(caseLawDecisions)
    .set({
      searchVector: sql`to_tsvector(
        'simple',
        ${caseNumber} || ' ' ||
        ${court} || ' ' ||
        ${bodyText}
      )`,
    })
    .where(sql`${caseLawDecisions.id} = ${decisionId}`);
};
