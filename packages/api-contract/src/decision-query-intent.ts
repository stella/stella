import {
  canonicalDecisionDocket,
  foldDecisionIdentifierInput,
  formatDecisionDocket,
  parseDecisionDocket,
} from "./decision-docket-grammar";

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
  readonly jurisdiction?: string | undefined;
};

export const parseDecisionQuery = (
  raw: string,
  { jurisdiction }: ParseDecisionQueryOptions = {},
): DecisionQueryIntent => {
  const text = raw.trim();
  if (text.length === 0) {
    return { type: "empty" };
  }
  const folded = foldDecisionIdentifierInput(text);
  if (ECLI_RE.test(folded)) {
    return { type: "identifier", kind: "ecli", value: folded };
  }
  const docket = parseDecisionDocket(folded, { jurisdiction });
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
 * of the file rather than the decision.
 */
const compactIdentifier = (value: string): string =>
  foldDecisionIdentifierInput(value)
    .toLowerCase()
    .replace(/-\d{1,4}$/u, "")
    .replaceAll(" ", "");

const decisionIdentifierComparisonKey = (value: string): string => {
  const docket = parseDecisionDocket(value);
  return docket === null
    ? `other:${compactIdentifier(value)}`
    : `docket:${canonicalDecisionDocket(docket)}`;
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
): THit[] => {
  const wanted = decisionIdentifierComparisonKey(identifier);
  return hits.filter(
    (hit) =>
      decisionIdentifierComparisonKey(hit.caseNumber) === wanted ||
      (hit.ecli !== null &&
        decisionIdentifierComparisonKey(hit.ecli) === wanted) ||
      hit.identifiers?.some(
        ({ value }) => decisionIdentifierComparisonKey(value) === wanted,
      ) === true,
  );
};
