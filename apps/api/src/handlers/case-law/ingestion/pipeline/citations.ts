import { panic } from "better-result";
import { sql } from "drizzle-orm";
import type { PgInsertValue } from "drizzle-orm/pg-core";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawCitations, caseLawPolarityRules } from "@/api/db/schema";
import { CITATION_KIND } from "@/api/handlers/case-law/citation-kind";
import type { ProceduralKeys } from "@/api/handlers/case-law/citation-kind";
import {
  classifyCitationsBeforeWrite,
  resolveCitationsForDecision,
} from "@/api/handlers/case-law/citation-resolution";
import { deriveDecisionReferences } from "@/api/handlers/case-law/citations/decision-references";
import type { DecisionReference } from "@/api/handlers/case-law/citations/decision-references";
import type { extractCitations } from "@/api/handlers/case-law/ingestion/citation-extractor";
import { applyCitationReviews } from "@/api/handlers/case-law/polarity/reviews";
import {
  ACTIVE_RULE_SOURCES,
  loadRules,
  selectCitationPolarity,
} from "@/api/handlers/case-law/polarity/rule-engine";
import type {
  CitationPolarityVerdict,
  RuleCache,
} from "@/api/handlers/case-law/polarity/rule-engine";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { brandPersistedCaseLawCitationId } from "@/api/lib/safe-id-boundaries";
import { isRecord } from "@/api/lib/type-guards";

type PlanDecisionCitationsOptions = {
  citations: readonly ReturnType<typeof extractCitations>[number][];
  citingDecisionId: SafeId<"caseLawDecision">;
  /** The citing decision's language; it chooses the polarity rule set. */
  language: string;
  polarityRules: RuleCache | undefined;
  proceduralKeys: ProceduralKeys;
  scopedDb: ScopedDb;
  sections: { index: number; text: string }[];
};

/** One reference and the rule tier's reading of its treatment. */
type ReadReference = {
  reference: DecisionReference;
  verdict: CitationPolarityVerdict | null;
};

/** A decision's references as the writer publishes them. */
type DecisionCitations = {
  citingDecisionId: SafeId<"caseLawDecision">;
  references: readonly ReadReference[];
};

/**
 * Every reference of one decision (see `deriveDecisionReferences`: what each
 * names and what it is doing) and, where it invokes authority, how the citing
 * court treats it.
 *
 * Both are read off the surrounding text, which only the pipeline holds, and
 * both are written when the row is published. Polarity used to be left to the
 * background classifier, which the refresh path then undid: refreshing a
 * decision deletes its citation rows and re-inserts them, so a label written
 * after the insert survived only until the next refresh.
 *
 * Regex tier only. A procedural citation is skipped, and so is a context no
 * rule reads: `polarity` stays null, which is what the background queue
 * selects on and what an unexamined row looks like. There is no "examined,
 * matched nothing" value, and inventing one here would empty that queue
 * without classifying anything.
 *
 * Every mention of the cited decision is read, not the first: see
 * `selectCitationPolarity` for how the readings become one label.
 *
 * Cost: one rules read per language per pipeline run where the caller owns a
 * cache, one per decision otherwise, and none at all for a decision that
 * cites nothing. Never one per citation.
 */
export const planDecisionCitations = async ({
  citations,
  citingDecisionId,
  language,
  polarityRules,
  proceduralKeys,
  scopedDb,
  sections,
}: PlanDecisionCitationsOptions): Promise<DecisionCitations> => {
  const { references } = deriveDecisionReferences({
    citingDecisionId,
    citations,
    proceduralKeys,
    sections,
  });
  if (references.length === 0) {
    return { citingDecisionId, references: [] };
  }
  const rules = await loadRules(language, scopedDb, polarityRules);
  return {
    citingDecisionId,
    references: references.map((reference) => ({
      reference,
      verdict:
        reference.polarityMentions === null
          ? null
          : selectCitationPolarity(rules, reference.polarityMentions),
    })),
  };
};

type CitationRow = typeof caseLawCitations.$inferInsert;

