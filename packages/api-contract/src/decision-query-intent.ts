import { panic } from "better-result";

import {
  canonicalDecisionIdentifierKey,
  canonicalDecisionDocket,
  DECISION_DOCKET_GRAMMARS,
  foldDecisionIdentifierInput,
  formatDecisionDocket,
  parseDecisionDocket,
} from "./decision-docket-grammar";
import type {
  DecisionDocketGrammar,
  DecisionDocketJurisdiction,
} from "./decision-docket-grammar";

/**
 * A decision named by its identifier. A docket carries the jurisdiction whose
 * grammar read it, because only that grammar keys its spellings alike: the
 * Czech and Slovak grammars both read `II. ÚS 55/98` and key it differently,
 * and only the Slovak one reads `II.ÚS55/98`.
 */
export type DecisionIdentifierIntent =
  | {
      type: "identifier";
      kind: "docket";
      jurisdiction: DecisionDocketJurisdiction;
      value: string;
    }
  | { type: "identifier"; kind: "ecli"; value: string }
  | { type: "identifier"; kind: "reporter" | "neutral"; value: string };

/**
 * A jurisdiction's reporter citation grammar, supplied by the caller the way
 * a docket grammar is. Injected rather than imported: its edition table is
 * data only the jurisdictions that cite reporters need, so a reader of any
 * other corpus never loads it.
 */
export type DecisionReporterGrammar = {
  /**
   * The canonical identity a whole entry names as a reporter citation, or null
   * when it is not one or does not settle on one reporter.
   */
  readonly canonicalCitation: (text: string) => string | null;
};

/**
 * The kinds of reference that name a decision outright. A neutral citation is
 * never inferred from free text: no grammar declares one, and a catch-all
 * pattern would claim ordinary words, so it only arrives typed explicitly.
 */
export type DecisionIdentifierKind = "docket" | "ecli" | "reporter" | "neutral";

/**
 * What a case-law box entry asks for: a decision by its identifier (a docket
 * number in one of the grammars the corpus's courts use, an ECLI, or a
 * reporter citation), or words to search the text by. Anything the grammars
 * do not claim is text, verbatim.
 */
export type DecisionQueryIntent =
  | { type: "empty" }
  | DecisionIdentifierIntent
  | { type: "text"; text: string };

const ECLI_RE = /^ecli:[a-z]{2}:[a-z0-9]{1,12}:\d{4}:[a-z0-9.]{1,64}$/iu;

type ParseDecisionQueryOptions = {
  readonly grammar?: DecisionDocketGrammar | null | undefined;
  /**
   * The reporter grammar of the jurisdiction the entry is read in. Without
   * one, an entry reads as it always did: no reporter citation is claimed.
   */
  readonly reporters?: DecisionReporterGrammar | null | undefined;
};

export const parseDecisionQuery = (
  raw: string,
  { grammar, reporters }: ParseDecisionQueryOptions = {},
): DecisionQueryIntent => {
  const text = raw.trim();
  if (text.length === 0) {
    return { type: "empty" };
  }
  const folded = foldDecisionIdentifierInput(text);
  if (ECLI_RE.test(folded)) {
    return { type: "identifier", kind: "ecli", value: folded };
  }
  // Before the docket fallback: only a whole entry the reporter grammar
  // settles on one reporter is claimed.
  const reporter = reporters?.canonicalCitation(folded) ?? null;
  if (reporter !== null) {
    return { type: "identifier", kind: "reporter", value: reporter };
  }
  const docket = parseDecisionDocket(folded, { grammar });
  if (docket !== null) {
    return {
      type: "identifier",
      kind: "docket",
      jurisdiction: docket.jurisdiction,
      value: formatDecisionDocket(docket),
    };
  }
  return { type: "text", text };
};

/**
 * The identity of a docket or ECLI as publishers vary it: case, spacing and
 * dash style are theirs, not the docket's, and the sheet number names a page
 * of the file rather than the decision. A docket is read by the grammar that
 * read the entry, so the entry and every stored spelling of it key alike.
 */
