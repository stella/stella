import { panic } from "better-result";

import {
  DECISION_IDENTIFIER_TYPES,
  normalizeStructuredDecisionIdentifier,
} from "@stll/legal-ast/decision-identifier";
import type {
  DecisionIdentifier,
  DecisionPrimaryReferenceType,
} from "@stll/legal-ast/decision-identifier";
import { normalizeUnicode, stripUnicodeMarks } from "@stll/text-normalize";

export const RULING_IDENTITY_VERSION = 1 as const;

export type RulingIdentityInput = {
  readonly country: string;
  readonly court?: string | null | undefined;
  readonly courtId?: string | null | undefined;
  /** Caller-validated ISO calendar date; derivation does not rewrite it. */
  readonly decisionDate?: string | null | undefined;
  readonly caseNumber?: string | null | undefined;
  /** Absent means a docket, matching the ingestion contract. */
  readonly caseNumberType?: DecisionPrimaryReferenceType | undefined;
  readonly identifiers?: readonly DecisionIdentifier[] | undefined;
  readonly ecli?: string | null | undefined;
  readonly decisionType?: string | null | undefined;
};

export type RulingIdentityDefect =
  | "docket_absent"
  | "docket_without_digits"
  | "date_absent"
  | "court_absent";

type StatedKey = { readonly stated: string; readonly key: string };
type OptionalStatedKey =
  | ({ readonly kind: "stated" } & StatedKey)
  | { readonly kind: "absent" };

export type RulingIdentityKeys = {
  readonly version: typeof RULING_IDENTITY_VERSION;
  readonly country: string;
  readonly court:
    | { readonly kind: "directory"; readonly id: string }
    | ({ readonly kind: "name" } & StatedKey)
    | { readonly kind: "absent" };
  readonly date:
    | { readonly kind: "stated"; readonly value: string }
    | { readonly kind: "absent" };
  readonly dockets: readonly StatedKey[];
  readonly ecli: OptionalStatedKey;
  readonly decisionKind: OptionalStatedKey;
  readonly defects: readonly RulingIdentityDefect[];
};

/**
 * Language-independent comparison fold: NFKC, remove whitespace and Cf,
 * lowercase, fold final sigma to sigma, NFKD, remove marks, then map Unicode
 * dash punctuation and minus to hyphen. Remove whitespace after NFKC because
 * compatibility spaces become ordinary spaces. Removing gaps before lowercase
 * avoids contextual sigma changes; the Unicode CaseFolding final-sigma mapping
 * also makes terminal and internal sigma agree. Stated values stay untouched.
 */
export const foldRulingIdentity = (value: string): string =>
  stripUnicodeMarks(
    normalizeUnicode(value, "NFKC")
      .replace(/[\p{White_Space}\p{Cf}]/gu, "")
      .toLowerCase()
      .replace(/\u03c2/gu, "\u03c3"),
    { form: "NFKD", markClass: "combining" },
  ).replace(/[\p{Pd}\u2212]/gu, "-");

// Decimal blocks contain ten digits; adjacent blocks (mathematical styles)
// repeat that sequence. Derive values from Unicode structure, not a script list.
const decimalDigit = (digit: string): string => {
  const code =
    digit.codePointAt(0) ?? panic("Decimal run contains an empty digit");
  let start = code;
  while (/\p{Nd}/u.test(String.fromCodePoint(start - 1))) {
    start -= 1;
  }
  return String((code - start) % 10);
};

