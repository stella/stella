/**
 * Whether a claim's grade still stands on its list as the list is now. The
 * one owner of that question: the run read, the re-check of every claim out
 * of date and the browser's filter all read what this says.
 *
 * A grade pins the facts it read by value (the run's facts, or a re-check's
 * facts as their difference from the run's). Comparing the facts the grade
 * cites with how they read on the list now says whether it is **outdated**:
 * a cited fact was edited (its text, details or sources), held out of
 * scoring, or taken off the list. A fact on the list now that the grade
 * never read, and that bears on the claim, says the claim is **possibly
 * affected** by new evidence. Derived on every read, never stored; a
 * re-check pins the list as it stands, so it clears both.
 *
 * Relevance calls no model: a new fact bears on a claim when a reviewer
 * linked it to the claim, when it shares a source document with a fact the
 * grade cites, or when its words overlap the claim's (`wordOverlap`).
 */

import { panic } from "better-result";

import { stableStringify } from "@stll/stable-stringify";

import type { SafeId } from "@/api/lib/branded-types";
import { claimWords } from "@/api/lib/lists/verification/claim-match";
import type {
  ClaimRef,
  RecordConflict,
  VerificationEvidenceFact,
} from "@/api/lib/lists/verification/contract";

/** Why a claim's grade may no longer stand. Closed: the reader names each. */
export const STALENESS_REASON_KINDS = [
  "fact-changed",
  "fact-removed",
  "fact-held",
  "new-fact-related",
] as const;
type StalenessReasonKind = (typeof STALENESS_REASON_KINDS)[number];

/** One reason, with the fact it is about and that fact's words: as the list
 *  holds it now, or as the grade read it once the list no longer scores it. */
export type StalenessReason = {
  kind: StalenessReasonKind;
  factEntityId: SafeId<"entity">;
  text: string;
};

/** Words of at least this many letters carry meaning in every list language
 *  the product ships; shorter ones are articles, prepositions and pronouns.
 *  A word with a digit (a day, a sum, a reference) counts too, except a
 *  bare year: most claims and facts of one matter name the same few. */
const CONTENT_WORD_MIN_LETTERS = 5;
const BARE_YEAR = /^(?:19|20)\d{2}$/u;
/** Content words a new fact must share with a claim to bear on it. */
const RELATED_SHARED_WORDS_MIN = 2;
/** Shared content words over the shorter side's: the share of the shorter
 *  text the other one repeats. Measured on the sample case: 0.4 pairs each
 *  claim with the facts on its own point and with no other. */
const RELATED_OVERLAP_MIN = 0.4;
/** New facts named per claim, the strongest first; the claim is out of date
 *  with the first one already. */
export const NEW_FACT_REASONS_MAX = 3;

const DIGIT = /\p{N}/u;

/** The words of a text that tell one point from another. */
const contentWords = (text: string): ReadonlySet<string> =>
  new Set(
    claimWords(text).filter((word) =>
      DIGIT.test(word)
        ? !BARE_YEAR.test(word)
        : word.length >= CONTENT_WORD_MIN_LETTERS,
    ),
  );

/**
 * How strongly two texts share a point: the share of the shorter side's
 * content words the other repeats, or 0 below the shared-word floor.
 */
const wordOverlap = (
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): number => {
  let shared = 0;
  for (const word of left) {
    if (right.has(word)) {
      shared += 1;
    }
  }
  return shared < RELATED_SHARED_WORDS_MIN
    ? 0
    : shared / Math.min(left.size, right.size);
};

/** A fact as the grader reads it: a renamed source document changes no fact,
 *  so the name it carries for display is left out. */
const factReading = (fact: VerificationEvidenceFact): string =>
  stableStringify({
    ...fact,
    sources: fact.sources.map(
      ({ sourceName: _forDisplay, ...source }) => source,
    ),
  });

type ListFact = {
  fact: VerificationEvidenceFact;
  reading: string;
  words: ReadonlySet<string>;
  sourceIds: ReadonlySet<SafeId<"entity">>;
};

/** The list as it stands now, read once and shared by every claim. */
export type ListFactsNow = {
  /** Facts checked against now, in list order. */
  scored: readonly ListFact[];
  scoredById: ReadonlyMap<SafeId<"entity">, ListFact>;
  /** Facts on the list held out of scoring. */
  held: ReadonlySet<SafeId<"entity">>;
};

export const listFactsNow = ({
  scored,
  held,
}: {
  scored: readonly VerificationEvidenceFact[];
  held: Iterable<SafeId<"entity">>;
}): ListFactsNow => {
  const facts = scored.map((fact): ListFact => ({
    fact,
    reading: factReading(fact),
    words: contentWords(fact.text),
    sourceIds: new Set(fact.sources.map((source) => source.sourceEntityId)),
  }));
  return {
    scored: facts,
    scoredById: new Map(facts.map((entry) => [entry.fact.factEntityId, entry])),
    held: new Set(held),
  };
};

