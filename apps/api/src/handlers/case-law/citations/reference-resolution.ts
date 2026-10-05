/**
 * The resolver's doctrine for one reference, as a function of the decisions
 * that hold its identity.
 *
 * `citation-resolution.ts` applies the same doctrine in SQL, over batches, as
 * the only writer of resolution outcomes; its header explains each rule. This
 * states it over values: given every holder of the reference's identity and
 * the citing decision's jurisdiction, date and language, which decision the
 * reference names, or why none. `reference-resolution.db.test.ts` runs both
 * over one matrix and requires the same outcome, rule and target from each.
 *
 * Every value the database folds or matches by pattern is taken from the
 * database: whether a holder answers to the printed sheet (the ECLI's last
 * segment, or a case-number identifier ending on it), whether it sits at the
 * printed court (both names folded by `courtNameKeySql`), and its decision
 * type as `decisionTypeKeySql` folds it. Those are established where the
 * holder is read, beside the stored values, so a collation that folds
 * differently folds both statements alike. Everything else, from the
 * jurisdiction reach to the rule order, is decided here.
 *
 * No production module calls this; the SQL resolver is the only writer of
 * outcomes, and `reference-resolution.test.ts` keeps it that way.
 */

import {
  CITATION_DECISION_TYPE_HINT_FAMILIES,
  CITATION_DECISION_TYPE_HINTS,
} from "@/api/handlers/case-law/citation-decision-type-hint";
import { citationResolutionPolicyRows } from "@/api/handlers/case-law/citation-jurisdiction-policy";
import {
  CITATION_CANDIDATE_SCAN_CAP,
  CITATION_RESOLUTION_RULE,
  CITATION_RESOLUTION_STATUS,
} from "@/api/handlers/case-law/citation-resolution-status";
import type { CitationResolutionRule } from "@/api/handlers/case-law/citation-resolution-status";
import type { DecisionReferenceHints } from "@/api/handlers/case-law/citations/decision-references";
import type { SafeId } from "@/api/lib/branded-types";

/** A decision holding the reference's identity, as stored. */
export type ReferenceHolder = {
  decisionId: SafeId<"caseLawDecision">;
  /** The holder's country; null reaches no jurisdiction. */
  jurisdiction: string | null;
  /** `YYYY-MM-DD`. */
  decisionDate: string | null;
  court: string | null;
  /**
   * The stored decision type as the lookup folds it for comparison
   * (`decisionTypeKeySql`: the database's `lower()` under the column's
   * collation). Compared as given; never folded again here.
   */
  decisionTypeKey: string | null;
  language: string;
  /** Language manifestations of one judgment share this key. */
  languageGroupKey: string | null;
  /** The holder answers to the sheet the reference printed. */
  answersPrintedSheet: boolean;
  /** The holder sits at the court the reference printed. */
  sitsAtPrintedCourt: boolean;
};

type CitingDecision = {
  decisionId: SafeId<"caseLawDecision">;
  jurisdiction: string;
  /** `YYYY-MM-DD`. */
  decisionDate: string | null;
  language: string;
};

export type ReferenceResolution =
  | {
      status: typeof CITATION_RESOLUTION_STATUS.RESOLVED;
      decisionId: SafeId<"caseLawDecision">;
      rule: CitationResolutionRule;
    }
  | { status: typeof CITATION_RESOLUTION_STATUS.AMBIGUOUS }
  | {
      status: typeof CITATION_RESOLUTION_STATUS.UNMATCHED;
      /**
       * A holder passed every filter but the citing jurisdiction's reach:
       * the cross-border measurement the walk reports.
       */
      jurisdictionBlocked: boolean;
    };

/**
 * What resolution reads of a reference. The type hint is any stored spelling:
 * one outside the vocabulary names no family, as in the resolver's join.
 */
export type ResolvableReference = {
  citationKey: string | null;
  hints: Omit<DecisionReferenceHints, "decisionType"> & {
    decisionType: string | null;
  };
};

type ResolveDecisionReferenceOptions = {
  citing: CitingDecision;
  reference: ResolvableReference;
  /** Every holder of the reference's identity, in any order. */
  holders: readonly ReferenceHolder[];
};

/** Code-unit order, as the resolver compares uuids and language codes. */
const byCodeUnit = (a: string, b: string): number => {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
};

const workKey = (holder: ReferenceHolder): string =>
  holder.languageGroupKey === null
    ? `decision:${holder.decisionId}`
    : `group:${holder.languageGroupKey}`;

/** Ascending, with the citing language first. */
const compareManifestations =
  (citingLanguage: string) =>
  (a: ReferenceHolder, b: ReferenceHolder): number => {
    const preferred =
      Number(b.language === citingLanguage) -
      Number(a.language === citingLanguage);
    if (preferred !== 0) {
      return preferred;
    }
    return (
      byCodeUnit(a.language, b.language) ||
      byCodeUnit(a.decisionId, b.decisionId)
    );
  };