const docketKey = (stated: string): string => {
  // Preserve every gap between decimal digits before the shared fold removes
  // invisible characters. Other gaps have no role in the docket key.
  const folded = foldRulingIdentity(
    normalizeUnicode(stated, "NFKC").replace(
      /(\p{Nd})[^\p{L}\p{Nd}]+(?=\p{Nd})/gu,
      "$1/",
    ),
  );
  const runs = folded.match(/\p{L}+|\p{Nd}+|[^\p{L}\p{Nd}]+/gu) ?? [];
  let key = "";
  let previousWasDigits = false;
  let separated = false;
  for (const run of runs) {
    if (/^\p{Nd}/u.test(run)) {
      if (previousWasDigits && separated) {
        key += "/";
      }
      key += Array.from(run, decimalDigit)
        .join("")
        .replace(/^0+(?=\d)/u, "");
      previousWasDigits = true;
      separated = false;
      continue;
    }
    if (/^\p{L}/u.test(run)) {
      key += run;
      previousWasDigits = false;
      separated = false;
      continue;
    }
    separated = true;
  }
  return key;
};

export const rulingKeysOf = ({
  country,
  court,
  courtId,
  decisionDate,
  caseNumber,
  caseNumberType,
  identifiers,
  ecli,
  decisionType,
}: RulingIdentityInput): RulingIdentityKeys => {
  const defects: RulingIdentityDefect[] = [];
  const courtKey = court ? foldRulingIdentity(court) : "";
  let derivedCourt: RulingIdentityKeys["court"] = { kind: "absent" };
  if (courtId) {
    derivedCourt = { kind: "directory", id: courtId };
  } else if (court && courtKey) {
    derivedCourt = { kind: "name", stated: court, key: courtKey };
  }
  if (derivedCourt.kind === "absent") {
    defects.push("court_absent");
  }
  const date: RulingIdentityKeys["date"] = decisionDate
    ? { kind: "stated", value: decisionDate }
    : { kind: "absent" };
  if (date.kind === "absent") {
    defects.push("date_absent");
  }
  const primaryIsDocket =
    caseNumberType === undefined ||
    caseNumberType === DECISION_IDENTIFIER_TYPES.CASE_NUMBER;
  const statedDockets = caseNumber && primaryIsDocket ? [caseNumber] : [];
  for (const identifier of identifiers ?? []) {
    if (identifier.type === DECISION_IDENTIFIER_TYPES.CASE_NUMBER) {
      statedDockets.push(identifier.value);
    }
  }
  const dockets: StatedKey[] = [];
  const seen = new Set<string>();
  for (const stated of statedDockets) {
    const key = docketKey(stated);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    dockets.push({ stated, key });
  }
  if (dockets.length === 0) {
    defects.push("docket_absent");
  }
  if (dockets.some(({ key }) => !/\d/u.test(key))) {
    defects.push("docket_without_digits");
  }
  const kindKey = decisionType ? foldRulingIdentity(decisionType) : "";
  const ecliKey = ecli
    ? normalizeStructuredDecisionIdentifier({
        type: DECISION_IDENTIFIER_TYPES.ECLI,
        value: ecli,
      })
    : "";
  return {
    version: RULING_IDENTITY_VERSION,
    country: foldRulingIdentity(country),
    court: derivedCourt,
    date,
    dockets,
    ecli:
      ecli && ecliKey
        ? { kind: "stated", stated: ecli, key: ecliKey }
        : { kind: "absent" },
    decisionKind:
      decisionType && kindKey
        ? { kind: "stated", stated: decisionType, key: kindKey }
        : { kind: "absent" },
    defects,
  };
};

/**
 * Candidate groups, not proof of ruling identity: generic letter separators
 * intentionally collapse. Exact docket matching belongs to jurisdiction grammars.
 * Decision kind is a discriminator alongside the group, never inside it.
 */
export const rulingGroupKeys = ({
  country,
  court,
  date,
  dockets,
}: RulingIdentityKeys): string[] => {
  if (court.kind === "absent" || date.kind === "absent") {
    return [];
  }
  // Tag court namespaces and escape delimiters so stated names cannot alias ids.
  const courtKey =
    court.kind === "directory" ? `directory:${court.id}` : `name:${court.key}`;
  return dockets
    .filter(({ key }) => /\d/u.test(key))
    .map(({ key }) =>
      [country, courtKey, date.value, key]
        .map((part) => part.replaceAll("%", "%25").replaceAll("|", "%7C"))
        .join("|"),
    );
};
