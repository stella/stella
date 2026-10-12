/**
 * A decision's citations as an agent reads them first: how often and how it
 * is cited, the few decisions citing it that matter most, and what it cites.
 *
 * `read_case_law_decision` answers with this instead of the raw citation
 * rows: a list of fifty identical "sp. zn. …" strings, each with its own row
 * id, tells a model less than one count and five named decisions. The rows
 * themselves stay one call away, through `readGatedDecisionCitations`.
 *
 * Gated like every other public decision read: the reads share the
 * transaction that approved the subject.
 */
import { panic } from "better-result";
import { eq } from "drizzle-orm";

import type { DecisionTextWithheldReason } from "@stll/api-contract/case-law-text-field";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import {
  listDecisionCitationsHandler,
  listTopCitingDecisionsHandler,
  summarizeDecisionCitationsHandler,
} from "@/api/handlers/case-law/decisions/citation-graph";
import type {
  DecisionCitationRow,
  DecisionCitationSummary,
  TopCitingDecisionsResult,
} from "@/api/handlers/case-law/decisions/citation-graph";
import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { withRedistributableSubject } from "@/api/lib/case-law/public-subject";
import { decisionTextWithheldReason } from "@/api/lib/legal-search/corpus-source";
import { LIMITS } from "@/api/lib/limits";

/** Citing decisions the digest names; the rest are paged elsewhere. */
export const CITATION_DIGEST_TOP_CITING = LIMITS.caseLawTopCitingDecisions;

export type DecisionCitationDigest = {
  summary: DecisionCitationSummary;
  /** At most `CITATION_DIGEST_TOP_CITING`, most authoritative first. */
  topCiting: TopCitingDecisionsResult;
  /** The first page of what this decision cites, unresolved rows included. */
  cites: (Omit<DecisionCitationRow, "citationText"> & {
    citationText: string | null;
    textWithheldReason: DecisionTextWithheldReason | null;
  })[];
  /** Whether that page left outgoing citations unread. */
  citesMore: boolean;
};

export type ReadDecisionCitationDigestOptions = {
  caseLawDb: CaseLawPublicReadDb;
  decisionId: SafeId<"caseLawDecision">;
};

/** Null is the publication gate's answer, as for the decision read itself. */
export const readGatedDecisionCitationDigest = async ({
  caseLawDb,
  decisionId,
}: ReadDecisionCitationDigestOptions): Promise<DecisionCitationDigest | null> =>
  await withRedistributableSubject(
    caseLawDb,
    { kind: "id", id: decisionId },
    async (subject) => {
      // One transaction, one connection: the statements run in turn.
      const summary = await summarizeDecisionCitationsHandler({ subject });
      const topCiting = await listTopCitingDecisionsHandler({
        subject,
        summary,
        limit: CITATION_DIGEST_TOP_CITING,
      });
      const cites = await listDecisionCitationsHandler({
        subject,
        query: { direction: "outgoing" },
        limit: LIMITS.caseLawDecisionCitationPageSize,
      });
      // No cursor was passed, so there is none to reject.
      if (!("items" in cites)) {
        return panic("A first citation page cannot carry an invalid cursor");
      }
      const [source] = await subject.tx
        .select({ descriptor: caseLawSources.descriptor })
        .from(caseLawDecisions)
        .innerJoin(
          caseLawSources,
          eq(caseLawSources.id, caseLawDecisions.sourceId),
        )
        .where(eq(caseLawDecisions.id, subject.id))
        .limit(1);
      if (source === undefined) {
        return panic(`No source for gated decision ${String(subject.id)}`);
      }
      const textWithheldReason = decisionTextWithheldReason(source.descriptor);
      return {
        summary,
        topCiting,
        cites: cites.items.map((item) => ({
          ...item,
          citationText: textWithheldReason === null ? item.citationText : null,
          textWithheldReason,
        })),
        citesMore: cites.nextCursor !== null,
      };
    },
  );
