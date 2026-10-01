import {
  DECISION_IDENTIFIER_TYPES,
  normalizeStructuredDecisionIdentifier,
} from "@stll/legal-ast/decision-identifier";
import type { DecisionIdentifier } from "@stll/legal-ast/decision-identifier";

export const RULING_IDENTITY_VERSION = 1 as const;

export type RulingIdentityInput = {
  readonly country: string;
  readonly court?: string | null | undefined;
  readonly courtId?: string | null | undefined;
  readonly decisionDate?: string | null | undefined;
  readonly caseNumber?: string | null | undefined;
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
 * Language-independent comparison fold: NFKC, lowercase, NFKD, remove marks,
 * map Unicode dash punctuation and minus to hyphen, remove whitespace and Cf.
 * Stated values remain untouched; this fold applies only to derived keys.
 */
export const foldRulingIdentity = (value: string): string =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[\p{Pd}\u2212]/gu, "-")
    .replace(/[\p{White_Space}\p{Cf}]/gu, "");

// Decimal blocks contain ten digits; adjacent blocks (mathematical styles)
// repeat that sequence. Derive values from Unicode structure, not a script list.
const decimalDigit = (digit: string): string => {
  const code = digit.codePointAt(0);
  if (code === undefined) {
    return "";
  }
  let start = code;
  while (/\p{Nd}/u.test(String.fromCodePoint(start - 1))) {
    start -= 1;
  }
  return String((code - start) % 10);
};

const docketKey = (stated: string): string => {
  const folded = foldRulingIdentity(stated);
  const runs = folded.match(/\p{L}+|\p{Nd}+|[^\p{L}\p{Nd}]+/gu) ?? [];
  let key = "";
  let previousKind = "absent";
  let separated = false;
  for (const run of runs) {
    if (/^\p{Nd}/u.test(run)) {
      if (previousKind === "digits" && separated) {
        key += "/";
      }
      key += Array.from(run, decimalDigit)
        .join("")
        .replace(/^0+(?=\d)/u, "");
      previousKind = "digits";
      separated = false;
      continue;
    }
    if (/^\p{L}/u.test(run)) {
      key += run;
      previousKind = "letters";
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
  const statedDockets = caseNumber ? [caseNumber] : [];
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

/** Decision kind is a discriminator alongside the group, never inside it. */
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
      [country, courtKey, date.value, key].map(encodeURIComponent).join("|"),
    );
};
