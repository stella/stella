/**
 * Scoring for the verification eval: deterministic code over labelled claims
 * and what the engine answered, no judge model.
 *
 * A verdict is right when it is the label's verdict or one the label also
 * accepts. Claims labelled uncertain are scored on their own and never in
 * the headline. A claim the pipeline did not extract, or the grader left
 * unanswered, is wrong and counted as `missed`.
 */
import { CLAIM_STATES } from "@/api/lib/lists/verification/contract";
import type { ClaimState } from "@/api/lib/lists/verification/contract";

import type { ClaimTag, LabelledClaim } from "./avt-verification-set";

/** What the engine said about one labelled claim, in label fact ids. */
export type PredictedGrade = {
  state: ClaimState;
  /** Facts the verdict cites, with how. */
  refs: { factId: string; rel: "supports" | "conflicts" | "record" }[];
  conflict: readonly [string, string] | null;
  qualifiers: string[];
};

export type ClaimOutcome = {
  setId: string;
  caseId: string;
  label: LabelledClaim;
  /** Null when the claim was not extracted or not graded. */
  predicted: PredictedGrade | null;
  /** Why there is no prediction. */
  missedBecause: "not-extracted" | "not-graded" | null;
};

const SCORED: readonly ClaimState[] = ["supported", "tension", "contradicted"];

export const verdictCorrect = (outcome: ClaimOutcome): boolean =>
  outcome.predicted !== null &&
  (outcome.predicted.state === outcome.label.verdict ||
    outcome.label.accepted.includes(outcome.predicted.state));

/** The facts a scored verdict leans on, without context-only citations. */
const leanedOn = (predicted: PredictedGrade): string[] =>
  predicted.refs.filter((ref) => ref.rel !== "record").map((ref) => ref.factId);

type Rate = { hits: number; of: number };
const rate = (hits: number, of: number): Rate => ({ hits, of });

export type VerdictRates = {
  /** Of the claims labelled with this verdict, how many were answered right. */
  recall: Rate;
  /** Of the answers giving this verdict, how many the label accepts. */
  precision: Rate;
};

export type Scorecard = {
  claims: number;
  scored: number;
  uncertain: number;
  /** Verdict right, label or accepted alternative. */
  accuracy: Rate;
  /** Verdict equal to the label's own. */
  strictAccuracy: Rate;
  /** Label verdict by answer (`missed` when there is none). */
  confusion: Record<ClaimState, Record<ClaimState | "missed", number>>;
  perVerdict: Record<ClaimState, VerdictRates>;
  /** Right scored verdicts that cite at least one fact the label names. */
  citationHit: Rate;
  /** Right scored verdicts citing only facts the label names or allows. */
  citationClean: Rate;
  /** Right record conflicts naming the label's two facts. */
  conflictPair: Rate;
  /** Claims a reviewer would not call nocover that came back nocover. */
  falseNoCoverage: Rate;
  /** Claims labelled nocover the engine called anything else. */
  missedNoCoverage: Rate;
  missed: number;
  /** Per qualifier: labelled and found, and given where not labelled. */
  qualifiers: Record<string, { recall: Rate; spurious: number }>;
  byTag: Partial<Record<ClaimTag, Rate>>;
  /** Accuracy on the claims labelled uncertain, never in `accuracy`. */
  uncertainAccuracy: Rate;
};

/** One value per verdict, each built fresh. */
const perState = <T>(
  make: (state: ClaimState) => T,
): Record<ClaimState, T> => ({
  supported: make("supported"),
  tension: make("tension"),
  contradicted: make("contradicted"),
  nocover: make("nocover"),
  notverifiable: make("notverifiable"),
  recordconflict: make("recordconflict"),
});

/** Of the outcomes a metric applies to, how many it counts as a hit. */
const rateOf = (
  outcomes: readonly ClaimOutcome[],
  applies: (outcome: ClaimOutcome) => boolean,
  hit: (outcome: ClaimOutcome) => boolean,
): Rate => {
  const counted = outcomes.filter(applies);
  return rate(counted.filter(hit).length, counted.length);
};

