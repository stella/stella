import { inArray } from "drizzle-orm";

import { courtParagraphNumbersByAnchor } from "@stll/legal-ast/court-paragraph-number";

import { caseLawDecisions } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { readDecisionAnalysisAst } from "@/api/lib/case-law/decision-analysis";
import { withRedistributableDecisions } from "@/api/lib/case-law/public-subject";
import { readCorpusTombstones } from "@/api/lib/legal-search/corpus-reads";

/** Court numbers by the anchor each numbered block is cited by. */
export type CourtParagraphNumbersByDecision = ReadonlyMap<
  SafeId<"caseLawDecision">,
  ReadonlyMap<string, number>
>;

/**
 * The most decisions one call resolves. A turn cites a handful; the bound
 * keeps a text stuffed with links from turning one answer into a corpus scan.
 */
export const COURT_PARAGRAPH_NUMBER_DECISIONS_MAX = 16;

/**
 * The court paragraph numbers of the named decisions, through the public
 * corpus gate: one statement decides which decisions the public may read and
 * fetches their document pointers, and only the numbered blocks' anchors are
 * kept of each document. A decision that is missing, restricted, absorbed,
 * or over the bound, or whose document holds no AST, is absent from the
 * result, which callers read as "no number".
 */
export const loadCourtParagraphNumbers = async ({
  caseLawDb = caseLawPublicReadDb,
  decisionIds,
}: {
  caseLawDb?: CaseLawPublicReadDb | undefined;
  decisionIds: readonly SafeId<"caseLawDecision">[];
}): Promise<CourtParagraphNumbersByDecision> => {
  const ids = [...new Set(decisionIds)].slice(
    0,
    COURT_PARAGRAPH_NUMBER_DECISIONS_MAX,
  );
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await withRedistributableDecisions(
    caseLawDb,
    ids,
    async (subjects) => {
      const [first] = subjects;
      return first === undefined
        ? []
        : await first.tx
            .select({
              id: caseLawDecisions.id,
              astS3Key: caseLawDecisions.astS3Key,
              contentHash: caseLawDecisions.contentHash,
              documentAst: caseLawDecisions.documentAst,
            })
            .from(caseLawDecisions)
            .where(
              inArray(
                caseLawDecisions.id,
                subjects.map((subject) => subject.id),
              ),
            );
    },
  );
  // Outside the gate's transaction: the documents live in object storage. A
  // read that fails rejects the whole lookup; the caller decides what a
  // failed lookup costs.
  const entries = await Promise.all(
    rows.map(async (row) => {
      const ast = await readDecisionAnalysisAst(row, readCorpusTombstones);
      return ast === null
        ? null
        : ([row.id, courtParagraphNumbersByAnchor(ast.blocks)] as const);
    }),
  );
  return new Map(entries.filter((entry) => entry !== null));
};
