/**
 * The key under which a Supreme Court ruling stored by one Polish source
 * meets the same ruling stored by another.
 *
 * `pl-sn` (the court's own database) and `pl-courts` (the SAOS mirror, which
 * holds this court up to mid-2016) store the same rulings under their own
 * publisher ids. Neither id means anything to the other source, so rows are
 * related by what both state: the docket, the decision date and the kind of
 * decision. Two rows sharing a key are one ruling; both rows are kept.
 */

import { foldDecisionIdentifierInput } from "@stll/api-contract/decision-docket-grammar";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import type { DecisionIdentifier } from "@stll/legal-ast/decision-identifier";

import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import { arrayOrEmpty } from "@/api/lib/array";

const SUPREME_COURT = "sąd najwyższy";

/** Leading words both sources use for a decision's kind. */
const RULING_KINDS = [
  "wyrok",
  "postanowienie",
  "uchwała",
  "zarządzenie",
  "uzasadnienie",
  "orzeczenie",
  "opinia",
  "wyciąg z protokołu",
] as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

/** `12/2015` and `012/15` are the same docket as `12/15`. */
const DOCKET_YEAR = /^(?:\d{4}|\d{2})$/u;

const isDigit = (character: string): boolean =>
  character >= "0" && character <= "9";

/**
 * A docket reduced to what distinguishes it.
 *
 * Whitespace is dropped rather than collapsed: the division numeral, the
 * repertory and the ordinal are told apart by their characters, and spellings
 * differ only in the spaces between them ("III CSK 12/15", "IIICSK 12/15").
 * Case is folded, so the court's lower-case repertory suffixes ("NSNc")
 * compare equal however a mirror capitalised them.
 */
export const normalizeSupremeCourtDocket = (docket: string): string => {
  const compact = foldDecisionIdentifierInput(docket)
    .toLocaleUpperCase("pl-PL")
    .replace(/^SYGN\.?\s*AKT:?/u, "")
    .replace(/\s+/gu, "");
  const slash = compact.lastIndexOf("/");
  const year = compact.slice(slash + 1);
  if (slash === -1 || !DOCKET_YEAR.test(year)) {
    return compact;
  }
  let ordinalStart = slash;
  while (ordinalStart > 0 && isDigit(compact.charAt(ordinalStart - 1))) {
    ordinalStart -= 1;
  }
  if (ordinalStart === slash) {
    return compact;
  }
  const head = compact.slice(0, ordinalStart);
  const ordinal = compact.slice(ordinalStart, slash);
  return `${head}${Number(ordinal)}/${year.slice(-2)}`;
};

/**
 * Kinds one source names differently from the other. The court titled some
 * of its 1990s merits rulings "orzeczenie"; SAOS files the same rulings as
 * judgments.
 */
const RULING_KIND_ALIASES: Readonly<Record<string, string>> = {
  orzeczenie: "wyrok",
};

const rulingKindOf = (decisionType: string): string | undefined => {
  const lowered = decisionType
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase("pl-PL");
  const kind = RULING_KINDS.find(
    (candidate) => lowered === candidate || lowered.startsWith(`${candidate} `),
  );
  return kind === undefined ? undefined : (RULING_KIND_ALIASES[kind] ?? kind);
};

type SupremeCourtRulingKeyInput = Pick<
  IngestionResult,
  "caseNumber" | "court" | "decisionDate" | "decisionType"
> & {
  /** Every further identifier the row states; only its dockets count. */
  identifiers?: readonly DecisionIdentifier[] | undefined;
};

/**
 * One key per docket the row states, or none.
 *
 * Empty for a row of another court, or one missing its date or kind: a docket
 * alone does not name a ruling, since an order and the judgment that follows
 * it share one.
 */
export const plSupremeCourtRulingKeys = ({
  caseNumber,
  court,
  decisionDate,
  decisionType,
  identifiers,
}: SupremeCourtRulingKeyInput): string[] => {
  if (
    court.replace(/\s+/gu, " ").trim().toLocaleLowerCase("pl-PL") !==
    SUPREME_COURT
  ) {
    return [];
  }
  if (decisionDate === undefined || !ISO_DATE.test(decisionDate)) {
    return [];
  }
  const kind =
    decisionType === undefined ? undefined : rulingKindOf(decisionType);
  if (kind === undefined) {
    return [];
  }
  const dockets = [
    caseNumber,
    ...arrayOrEmpty(identifiers)
      .filter(({ type }) => type === DECISION_IDENTIFIER_TYPES.CASE_NUMBER)
      .map(({ value }) => value),
  ];
  return [
    ...new Set(
      dockets.map(
        (docket) =>
          `sn|${normalizeSupremeCourtDocket(docket)}|${decisionDate}|${kind}`,
      ),
    ),
  ];
};
