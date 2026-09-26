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
  | { type: "identifier"; kind: "ecli"; value: string };

/**
 * What a case-law box entry asks for: a decision by its identifier (a docket
 * number in one of the grammars the corpus's courts use, or an ECLI), or words
 * to search the text by. Anything the grammars do not claim is text, verbatim.
 */
export type DecisionQueryIntent =
  | { type: "empty" }
  | DecisionIdentifierIntent
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

/** An ECLI belongs to no docket grammar, so it is compared unscoped. */
const comparisonGrammarOf = (
  identifier: DecisionIdentifierIntent,
): DecisionDocketGrammar | undefined => {
  switch (identifier.kind) {
    case "docket":
      return DECISION_DOCKET_GRAMMARS[identifier.jurisdiction];
    case "ecli":
      return undefined;
    default:
      identifier satisfies never;
      return panic("Unhandled decision identifier kind");
  }
};

type DecisionHitIdentity = {
  caseNumber: string;
  ecli: string | null;
  /** Every identifier the publisher supplied, parallel case numbers included. */
  identifiers?: readonly { value: string }[] | undefined;
};

/**
 * The hits that are the decision the entry named, not merely ones that
 * mention it: by case number, ECLI, or any other identifier the publisher
 * supplied (a second docket, a reporter citation). Several are the same
 * docket at several courts, which the reader must choose between; the caller
 * never picks one for them.
 */
export const exactDecisionMatches = <THit extends DecisionHitIdentity>(
  identifier: DecisionIdentifierIntent,
  hits: readonly THit[],
): THit[] => {
  const grammar = comparisonGrammarOf(identifier);
  const keyOf = (value: string) =>
    decisionIdentifierComparisonKey(value, grammar);
  const wanted = keyOf(identifier.value);
  return hits.filter(
    (hit) =>
      keyOf(hit.caseNumber) === wanted ||
      (hit.ecli !== null && keyOf(hit.ecli) === wanted) ||
      hit.identifiers?.some(({ value }) => keyOf(value) === wanted) === true,
  );
};