/** The row a reference is stored as, before it is settled. */
const citationRowOf = (
  citingDecisionId: SafeId<"caseLawDecision">,
  { reference, verdict }: ReadReference,
): CitationRow => {
  const [identifier] = reference.identifiers;
  return {
    citingDecisionId,
    citationText: reference.printed,
    citationKey: reference.citationKey,
    identifierType: identifier.type,
    normalizedIdentifierValue: identifier.normalizedValue,
    citedDecisionTypeHint: reference.hints.decisionType,
    citedCourtHint: reference.hints.court,
    citedSheetNumber: reference.hints.sheetNumber,
    citedDecisionDate: reference.hints.decisionDate,
    kind: reference.kind,
    sectionIndex: reference.sectionIndex,
    polarity: verdict?.polarity ?? null,
    polarityRuleId: verdict?.ruleId ?? null,
  };
};

/**
 * The rows a decision's references are stored as, before they are settled:
 * the whole of what the storage keeps of a reference and its rule verdict.
 */
export const citationRowsOf = ({
  citingDecisionId,
  references,
}: DecisionCitations): CitationRow[] =>
  references.map((reference) => citationRowOf(citingDecisionId, reference));

/** Rows from `execute` under either driver shape (bare array or `{ rows }`). */
const executedRows = (result: unknown): unknown[] => {
  if (Array.isArray(result)) {
    return result;
  }
  if (isRecord(result) && Array.isArray(result["rows"])) {
    return result["rows"];
  }
  return [];
};

/** Each rule that labelled one of these citations, and how many it labelled. */
const polarityMatchesByRule = (
  rows: readonly CitationRow[],
): Map<string, number> => {
  const matches = new Map<string, number>();
  for (const { polarityRuleId } of rows) {
    if (polarityRuleId) {
      matches.set(polarityRuleId, (matches.get(polarityRuleId) ?? 0) + 1);
    }
  }
  return matches;
};

/**
 * Settle this decision's polarity verdicts against the rules as they stand
 * now, and count the matches against those rules.
 *
 * The compiled rules a verdict came from were read before this transaction
 * opened, and a cache holds them for the rest of the crawl cycle. Meanwhile
 * `seed-polarity-rules.ts` retires a rule and returns every citation it
 * labelled to the unclassified pool; the maintenance lane serializes operator
 * passes against each other, not against a crawl in flight. A verdict from a
 * rule retired in that window would be published after the sweep that was
 * meant to erase it, and nothing would ever revisit it: the drain and
 * `classify-citations.ts` both select on `polarity IS NULL`. So the writer
 * asks, inside the transaction that publishes the rows, whether the rule is
 * still one the loader would compile, and drops the verdict when it is not.
 *
 * The statement is an UPDATE rather than a read, which is what orders the two
 * passes: it takes a row lock on each rule it confirms, so a retirement
 * racing this decision waits for the commit and its sweep then sees the rows.
 * The rule ids are sorted so two ingest transactions confirming the same
 * rules walk them in one order.
 *
 * Counting rides along because the count has to happen somewhere: a row
 * published with a verdict never reaches `classify-citations.ts`, which is
 * what used to move `match_count`, so without this the column would stop
 * reporting how much work a rule does — the one thing it is for.
 */
const settleRuleVerdicts = async (
  tx: Transaction,
  rows: readonly CitationRow[],
  observedAt: Date,
): Promise<CitationRow[]> => {
  // audit: skip — background polarity rule match counters; public case-law data
  const matches = polarityMatchesByRule(rows);
  if (matches.size === 0) {
    return [...rows];
  }
  const tally = [...matches].toSorted(([a], [b]) => (a < b ? -1 : 1));
  const confirmed: unknown = await tx.execute(sql`
    UPDATE ${caseLawPolarityRules} AS r
       SET match_count = r.match_count + m.matches,
           updated_at = GREATEST(r.updated_at, ${observedAt})
      FROM (VALUES ${sql.join(
        tally.map(([ruleId, count]) => sql`(${ruleId}::uuid, ${count}::int)`),
        sql.raw(","),
      )}) AS m(id, matches)
     WHERE r.id = m.id
       AND r.source IN (${sql.join(
         ACTIVE_RULE_SOURCES.map((source) => sql`${source}`),
         sql.raw(","),
       )})
    RETURNING r.id::text AS id
  `);
  const active = new Set(
    executedRows(confirmed).flatMap((row) =>
      isRecord(row) && typeof row["id"] === "string" ? [row["id"]] : [],
    ),
  );
  return rows.map((row) =>
    row.polarityRuleId && !active.has(row.polarityRuleId)
      ? { ...row, polarity: null, polarityRuleId: null }
      : row,
  );
};