/** The facts a grade read, keyed for lookup. */
export type GradePins = {
  facts: ReadonlyMap<SafeId<"entity">, VerificationEvidenceFact>;
};

export const gradePins = (
  facts: readonly VerificationEvidenceFact[],
): GradePins => ({
  facts: new Map(facts.map((fact) => [fact.factEntityId, fact])),
});

type CitingGrade = {
  refs: readonly ClaimRef[];
  recordConflict: RecordConflict | null;
};

/** Every fact a grade names: those it rests on or conflicts with, and the
 *  two records of a conflict it withholds a verdict between. */
export const citedFactIds = (grade: CitingGrade): SafeId<"entity">[] => [
  ...new Set([
    ...grade.refs.map((ref) => ref.factEntityId),
    ...(grade.recordConflict === null
      ? []
      : grade.recordConflict.factEntityIds),
  ]),
];

export type StalenessTarget = {
  /** The claim's words, which a new fact's words are measured against. */
  text: string;
  /** The grade the claim is read with (`gradeOf`). */
  grade: CitingGrade;
  /** The facts that grade read. */
  pins: GradePins;
  /** Facts a reviewer points the claim at now. */
  linkedFactIds: readonly SafeId<"entity">[];
  /** False for a claim set aside as not verifiable: it is checked again
   *  only once reopened, so nothing on the list makes it out of date. */
  recheckable: boolean;
};

/** Why a cited fact no longer reads as the grade read it; null while it
 *  does. */
const citedReason = (
  factEntityId: SafeId<"entity">,
  pinned: VerificationEvidenceFact,
  now: ListFactsNow,
): StalenessReason | null => {
  const current = now.scoredById.get(factEntityId);
  if (current !== undefined) {
    return current.reading === factReading(pinned)
      ? null
      : { kind: "fact-changed", factEntityId, text: current.fact.text };
  }
  return {
    kind: now.held.has(factEntityId) ? "fact-held" : "fact-removed",
    factEntityId,
    text: pinned.text,
  };
};

/** How strongly a fact the grade never read bears on the claim: 1 for a
 *  link or a shared source document, the word overlap otherwise, 0 when it
 *  does not bear on it. */
const relevance = (
  fact: ListFact,
  claimWordSet: ReadonlySet<string>,
  linked: ReadonlySet<SafeId<"entity">>,
  citedSourceIds: ReadonlySet<SafeId<"entity">>,
): number => {
  if (linked.has(fact.fact.factEntityId)) {
    return 1;
  }
  for (const sourceId of fact.sourceIds) {
    if (citedSourceIds.has(sourceId)) {
      return 1;
    }
  }
  const overlap = wordOverlap(claimWordSet, fact.words);
  return overlap >= RELATED_OVERLAP_MIN ? overlap : 0;
};

/**
 * Every reason the claim's grade may no longer stand, empty when it stands:
 * first each cited fact that changed, in the order the grade cites them,
 * then up to `NEW_FACT_REASONS_MAX` facts the grade never read that bear on
 * the claim, the strongest first and list order among equals.
 */
export const claimStaleness = (
  target: StalenessTarget,
  now: ListFactsNow,
): StalenessReason[] => {
  if (!target.recheckable) {
    return [];
  }
  // Each cited fact as the grade read it.
  const cited = citedFactIds(target.grade).map(
    (factEntityId) =>
      [
        factEntityId,
        target.pins.facts.get(factEntityId) ??
          panic("A grade cites a fact it did not read"),
      ] as const,
  );
  const changed = cited.flatMap(([factEntityId, pinned]) => {
    const reason = citedReason(factEntityId, pinned, now);
    return reason === null ? [] : [reason];
  });

  const citedSourceIds = new Set(
    cited.flatMap(([, pinned]) =>
      pinned.sources.map((source) => source.sourceEntityId),
    ),
  );
  const linked = new Set(target.linkedFactIds);
  const claimWordSet = contentWords(target.text);
  const related = now.scored
    .filter((fact) => !target.pins.facts.has(fact.fact.factEntityId))
    .map((fact, order) => ({
      fact,
      order,
      strength: relevance(fact, claimWordSet, linked, citedSourceIds),
    }))
    .filter(({ strength }) => strength > 0)
    .toSorted((a, b) => b.strength - a.strength || a.order - b.order)
    .slice(0, NEW_FACT_REASONS_MAX)
    .map(({ fact }): StalenessReason => ({
      kind: "new-fact-related",
      factEntityId: fact.fact.factEntityId,
      text: fact.fact.text,
    }));
  return [...changed, ...related];
};
