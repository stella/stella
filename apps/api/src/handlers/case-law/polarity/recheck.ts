/**
 * The `--recheck` walk of `scripts/classify-citations.ts`: re-read a
 * language's labelled citations against the rule tier and keep the answer
 * only where it is more severe than the label on the row.
 */

import { panic } from "better-result";
import { and, asc, eq, gt, isNotNull, ne, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawCitations, caseLawDecisions } from "@/api/db/schema";
import { runCitationGraphTransaction } from "@/api/handlers/case-law/citation-graph-transaction";
import { CITATION_KIND } from "@/api/handlers/case-law/citation-kind";
import { classifyCitedPart } from "@/api/handlers/case-law/polarity/cited-part";
import {
  POLARITY,
  POLARITY_CLASSIFIER_VERSION,
  POLARITY_PRECEDENCE,
  isValidPolarity,
} from "@/api/handlers/case-law/polarity/consts";
import type { Polarity } from "@/api/handlers/case-law/polarity/consts";
import { extractContexts } from "@/api/handlers/case-law/polarity/context";
import { unreviewedCitationSql } from "@/api/handlers/case-law/polarity/reviews";
import {
  ACTIVE_RULE_SOURCES,
  selectCitationPolarity,
} from "@/api/handlers/case-law/polarity/rule-engine";
import type { CompiledRule } from "@/api/handlers/case-law/polarity/rule-engine";
import { citationTextRevisionFence } from "@/api/handlers/case-law/polarity/text-revision";
import type { CitationTextRevision } from "@/api/handlers/case-law/polarity/text-revision";
import type { SafeId } from "@/api/lib/branded-types";
import type { CitationEvidenceWindows } from "@/api/lib/case-law/citation-evidence";
import type { CitedPart } from "@/api/lib/case-law/citation-vocabulary";
import { numericColumnParam } from "@/api/lib/db/column-storage";
import { executedRows } from "@/api/lib/db/executed-rows";
import { brandPersistedCaseLawCitationId } from "@/api/lib/safe-id-boundaries";

/** Rows read per statement on a recheck walk. */
const RECHECK_BATCH = 1000;

type Tightened = {
  citingDecisionId: SafeId<"caseLawDecision">;
  textRevision: CitationTextRevision;
  id: SafeId<"caseLawCitation">;
  polarity: Polarity;
  ruleId: SafeId<"caseLawPolarityRule">;
  previousPolarity: Polarity;
  evidenceWindows: CitationEvidenceWindows;
  confidence: number;
  citedPart: CitedPart;
};

/**
 * One statement per page: the tightened rows take their new verdicts. A row
 * reviewed after the page was read keeps its review.
 */
export const persistTightened = async (
  scopedDb: ScopedDb,
  rows: readonly Tightened[],
) => {
  if (rows.length === 0) {
    return { applied: 0, skipped: 0 };
  }
  const changed = await runCitationGraphTransaction(
    scopedDb,
    async (tx) =>
      // audit: skip — background polarity classification pipeline; no user-facing state change
      await tx.execute(sql`
      UPDATE ${caseLawCitations} AS c
         SET polarity = v.polarity,
             polarity_rule_id = v.rule_id,
             polarity_source = 'rule',
             polarity_classifier_version = ${POLARITY_CLASSIFIER_VERSION},
             polarity_evidence_windows = v.evidence_windows,
             polarity_confidence = v.confidence,
             cited_part = v.cited_part
        FROM (VALUES ${sql.join(
          rows.map(
            (row) =>
              sql`(${row.id}::uuid, ${row.polarity}::text, ${row.ruleId}::uuid, ${row.previousPolarity}::text, ${JSON.stringify(row.evidenceWindows)}::text::jsonb, ${numericColumnParam(caseLawCitations.polarityConfidence, row.confidence)}, ${row.citedPart}::text, ${row.citingDecisionId}::uuid, ${row.textRevision.contentHash}::text, ${row.textRevision.sections === null ? null : JSON.stringify(row.textRevision.sections)}::text::jsonb)`,
          ),
          sql.raw(","),
        )}) AS v(id, polarity, rule_id, previous_polarity, evidence_windows, confidence, cited_part, citing_decision_id, content_hash, sections)
       WHERE c.id = v.id
         AND c.citing_decision_id = v.citing_decision_id
         AND ${citationTextRevisionFence({
           citingDecisionId: sql.raw("v.citing_decision_id"),
           expectedContentHash: sql.raw("v.content_hash"),
           expectedSections: sql.raw("v.sections"),
         })}
         AND c.polarity = v.previous_polarity
         AND EXISTS (
           SELECT 1 FROM case_law_polarity_rules r
            WHERE r.id = v.rule_id
              AND r.source IN (${sql.join(
                ACTIVE_RULE_SOURCES.map((source) => sql`${source}`),
                sql.raw(","),
              )})
         )
         AND ${unreviewedCitationSql({
           citingDecisionId: sql.raw("c.citing_decision_id"),
           citationKey: sql.raw("c.citation_key"),
         })}
      RETURNING c.id
    `),
  );
  const applied = executedRows(changed).length;
  return { applied, skipped: rows.length - applied };
};