/** Label verdict by answer, `missed` when there is none. */
const confusionOf = (
  outcomes: readonly ClaimOutcome[],
): Scorecard["confusion"] => {
  const confusion = perState(() => ({ ...perState(() => 0), missed: 0 }));
  for (const { label, predicted } of outcomes) {
    confusion[label.verdict][predicted?.state ?? "missed"] += 1;
  }
  return confusion;
};

const perVerdictOf = (
  outcomes: readonly ClaimOutcome[],
): Record<ClaimState, VerdictRates> =>
  perState((state): VerdictRates => ({
    recall: rateOf(
      outcomes,
      ({ label }) => label.verdict === state,
      verdictCorrect,
    ),
    precision: rateOf(
      outcomes,
      ({ predicted }) => predicted?.state === state,
      verdictCorrect,
    ),
  }));

/** A right scored verdict whose label names the facts it should rest on. */
const citationApplies = (outcome: ClaimOutcome): boolean =>
  verdictCorrect(outcome) &&
  outcome.predicted !== null &&
  SCORED.includes(outcome.predicted.state) &&
  outcome.label.cites.length > 0;

const citesExpected = ({ label, predicted }: ClaimOutcome): boolean =>
  predicted !== null &&
  leanedOn(predicted).some((factId) => label.cites.includes(factId));

const citesOnlyAllowed = ({ label, predicted }: ClaimOutcome): boolean =>
  predicted !== null &&
  leanedOn(predicted).every(
    (factId) => label.cites.includes(factId) || label.related.includes(factId),
  );

const namesConflictPair = ({ label, predicted }: ClaimOutcome): boolean => {
  const expected = [...(label.conflict ?? [])].toSorted();
  const answered = [...(predicted?.conflict ?? [])].toSorted();
  return (
    expected.length === answered.length &&
    expected.every((factId, index) => factId === answered[index])
  );
};

const nocoverAllowed = ({ label }: ClaimOutcome): boolean =>
  label.verdict === "nocover" || label.accepted.includes("nocover");

const qualifiersOf = (
  outcomes: readonly ClaimOutcome[],
): Scorecard["qualifiers"] => {
  const kinds = new Set(
    outcomes.flatMap(({ label, predicted }) => [
      ...label.qualifiers,
      ...(predicted?.qualifiers ?? []),
    ]),
  );
  const gives = (outcome: ClaimOutcome, kind: string) =>
    outcome.predicted?.qualifiers.includes(kind) ?? false;
  const labels = (outcome: ClaimOutcome, kind: string): boolean =>
    outcome.label.qualifiers.some((qualifier) => qualifier === kind);
  return Object.fromEntries(
    [...kinds].map((kind) => [
      kind,
      {
        recall: rateOf(
          outcomes,
          (outcome) => labels(outcome, kind),
          (outcome) => gives(outcome, kind),
        ),
        spurious: outcomes.filter(
          (outcome) => !labels(outcome, kind) && gives(outcome, kind),
        ).length,
      },
    ]),
  );
};

const byTagOf = (
  outcomes: readonly ClaimOutcome[],
): Partial<Record<ClaimTag, Rate>> => {
  const byTag: Partial<Record<ClaimTag, Rate>> = {};
  for (const tag of new Set(outcomes.flatMap(({ label }) => label.tags))) {
    byTag[tag] = rateOf(
      outcomes,
      ({ label }) => label.tags.includes(tag),
      verdictCorrect,
    );
  }
  return byTag;
};