const textOrNull = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

/**
 * The columns of a citation row that the document and the rules decide. Two
 * rows equal on these are the same citation, whatever the resolver has since
 * made of either.
 */
const citationContent = (row: {
  citationText: string;
  citationKey?: string | null | undefined;
  identifierType?: string | null | undefined;
  normalizedIdentifierValue?: string | null | undefined;
  citedDecisionTypeHint?: string | null | undefined;
  citedCourtHint?: string | null | undefined;
  citedSheetNumber?: string | null | undefined;
  citedDecisionDate?: string | null | undefined;
  kind?: string | undefined;
  sectionIndex?: number | null | undefined;
  polarity?: string | null | undefined;
  polarityRuleId?: string | null | undefined;
}): string =>
  JSON.stringify([
    row.citationText,
    row.citationKey ?? null,
    row.identifierType ?? null,
    row.normalizedIdentifierValue ?? null,
    row.citedDecisionTypeHint ?? null,
    row.citedCourtHint ?? null,
    row.citedSheetNumber ?? null,
    row.citedDecisionDate ?? null,
    row.kind ?? CITATION_KIND.PRECEDENT,
    row.sectionIndex ?? null,
    row.polarity ?? null,
    row.polarityRuleId ?? null,
  ]);

/**
 * Make a decision's citation rows say what its document now says, touching
 * only the rows that differ.
 *
 * A refresh usually carries the document it carried last time, and its
 * citations are then the rows already stored: deleting and re-inserting them
 * would write every row twice and throw away the resolver's answers, which
 * the insert then had to recompute with an update per row. So stored rows are
 * matched to incoming ones by content, as a multiset: a match is kept as it
 * is, a stored row nothing matches is deleted, and only an incoming row
 * nothing matches is written.
 *
 * Reviews are applied before the comparison, not after it. A reviewed row is
 * stored with the review's polarity and no rule, so the incoming row it is
 * compared with has to carry the same, or an unchanged document would read as
 * a changed one and rewrite the row on every refresh. The rule verdicts are
 * then settled for the written rows only, and a reviewed row carries no rule,
 * so a rule neither labels it nor counts it as a match.
 *
 * A written row is settled before it is inserted, by the resolver's own
 * doctrine, so it goes in once with its outcome. A kept row keeps its outcome:
 * whatever changes the answer for it (a decision arriving under its key, this
 * decision's identity moving) reopens it through the paths that exist for
 * that, and those are settled here too, as before.
 *
 * Runs under the citation-graph lock, which the caller takes first.
 */