type RecheckTotals = {
  read: number;
  tightened: number;
  skipped: number;
  noContext: number;
};

type RecheckOptions = {
  scopedDb: ScopedDb;
  language: string;
  rules: readonly CompiledRule[];
  /** Resume the id-ordered walk after this citation id. */
  after: string | null;
  /** Rows the walk may read in total. */
  limit: number;
  dryRun: boolean;
};

type RecheckResult = {
  /** Where to resume; null once the language is exhausted. */
  after: string | null;
  totals: RecheckTotals;
};

type RecheckPageArgs = RecheckOptions & { totals: RecheckTotals };

/**
 * One page of the walk, then the next: a page is read, its verdicts are
 * settled in one statement, and the walk recurses from the page's last id
 * until the limit or the end of the language. Recursion rather than a loop
 * so each page's read and write are the page's own awaits, and a crash
 * between pages keeps every page already written.
 */
const recheckPage = async (args: RecheckPageArgs): Promise<RecheckResult> => {
  const { scopedDb, language, rules, after, limit, dryRun, totals } = args;
  // The rows the pipeline would label: invoked authority, in this language,
  // not already at the severity nothing outranks, and not reviewed. `unknown`
  // rows are in: the model tiers failed on them, no other pass revisits them,
  // and a rule reading them now is a label they never had.
  const conditions = [
    eq(caseLawDecisions.language, language),
    eq(caseLawCitations.kind, CITATION_KIND.PRECEDENT),
    isNotNull(caseLawCitations.polarity),
    ne(caseLawCitations.polarity, POLARITY.NEGATIVE),
    unreviewedCitationSql(caseLawCitations),
  ];
  if (after !== null) {
    conditions.push(
      gt(caseLawCitations.id, brandPersistedCaseLawCitationId(after)),
    );
  }
  const pageSize = Math.min(RECHECK_BATCH, limit - totals.read);
  const page = await scopedDb(
    async (tx) =>
      await tx
        .select({
          id: caseLawCitations.id,
          citationText: caseLawCitations.citationText,
          sectionIndex: caseLawCitations.sectionIndex,
          polarity: caseLawCitations.polarity,
          sections: caseLawDecisions.sections,
          contentHash: caseLawDecisions.contentHash,
          citingDecisionId: caseLawDecisions.id,
        })
        .from(caseLawCitations)
        .innerJoin(
          caseLawDecisions,
          eq(caseLawDecisions.id, caseLawCitations.citingDecisionId),
        )
        .where(and(...conditions))
        .orderBy(asc(caseLawCitations.id))
        .limit(pageSize),
  );
  if (page.length === 0) {
    return { after: null, totals };
  }

  const tightened: Tightened[] = [];
  let noContext = 0;
  for (const citation of page) {
    const windows =
      citation.sections === null
        ? null
        : extractContexts(
            citation.sections,
            citation.citationText,
            citation.sectionIndex,
          );
    if (windows === null) {
      noContext++;
      continue;
    }
    const match = selectCitationPolarity(rules, windows.mentions);
    if (match === null) {
      continue;
    }
    const current = citation.polarity;
    if (current === null || !isValidPolarity(current)) {
      // The query selects labelled rows and the column has a CHECK
      // constraint; a null or a value outside it is a broken row, not a
      // case to skip.
      panic("citation carries a polarity outside the column's values", {
        citationId: citation.id,
        polarity: current,
      });
    }
    if (POLARITY_PRECEDENCE[match.polarity] >= POLARITY_PRECEDENCE[current]) {
      continue;
    }
    tightened.push({
      id: citation.id,
      citingDecisionId: citation.citingDecisionId,
      textRevision: {
        contentHash: citation.contentHash,
        sections: citation.sections,
      },
      polarity: match.polarity,
      ruleId: match.ruleId,
      previousPolarity: current,
      evidenceWindows: windows.evidenceWindows,
      confidence: match.confidence,
      citedPart: classifyCitedPart({
        contexts: windows.contexts,
        citationText: citation.citationText,
        language,
      }),
    });
  }
  const persisted = dryRun
    ? { applied: tightened.length, skipped: 0 }
    : await persistTightened(scopedDb, tightened);

  const last = page.at(-1)?.id ?? after;
  const next = {
    read: totals.read + page.length,
    tightened: totals.tightened + persisted.applied,
    skipped: totals.skipped + persisted.skipped,
    noContext: totals.noContext + noContext,
  };
  if (page.length < pageSize) {
    return { after: null, totals: next };
  }
  if (next.read >= limit) {
    return { after: last, totals: next };
  }
  return await recheckPage({ ...args, after: last, totals: next });
};

/**
 * Walk a language's labelled rows in id order and tighten the label where the
 * rules now read something more severe. Rows already negative are skipped in
 * the query: nothing outranks negative, so the rules cannot move them.
 */
export const recheckCitationPolarity = async (
  options: RecheckOptions,
): Promise<RecheckResult> =>
  await recheckPage({
    ...options,
    totals: { read: 0, tightened: 0, skipped: 0, noContext: 0 },
  });
