/**
 * Whether a cluster is an order, an opinion, or neither provably.
 *
 * Orders are decisions: a short certiorari or rehearing disposition is kept
 * as `order`, never rejected for its length. Order rules run first, so a
 * separate dissent or concurrence cannot turn a classified order into an
 * opinion. Signals that conflict or do not suffice leave the decision
 * `unclassified` rather than guessed.
 */

import { stripDangerousChars } from "@stll/legal-ast/text-sanitize";

import { OPINION_TYPES, type OpinionType } from "./vocabulary";

const ORDER_CLASSIFIER_VERSION = 1;

/** A principal body at most this long may be an order by its wording. */
export const SHORT_ORDER_MAX_CHARACTERS = 500;

/**
 * What the parsed document says about the principal text: the root document
 * without caption, apparatus and separate opinions. `unavailable` until a
 * text parser has read it; the order rules cannot be evaluated without it.
 */
export type PrincipalTextEvidence =
  | { readonly status: "unavailable" }
  | {
      readonly status: "parsed";
      /** An explicit order heading on the root document, not a quoted one. */
      readonly orderHeading: boolean;
      readonly body: string;
      /** The publisher's structure marks the principal text as an opinion. */
      readonly structuralOpinion: boolean;
      /** Exactly one opinion body was proven, with no unsplit remainder. */
      readonly singleOpinionBody: boolean;
    };

// Patterns read the normalized body, whose whitespace is single spaces. They
// are case-sensitive: a court designation is told from prose by its
// capitalized abbreviations. Tails exclude quotation marks, so a quoted order
// never completes a pattern.
const TAIL = '[^"“”]{1,300}?';

/**
 * The court below, printed before a disposition in abbreviations only
 * (`C. A. 9th Cir.`, `Sup. Ct. Cal.;`, `Ct. App. Tex., 2d Dist.`).
 */
const COURT_BELOW =
  "(?:(?:[A-Z][a-z]{0,6}\\.|[A-Z]{1,4}\\.?|\\d{1,2}(?:st|nd|rd|th|d)|and)[;,]? ){1,24}";

const JUSTICES = `(?:The Chief Justice|Justices? [A-Z]${TAIL})`;

/** Complete sentences an order consists of, each without its final period. */
const ORDER_PATTERNS = {
  "certiorari-petition": `(?:The )?[Pp]etition for (?:a )?writ of certiorari(?: to ${TAIL})? (?:is )?(?:granted|denied)`,
  "certiorari-disposition": `(?:${COURT_BELOW})?Certiorari (?:granted|denied)(?: limited to ${TAIL})?`,
  "certiorari-granted-vacated-remanded": `(?:${COURT_BELOW})?Certiorari granted, judgment vacated,? and (?:the )?case remanded(?: ${TAIL})?`,
  "rehearing-disposition": `(?:The )?(?:[Pp]etition for r|R)ehearing (?:is )?(?:granted|denied)`,
  "motion-disposition": `(?:The )?[Mm]otions?(?: ${TAIL})? (?:is |are )?(?:granted|denied)`,
  "appeal-dismissed": `(?:${COURT_BELOW})?(?:The )?[Aa]ppeals?(?: from ${TAIL})? (?:is |are )?dismissed(?: for want of ${TAIL})?`,
  "judgment-summarily-disposed": `(?:The )?[Jj]udgment (?:is )?summarily (?:affirmed|vacated)`,
  "lower-court-report": `Reported below: ${TAIL}`,
  "justice-vote-note": `${JUSTICES} would (?:grant|deny|dismiss)(?: ${TAIL})?`,
  "justice-recusal-note": `${JUSTICES} took no part in the (?:consideration or decision|decision) of ${TAIL}`,
} as const;

type OrderPatternName = keyof typeof ORDER_PATTERNS;

const ORDER_PATTERN_NAMES = Object.keys(ORDER_PATTERNS).filter(
  (name): name is OrderPatternName => Object.hasOwn(ORDER_PATTERNS, name),
);

