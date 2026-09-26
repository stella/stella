import { panic } from "better-result";

import {
  canonicalDecisionIdentifierKey,
  canonicalDecisionDocket,
  foldDecisionIdentifierInput,
  formatDecisionDocket,
  parseDecisionDocket,
} from "./decision-docket-grammar";
import type { DecisionDocketGrammar } from "./decision-docket-grammar";
import { canonicalUsReporterCitation } from "./us-reporter-citation";

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
};

export const parseDecisionQuery = (
  raw: string,
  { grammar }: ParseDecisionQueryOptions = {},
): DecisionQueryIntent => {
  const text = raw.trim();
  if (text.length === 0) {
    return { type: "empty" };
  }
  const folded = foldDecisionIdentifierInput(text);
  if (ECLI_RE.test(folded)) {
    return { type: "identifier", kind: "ecli", value: folded };
  }
  // Before the docket fallback. Only a whole entry of volume, an edition the
  // reporter table carries, and a page is claimed, so no docket grammar's
  // spelling is taken from it.
  const reporter = canonicalUsReporterCitation(folded);
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

type ExactDecisionMatchOptions = {
  /**
   * The scope the entry was read under, the same one `parseDecisionQuery`
   * took. Omitted, identifiers compare the way an unscoped entry parses.
   */
  readonly grammar?: DecisionDocketGrammar | null | undefined;
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

/**
 * How a typed reference is compared: only against identifiers stored under its
 * own type, each read by that type's canonicaliser. A reporter citation is
 * read into its canonical edition first, so a variant abbreviation or a pin
 * does not change it.
 */
const TYPED_REFERENCE_COMPARISON = {
  neutral: { identifierType: "neutral-citation", key: structuredCitationKey },
  reporter: {
    identifierType: "reporter-citation",
    key: (value: string) =>
      structuredCitationKey(canonicalUsReporterCitation(value) ?? value),
  },
} as const satisfies Record<
  TypedReferenceKind,
  { identifierType: string; key: (value: string) => string }
>;

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
  { grammar }: ExactDecisionMatchOptions = {},
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
      const { identifierType, key } =
        TYPED_REFERENCE_COMPARISON[reference.kind];
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