export const scoreOutcomes = (outcomes: readonly ClaimOutcome[]): Scorecard => {
  const headline = outcomes.filter((outcome) => !outcome.label.uncertain);
  const uncertain = outcomes.filter((outcome) => outcome.label.uncertain);
  const all = () => true;
  return {
    claims: outcomes.length,
    scored: headline.length,
    uncertain: uncertain.length,
    accuracy: rateOf(headline, all, verdictCorrect),
    strictAccuracy: rateOf(
      headline,
      all,
      ({ label, predicted }) => predicted?.state === label.verdict,
    ),
    confusion: confusionOf(headline),
    perVerdict: perVerdictOf(headline),
    citationHit: rateOf(headline, citationApplies, citesExpected),
    citationClean: rateOf(headline, citationApplies, citesOnlyAllowed),
    conflictPair: rateOf(
      headline,
      (outcome) =>
        verdictCorrect(outcome) &&
        outcome.predicted?.state === "recordconflict" &&
        outcome.label.conflict !== undefined,
      namesConflictPair,
    ),
    falseNoCoverage: rateOf(
      headline,
      (outcome) => !nocoverAllowed(outcome),
      ({ predicted }) => predicted?.state === "nocover",
    ),
    missedNoCoverage: rateOf(
      headline,
      ({ label, predicted }) =>
        label.verdict === "nocover" && predicted !== null,
      (outcome) => !verdictCorrect(outcome),
    ),
    missed: headline.filter(({ predicted }) => predicted === null).length,
    qualifiers: qualifiersOf(headline),
    byTag: byTagOf(headline),
    uncertainAccuracy: rateOf(uncertain, all, verdictCorrect),
  };
};

const percent = ({ hits, of }: Rate): string =>
  of === 0
    ? "n/a"
    : `${((100 * hits) / of).toFixed(1)}% (${String(hits)}/${String(of)})`;

/** The scorecard as Markdown tables. */
export const renderScorecard = (title: string, card: Scorecard): string => {
  const answers = [...CLAIM_STATES, "missed" as const];
  const lines = [
    `### ${title}`,
    "",
    `claims ${String(card.claims)} · scored ${String(card.scored)} · uncertain (not scored) ${String(card.uncertain)} · missed ${String(card.missed)}`,
    "",
    "| metric | value |",
    "| --- | --- |",
    `| accuracy (label or accepted) | ${percent(card.accuracy)} |`,
    `| strict accuracy (label only) | ${percent(card.strictAccuracy)} |`,
    `| citation hit (right scored verdicts) | ${percent(card.citationHit)} |`,
    `| citation clean (no unrelated fact cited) | ${percent(card.citationClean)} |`,
    `| record conflict names the right pair | ${percent(card.conflictPair)} |`,
    `| false "No coverage" | ${percent(card.falseNoCoverage)} |`,
    `| labelled nocover answered otherwise | ${percent(card.missedNoCoverage)} |`,
    `| uncertain claims (reported only) | ${percent(card.uncertainAccuracy)} |`,
    "",
    "| verdict | recall | precision |",
    "| --- | --- | --- |",
    ...CLAIM_STATES.map(
      (state) =>
        `| ${state} | ${percent(card.perVerdict[state].recall)} | ${percent(card.perVerdict[state].precision)} |`,
    ),
    "",
    `| label \\ answer | ${answers.join(" | ")} |`,
    `| --- | ${answers.map(() => "---:").join(" | ")} |`,
    ...CLAIM_STATES.map(
      (label) =>
        `| ${label} | ${answers.map((answer) => String(card.confusion[label][answer])).join(" | ")} |`,
    ),
    "",
    "| qualifier | recall | given where not labelled |",
    "| --- | --- | ---: |",
    ...Object.entries(card.qualifiers).map(
      ([kind, entry]) =>
        `| ${kind} | ${percent(entry.recall)} | ${String(entry.spurious)} |`,
    ),
    "",
    "| tag | accuracy |",
    "| --- | --- |",
    ...Object.entries(card.byTag).map(
      ([tag, tagRate]) => `| ${tag} | ${percent(tagRate)} |`,
    ),
    "",
  ];
  return lines.join("\n");
};
