import { panic } from "better-result";

import {
  canonicalDecisionIdentifierKey,
  canonicalDecisionDocket,
  foldDecisionIdentifierInput,
  formatDecisionDocket,
  parseDecisionDocket,
} from "./decision-docket-grammar";
import type { DecisionDocketGrammar } from "./decision-docket-grammar";

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

/** A reference to one decision, as a caller names it. */
export type DecisionReference = {
  kind: DecisionIdentifierKind;
  value: string;
};

/**
 * What a case-law box entry asks for: a decision by its identifier (a docket
 * number in one of the grammars the corpus's courts use, an ECLI, or a
 * reporter citation), or words to search the text by. Anything the grammars
 * do not claim is text, verbatim.
 */
export type DecisionQueryIntent =
  | { type: "empty" }
  | ({ type: "identifier" } & DecisionReference)
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
      value: formatDecisionDocket(docket),
    };
  }
  return { type: "text", text };
};

/**
 * The identity of a docket or ECLI as publishers vary it: case, spacing and
 * dash style are theirs, not the docket's, and the sheet number names a page
 * of the file rather than the decision. Read through the scope's grammar when
 * there is one, and through the unscoped grammars otherwise.
 */
const decisionIdentifierComparisonKey = (
  value: string,
  grammar: DecisionDocketGrammar | null | undefined,
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

/**
 * The grammars the entry was read under, the same ones `parseDecisionQuery`
 * took. Omitted, identifiers compare the way an unscoped entry parses.
 */
type ExactDecisionMatchesOptions = {
  readonly grammar?: DecisionDocketGrammar | null | undefined;
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
  reference: DecisionReference,
  hits: readonly THit[],
  { grammar, reporters }: ExactDecisionMatchesOptions = {},
): THit[] => {
  switch (reference.kind) {
    case "docket":
    case "ecli": {
      const keyOf = (value: string): string =>
        decisionIdentifierComparisonKey(value, grammar);
      const wanted = keyOf(reference.value);
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
        reference.kind,
        reporters,
      );
      const wanted = key(reference.value);
      return hits.filter(
        (hit) =>
          hit.identifiers?.some(
            ({ type, value }) =>
              type === identifierType && key(value) === wanted,
          ) === true,
      );
    }
    default: {
      reference.kind satisfies never;
      return panic(`Unhandled decision reference kind: ${String(reference)}`);
    }
  }
};