/**
 * One holder per judgment, the manifestation in the citing language where
 * there is one, and at most the scan cap of them. Which judgments the cap
 * keeps never changes an outcome: at the cap every rule is withheld.
 */
const candidatesOf = (
  holders: readonly ReferenceHolder[],
  citingLanguage: string,
): ReferenceHolder[] => {
  const judgments = new Map<string, ReferenceHolder>();
  const compare = compareManifestations(citingLanguage);
  for (const holder of holders) {
    const key = workKey(holder);
    const kept = judgments.get(key);
    if (kept === undefined || compare(holder, kept) < 0) {
      judgments.set(key, holder);
    }
  }
  return [...judgments]
    .toSorted(([a], [b]) => byCodeUnit(a, b))
    .slice(0, CITATION_CANDIDATE_SCAN_CAP)
    .map(([, holder]) => holder);
};

const typeIn =
  (types: readonly string[]) =>
  (holder: ReferenceHolder): boolean =>
    holder.decisionTypeKey !== null && types.includes(holder.decisionTypeKey);

/** The holder a filter left, when it left exactly one. */
const onlyOf = (
  matched: readonly ReferenceHolder[],
): ReferenceHolder | undefined =>
  matched.length === 1 ? matched[0] : undefined;

const resolvedTo = (
  holder: ReferenceHolder,
  rule: CitationResolutionRule,
): ReferenceResolution => ({
  status: CITATION_RESOLUTION_STATUS.RESOLVED,
  decisionId: holder.decisionId,
  rule,
});

/**
 * The outcome for one reference, or null where the resolver leaves it
 * pending: a printed form that does not canonicalize, or a citing
 * jurisdiction with no declared reach.
 */
export const resolveDecisionReference = ({
  citing,
  reference: { citationKey, hints },
  holders,
}: ResolveDecisionReferenceOptions): ReferenceResolution | null => {
  if (citationKey === null) {
    return null;
  }
  const reach = citationResolutionPolicyRows().find(
    (policy) => policy.jurisdiction === citing.jurisdiction,
  )?.resolvesTo;
  if (reach === undefined) {
    return null;
  }
  const reachable = new Set<string>(reach);

  const eligible = holders.filter(
    (holder) =>
      holder.decisionId !== citing.decisionId &&
      (holder.decisionDate === null ||
        citing.decisionDate === null ||
        citing.decisionDate >= holder.decisionDate),
  );
  const candidates = candidatesOf(
    eligible.filter(
      (holder) =>
        holder.jurisdiction !== null && reachable.has(holder.jurisdiction),
    ),
    citing.language,
  );
  const n = candidates.length;
  const bounded = n > 1 && n < CITATION_CANDIDATE_SCAN_CAP;

  const hint = CITATION_DECISION_TYPE_HINTS.find(
    (known) => known === hints.decisionType,
  );
  const family =
    hint === undefined ? undefined : CITATION_DECISION_TYPE_HINT_FAMILIES[hint];
  const compatible = candidates.filter(
    (holder) =>
      (hints.sheetNumber === null || holder.answersPrintedSheet) &&
      (hints.decisionDate === null ||
        holder.decisionDate === hints.decisionDate) &&
      (hints.decisionType === null ||
        (family !== undefined && typeIn(family)(holder))) &&
      (hints.court === null || holder.sitsAtPrintedCourt),
  );
  const unique = onlyOf(compatible);
  if (unique !== undefined && n === 1) {
    return resolvedTo(unique, CITATION_RESOLUTION_RULE.UNIQUE_KEY);
  }
  if (unique !== undefined && bounded) {
    if (
      hints.sheetNumber !== null &&
      candidates.filter((holder) => holder.answersPrintedSheet).length === 1
    ) {
      return resolvedTo(unique, CITATION_RESOLUTION_RULE.SHEET_NUMBER);
    }
    if (
      hints.decisionDate !== null &&
      candidates.filter((holder) => holder.decisionDate === hints.decisionDate)
        .length === 1
    ) {
      return resolvedTo(unique, CITATION_RESOLUTION_RULE.DECISION_DATE);
    }
    if (
      family !== undefined &&
      candidates.filter(typeIn(family)).length === 1
    ) {
      return resolvedTo(unique, CITATION_RESOLUTION_RULE.TYPE_HINT);
    }
    if (
      hints.court !== null &&
      candidates.filter((holder) => holder.sitsAtPrintedCourt).length === 1
    ) {
      return resolvedTo(unique, CITATION_RESOLUTION_RULE.COURT_HINT);
    }
  }
  if (n > 0 && compatible.length === 0) {
    return { status: CITATION_RESOLUTION_STATUS.AMBIGUOUS };
  }
  if (n > 1) {
    return { status: CITATION_RESOLUTION_STATUS.AMBIGUOUS };
  }
  return {
    status: CITATION_RESOLUTION_STATUS.UNMATCHED,
    jurisdictionBlocked: eligible.some(
      (holder) =>
        holder.jurisdiction !== null && !reachable.has(holder.jurisdiction),
    ),
  };
};
