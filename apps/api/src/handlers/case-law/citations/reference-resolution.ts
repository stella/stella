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
 * Two facts compare a printed hint with stored values by pattern: whether a
 * holder answers to the printed sheet (the ECLI's last segment, or a
 * case-number identifier ending on it) and whether it sits at the printed
 * court (both names folded by `courtNameKeySql`). Those are established where
 * the holder is read, beside the stored values, and a holder carries the
 * answers. Everything else, from the jurisdiction reach to the rule order, is
 * decided here.
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
  MERITS_DECISION_TYPES,
  PROCEDURAL_DECISION_TYPES,
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
  decisionType: string | null;
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
    holder.decisionType !== null &&
    types.includes(holder.decisionType.toLowerCase());

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
  const sheet = candidates.filter(
    (holder) => hints.sheetNumber !== null && holder.answersPrintedSheet,
  );
  const dated = candidates.filter(
    (holder) =>
      hints.decisionDate !== null && holder.decisionDate === hints.decisionDate,
  );
  const typed = candidates.filter(
    (holder) => family !== undefined && typeIn(family)(holder),
  );
  const seated = candidates.filter(
    (holder) => hints.court !== null && holder.sitsAtPrintedCourt,
  );
  const merits = candidates.filter(typeIn(MERITS_DECISION_TYPES));
  const procedural = candidates.filter(typeIn(PROCEDURAL_DECISION_TYPES));
  const courts = new Set(
    candidates.flatMap((holder) =>
      holder.court === null ? [] : [holder.court],
    ),
  );

  const unique = onlyOf(candidates);
  if (unique !== undefined) {
    return resolvedTo(unique, CITATION_RESOLUTION_RULE.UNIQUE_KEY);
  }
  const bySheet = bounded ? onlyOf(sheet) : undefined;
  if (bySheet !== undefined) {
    return resolvedTo(bySheet, CITATION_RESOLUTION_RULE.SHEET_NUMBER);
  }
  const byDate = bounded ? onlyOf(dated) : undefined;
  if (byDate !== undefined) {
    return resolvedTo(byDate, CITATION_RESOLUTION_RULE.DECISION_DATE);
  }
  // The sheet or the date narrowed the file to several decisions; a word
  // that picked one of them would contradict the identity the text printed.
  if (sheet.length > 1 || dated.length > 1) {
    return { status: CITATION_RESOLUTION_STATUS.AMBIGUOUS };
  }
  const byType = bounded ? onlyOf(typed) : undefined;
  if (byType !== undefined) {
    return resolvedTo(byType, CITATION_RESOLUTION_RULE.TYPE_HINT);
  }
  const byCourt = bounded ? onlyOf(seated) : undefined;
  if (byCourt !== undefined) {
    return resolvedTo(byCourt, CITATION_RESOLUTION_RULE.COURT_HINT);
  }
  const merit = onlyOf(merits);
  if (
    bounded &&
    merit !== undefined &&
    typed.length <= 1 &&
    courts.size === 1 &&
    procedural.length === n - 1
  ) {
    return resolvedTo(merit, CITATION_RESOLUTION_RULE.ONE_FILE_MERITS);
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