export const writeDecisionCitations = async (
  tx: Transaction,
  {
    decisionId,
    citations,
    observedAt,
    stored,
  }: {
    decisionId: SafeId<"caseLawDecision">;
    citations: DecisionCitations;
    observedAt: Date;
    /** Whether the decision may already hold citation rows. */
    stored: boolean;
  },
): Promise<void> => {
  const rows = citationRowsOf(citations);
  const unmatched = new Map<string, SafeId<"caseLawCitation">[]>();
  if (stored) {
    // Read as text, so the comparison sees the values as the writer spells
    // them rather than as a driver chose to parse a date or a number.
    const storedRows = executedRows(
      await tx.execute(sql`
        SELECT id::text AS id,
               citation_text,
               citation_key,
               identifier_type,
               normalized_identifier_value,
               cited_decision_type_hint,
               cited_court_hint,
               cited_sheet_number,
               cited_decision_date::text AS cited_decision_date,
               kind,
               section_index,
               polarity,
               polarity_rule_id::text AS polarity_rule_id
          FROM ${caseLawCitations}
         WHERE citing_decision_id = ${decisionId}::uuid
      `),
    );
    for (const row of storedRows) {
      if (!isRecord(row) || typeof row["id"] !== "string") {
        return panic("stored citation row has no id");
      }
      const key = citationContent({
        citationText: textOrNull(row["citation_text"]) ?? "",
        citationKey: textOrNull(row["citation_key"]),
        identifierType: textOrNull(row["identifier_type"]),
        normalizedIdentifierValue: textOrNull(
          row["normalized_identifier_value"],
        ),
        citedDecisionTypeHint: textOrNull(row["cited_decision_type_hint"]),
        citedCourtHint: textOrNull(row["cited_court_hint"]),
        citedSheetNumber: textOrNull(row["cited_sheet_number"]),
        citedDecisionDate: textOrNull(row["cited_decision_date"]),
        kind: textOrNull(row["kind"]) ?? CITATION_KIND.PRECEDENT,
        sectionIndex:
          row["section_index"] === null || row["section_index"] === undefined
            ? null
            : Number(row["section_index"]),
        polarity: textOrNull(row["polarity"]),
        polarityRuleId: textOrNull(row["polarity_rule_id"]),
      });
      const id = brandPersistedCaseLawCitationId(row["id"]);
      const ids = unmatched.get(key);
      if (ids === undefined) {
        unmatched.set(key, [id]);
      } else {
        ids.push(id);
      }
    }
  }

  const incoming: CitationRow[] = [];
  let kept = 0;
  for (const row of await applyCitationReviews(tx, rows)) {
    const matches = unmatched.get(citationContent(row));
    if (matches !== undefined && matches.length > 0) {
      matches.pop();
      kept += 1;
    } else {
      incoming.push(row);
    }
  }

  // audit: skip — derived citation graph of public case law, not a user action
  const removed = [...unmatched.values()].flat();
  if (removed.length > 0) {
    // One jsonb parameter, so the statement text does not grow with the
    // number of rows removed.
    await tx
      .delete(caseLawCitations)
      .where(
        sql`${caseLawCitations.id} IN (SELECT jsonb_array_elements_text(${JSON.stringify(removed)}::text::jsonb)::uuid)`,
      );
  }

  if (incoming.length > 0) {
    const written: (CitationRow & { id: SafeId<"caseLawCitation"> })[] = [];
    for (const row of await settleRuleVerdicts(tx, incoming, observedAt)) {
      written.push({ ...row, id: createSafeId<"caseLawCitation">() });
    }
    const resolutions = await classifyCitationsBeforeWrite(tx, {
      citingDecisionId: decisionId,
      citations: written.map((row) => ({
        id: row.id,
        citationKey: row.citationKey ?? null,
        identifierType: row.identifierType ?? null,
        normalizedIdentifierValue: row.normalizedIdentifierValue ?? null,
        citedDecisionTypeHint: row.citedDecisionTypeHint ?? null,
        citedCourtHint: row.citedCourtHint ?? null,
        citedSheetNumber: row.citedSheetNumber ?? null,
        citedDecisionDate: row.citedDecisionDate ?? null,
      })),
    });
    const settled: PgInsertValue<typeof caseLawCitations>[] = [];
    for (const row of written) {
      const resolution = resolutions.get(row.id);
      settled.push(
        resolution === undefined
          ? row
          : { ...row, ...resolution, resolutionAttemptedAt: sql`now()` },
      );
    }
    // audit: skip — derived citation graph of public case law, not a user action
    await tx.insert(caseLawCitations).values(settled);
  }

  // A kept row can be pending: this decision's identity moved and its own
  // citations were reopened above, or an arrival elsewhere reopened them.
  // Settle those in the transaction too, as the walk would.
  if (kept > 0) {
    await resolveCitationsForDecision(tx, decisionId);
  }
};
