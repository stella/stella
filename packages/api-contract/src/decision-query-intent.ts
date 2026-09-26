import {
  canonicalDecisionIdentifierKey,
  canonicalDecisionDocket,
  foldDecisionIdentifierInput,
  formatDecisionDocket,
  parseDecisionDocket,
} from "./decision-docket-grammar";
import type { DecisionDocketGrammar } from "./decision-docket-grammar";

/**
 * What a case-law box entry asks for: a decision by its identifier (a docket
 * number in one of the grammars the corpus's courts use, or an ECLI), or words
 * to search the text by. Anything the grammars do not claim is text, verbatim.
 */
export type DecisionQueryIntent =
  | { type: "empty" }
  | { type: "identifier"; kind: "docket" | "ecli"; value: string }
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
  identifier: string,
  hits: readonly THit[],
  { grammar }: ExactDecisionMatchOptions = {},
): THit[] => {
  const keyOf = (value: string): string =>
    decisionIdentifierComparisonKey(value, grammar);
  const wanted = keyOf(identifier);
  return hits.filter(
    (hit) =>
      keyOf(hit.caseNumber) === wanted ||
      (hit.ecli !== null && keyOf(hit.ecli) === wanted) ||
      hit.identifiers?.some(({ value }) => keyOf(value) === wanted) === true,
  );
};