// A sentence ends at a period followed by the opening of another order
// sentence or by the end of the text. Each sentence is matched once, left to
// right: a tail never backtracks across a sentence it already closed, so the
// scan stays linear in the number of sentences.
const OPENING =
  "(?:(?:The|Petition|Certiorari|Rehearing|Motions?|Appeals?|Judgment|Justices?|Reported)\\b|[A-Z][a-z]{0,6}\\.)";
const SENTENCE_END = `\\.(?= ${OPENING}|$) ?`;

const SENTENCE_PATTERNS = ORDER_PATTERN_NAMES.map(
  (name) =>
    [
      name,
      new RegExp(`(?:${ORDER_PATTERNS[name]})${SENTENCE_END}`, "uy"),
    ] as const,
);

/** The order sentence each part of `text` is, or `null` if any part is not one. */
const orderSentencesOf = (text: string): OrderPatternName[] | null => {
  const matched: OrderPatternName[] = [];
  let position = 0;
  while (position < text.length) {
    const start = position;
    const sentence = SENTENCE_PATTERNS.find(([, pattern]) => {
      pattern.lastIndex = start;
      return pattern.test(text);
    });
    if (sentence === undefined) {
      return null;
    }
    const [name, pattern] = sentence;
    matched.push(name);
    position = pattern.lastIndex;
  }
  return matched;
};

/** Visible principal text, whitespace collapsed; its length is in code points. */
const readOrderWording = (body: string) => {
  const text = stripDangerousChars(body)
    .normalize("NFC")
    .replace(/\s+/gu, " ")
    .trim();
  const length = [...text].length;
  const short = length > 0 && length <= SHORT_ORDER_MAX_CHARACTERS;
  return {
    length,
    matchedPatterns: short ? (orderSentencesOf(text) ?? []) : [],
  };
};

/** `unclassified` keeps the document, as a `decision` of no proven class. */
const DECISION_TYPES = {
  order: "order",
  opinion: "opinion",
  unclassified: "decision",
} as const;

type ClassificationKind = keyof typeof DECISION_TYPES;

type ClassifyDecisionOptions = {
  readonly opinionTypes: readonly OpinionType[];
  readonly scdbPresent: boolean;
  readonly principal: PrincipalTextEvidence;
};

/**
 * The class, the rule that decided it (or, unclassified, why none did), and
 * the evidence read: row types, principal length, matched order sentences and
 * SCDB linkage.
 */
export const classifyCourtListenerDecision = ({
  opinionTypes,
  principal,
  scdbPresent,
}: ClassifyDecisionOptions) => {
  const wording =
    principal.status === "parsed" ? readOrderWording(principal.body) : null;
  const decide = <TKind extends ClassificationKind>(
    kind: TKind,
    rule: string,
  ) => ({
    kind,
    decisionType: DECISION_TYPES[kind],
    rule,
    evidence: {
      classifierVersion: ORDER_CLASSIFIER_VERSION,
      opinionTypes,
      principalLength: wording?.length ?? null,
      matchedPatterns: wording?.matchedPatterns ?? [],
      scdbPresent,
    },
  });
  const signals = (signal: "order" | "opinion") =>
    opinionTypes.some((type) => OPINION_TYPES[type].classSignal === signal);

  if (principal.status === "parsed" && principal.orderHeading) {
    return decide("order", "order-heading");
  }
  if (signals("order")) {
    return decide("order", "motion-to-strike-type");
  }
  if (principal.status === "unavailable" || wording === null) {
    return decide("unclassified", "principal-text-unavailable");
  }
  if (wording.matchedPatterns.length > 0) {
    return decide("order", "short-order-wording");
  }
  if (principal.structuralOpinion) {
    return decide("opinion", "structural-opinion");
  }
  if (signals("opinion")) {
    return decide("opinion", "opinion-type");
  }
  const long = wording.length > SHORT_ORDER_MAX_CHARACTERS;
  if (long && scdbPresent) {
    return decide("opinion", "long-body-with-scdb");
  }
  if (long && principal.singleOpinionBody) {
    return decide("opinion", "long-body-single-opinion");
  }
  return decide(
    "unclassified",
    long
      ? "long-body-without-corroboration"
      : "short-body-without-order-wording",
  );
};