const decisionIdentifierComparisonKey = (
  value: string,
  grammar: DecisionDocketGrammar | undefined,
): string => {
  const docket = parseDecisionDocket(value, { grammar });
  return docket === null
    ? canonicalDecisionIdentifierKey(value)
    : canonicalDecisionDocket(docket);
};

/**
 * The identity of a structured citation: case, spacing and punctuation are
 * typography. The same folding the identifier column is written with.
 */
const structuredCitationKey = (value: string): string =>
  value
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(/[\p{P}\p{Z}\s]+/gu, "");

type TypedReferenceKind = Extract<
  DecisionIdentifierKind,
  "neutral" | "reporter"
>;

type TypedReferenceComparison = {
  identifierType: string;
  key: (value: string) => string;
};

/**
 * How a typed reference is compared: only against identifiers stored under its
 * own type, each read by that type's canonicaliser. A reporter citation is
 * read through the jurisdiction's reporter grammar first, so a variant
 * abbreviation or a pin does not change it.
 */
const typedReferenceComparison = (
  kind: TypedReferenceKind,
  reporters: DecisionReporterGrammar | null | undefined,
): TypedReferenceComparison => {
  switch (kind) {
    case "neutral":
      return { identifierType: "neutral-citation", key: structuredCitationKey };
    case "reporter":
      return {
        identifierType: "reporter-citation",
        key: (value) =>
          structuredCitationKey(reporters?.canonicalCitation(value) ?? value),
      };
    default: {
      kind satisfies never;
      return panic(`Unhandled typed reference kind: ${String(kind)}`);
    }
  }
};

type ExactDecisionMatchesOptions = {
  /** The reporter grammar the entry was read under, as `parseDecisionQuery` took it. */
  readonly reporters?: DecisionReporterGrammar | null | undefined;
};

type DecisionHitIdentity = {
  caseNumber: string;
  ecli: string | null;
  /** Every identifier the publisher supplied, parallel case numbers included. */
  identifiers?: readonly { type: string; value: string }[] | undefined;
};

/**
 * The hits that are the decision the entry named, not merely ones that
 * mention it. A docket or an ECLI matches by case number, ECLI, or any other
 * identifier the publisher supplied (a second docket, a reporter citation). A
 * reporter or neutral citation matches only an identifier of its own type.
 * Several are the same reference at several courts, which the reader must
 * choose between; the caller never picks one for them.
 */
export const exactDecisionMatches = <THit extends DecisionHitIdentity>(
  identifier: DecisionIdentifierIntent,
  hits: readonly THit[],
  { reporters }: ExactDecisionMatchesOptions = {},
): THit[] => {
  switch (identifier.kind) {
    case "docket":
    case "ecli": {
      // A docket is keyed by the grammar that read it; an ECLI belongs to no
      // docket grammar, so it is compared unscoped.
      const grammar =
        identifier.kind === "docket"
          ? DECISION_DOCKET_GRAMMARS[identifier.jurisdiction]
          : undefined;
      const keyOf = (value: string): string =>
        decisionIdentifierComparisonKey(value, grammar);
      const wanted = keyOf(identifier.value);
      return hits.filter(
        (hit) =>
          keyOf(hit.caseNumber) === wanted ||
          (hit.ecli !== null && keyOf(hit.ecli) === wanted) ||
          hit.identifiers?.some(({ value }) => keyOf(value) === wanted) ===
            true,
      );
    }
    case "neutral":
    case "reporter": {
      const { identifierType, key } = typedReferenceComparison(
        identifier.kind,
        reporters,
      );
      const wanted = key(identifier.value);
      return hits.filter(
        (hit) =>
          hit.identifiers?.some(
            ({ type, value }) =>
              type === identifierType && key(value) === wanted,
          ) === true,
      );
    }
    default: {
      identifier satisfies never;
      return panic(
        `Unhandled decision identifier: ${JSON.stringify(identifier)}`,
      );
    }
  }
};
