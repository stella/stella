import { panic, Result } from "better-result";

import { isRecord } from "../shared/guards.js";
import {
  malformed,
  optionalText,
  optionalXsdDate,
  requiredText,
} from "./fields.js";
import { unavailable } from "./result.js";
import type {
  CheckedEntityCheckSubject,
  EntityCheckSource,
  EntityCheckSourceError,
  EntityCheckUnavailableError,
  SourceAnswer,
} from "./result.js";
import { escapeXml, soapRequest } from "./soap.js";

// Czech VAT payer register, queried through the Ministry of Finance's public
// ADIS service rozhraniCRPDPH (operation
// getStatusNespolehlivySubjektRozsirenyV2). For one DIČ it answers whether
// the subject is a VAT payer, an identified person, a VAT group member or an
// unreliable person, whether it is an unreliable VAT payer, and which bank
// accounts it has published. WSDL:
// https://adisrws.mfcr.cz/adistc/axis2/services/rozhraniCRPDPH.rozhraniCRPDPHSOAP?wsdl

const ENDPOINT =
  "https://adisrws.mfcr.cz/adistc/axis2/services/rozhraniCRPDPH.rozhraniCRPDPHSOAP";
const SERVICE_NAMESPACE = "http://adis.mfcr.cz/rozhraniCRPDPH/";
const OPERATION = "getStatusNespolehlivySubjektRozsirenyV2";

export const CZ_VAT_RELIABILITY_SOURCE = {
  name: "Registr plátců DPH (ADIS)",
  authority: "Ministerstvo financí České republiky",
  url: "https://adisspr.mfcr.cz/adistc/adis/idpr_pub/dpr/uvod.faces",
} as const satisfies EntityCheckSource;

// statusCode: 0 OK; 1 OK but only the first 100 DIČ answered (one is sent);
// 2 scheduled outage (00:00 to 00:10); 3 service unavailable.
const ANSWERED_STATUS_CODES = new Set(["0", "1"]);

// nespolehlivyPlatce: ANO (unreliable), NE (reliable), NENALEZEN (not in the
// VAT register).
const RELIABILITY = {
  unreliable: "ANO",
  reliable: "NE",
  notFound: "NENALEZEN",
} as const;
const KNOWN_RELIABILITY = new Set<string>(Object.values(RELIABILITY));

export const CZ_VAT_SUBJECT_TYPES = [
  "vat-payer",
  "identified-person",
  "vat-group",
  "unreliable-person",
] as const;

type CzVatSubjectType = (typeof CZ_VAT_SUBJECT_TYPES)[number];

// typSubjektu. NENALEZEN is handled before this map is read.
const SUBJECT_TYPE_BY_CODE = new Map<string, CzVatSubjectType>([
  ["PLATCE_DPH", "vat-payer"],
  ["IDENTIFIKOVANA_OSOBA", "identified-person"],
  ["SKUPINA_DPH", "vat-group"],
  ["NESPOLEHLIVA_OSOBA", "unreliable-person"],
]);
const SUBJECT_NOT_FOUND = "NENALEZEN";

type CzVatPublishedAccount = {
  /** Domestic "prefix-number/bank code", or the IBAN the register lists. */
  account: string;
  publishedOn: string;
  /** Set when the account was withdrawn from publication. */
  withdrawnOn: string | null;
};

export type CzVatPayerRecord = {
  subjectType: CzVatSubjectType;
  name: string | null;
  address: string | null;
  /** Code of the tax office administering the subject. */
  taxOfficeCode: string | null;
  publishedAccounts: CzVatPublishedAccount[];
};

export const CZ_VAT_FINDING_TYPES = [
  "unreliable-vat-payer",
  "unreliable-person",
] as const;

export type CzVatReliabilityFinding = {
  type: (typeof CZ_VAT_FINDING_TYPES)[number];
  /** When the register published the unreliability, if it says. */
  publishedOn: string | null;
};

type ParseResult<T> = Result<T, EntityCheckUnavailableError>;

const parseAccount = (value: unknown): ParseResult<CzVatPublishedAccount> =>
  Result.gen(function* () {
    if (!isRecord(value)) {
      return yield* malformed("ADIS account entry is not an element");
    }
    const publishedOn = yield* optionalXsdDate(value, "@datumZverejneni");
    if (publishedOn === null) {
      return yield* malformed("ADIS account has no publication date");
    }
    const withdrawnOn = yield* optionalXsdDate(
      value,
      "@datumZverejneniUkonceni",
    );
    const standard = value["standardniUcet"];
    const nonStandard = value["nestandardniUcet"];
    if (isRecord(standard)) {
      const prefix = yield* optionalText(standard, "@predcisli");
      const number = yield* requiredText(standard, "@cislo");
      const bank = yield* requiredText(standard, "@kodBanky");
      return Result.ok({
        account: `${prefix === null ? "" : `${prefix}-`}${number}/${bank}`,
        publishedOn,
        withdrawnOn,
      });
    }
    if (isRecord(nonStandard)) {
      return Result.ok({
        account: yield* requiredText(nonStandard, "@cislo"),
        publishedOn,
        withdrawnOn,
      });
    }
    return yield* malformed("ADIS account has no account number");
  });

const parseAddress = (value: unknown): ParseResult<string | null> =>
  Result.gen(function* () {
    if (value === undefined) {
      return Result.ok(null);
    }
    if (!isRecord(value)) {
      return yield* malformed("ADIS address is not an element");
    }
    const street = yield* optionalText(value, "uliceCislo");
    const district = yield* optionalText(value, "castObce");
    const city = yield* optionalText(value, "mesto");
    const postalCode = yield* optionalText(value, "psc");
    const country = yield* optionalText(value, "stat");
    const parts = [
      street,
      district,
      [postalCode, city].filter((part) => part !== null).join(" "),
      country,
    ].filter((part) => part !== null && part.length > 0);
    return Result.ok(parts.length === 0 ? null : parts.join(", "));
  });

const parseAccounts = (value: unknown): ParseResult<CzVatPublishedAccount[]> =>
  Result.gen(function* () {
    if (value === undefined) {
      return Result.ok([]);
    }
    if (!isRecord(value)) {
      return yield* malformed("ADIS account list is not an element");
    }
    const entries = value["ucet"] ?? [];
    if (!Array.isArray(entries)) {
      return yield* malformed("ADIS accounts are not a list");
    }
    const accounts: CzVatPublishedAccount[] = [];
    for (const entry of entries) {
      accounts.push(yield* parseAccount(entry));
    }
    return Result.ok(accounts);
  });

type CzVatAnswer = SourceAnswer<CzVatReliabilityFinding, CzVatPayerRecord>;

/** Interpret one statusSubjektu entry for the DIČ that was asked about. */
const parseSubjectStatus = (
  entry: Record<string, unknown>,
): ParseResult<CzVatAnswer> =>
  Result.gen(function* () {
    const typeCode = yield* requiredText(entry, "@typSubjektu");
    const reliability = yield* requiredText(entry, "@nespolehlivyPlatce");
    if (typeCode === SUBJECT_NOT_FOUND) {
      // "Not found" must be unanimous: a register that says the DIČ is
      // unknown yet flags it unreliable is not an answer to trust.
      return reliability === RELIABILITY.notFound
        ? Result.ok({
            type: "not-registered",
            sourceDataAsOf: null,
          } satisfies CzVatAnswer)
        : yield* malformed("ADIS reported an unknown subject with a status");
    }
    const subjectType = SUBJECT_TYPE_BY_CODE.get(typeCode);
    if (subjectType === undefined) {
      return yield* malformed(`ADIS returned subject type ${typeCode}`);
    }
    const record: CzVatPayerRecord = {
      subjectType,
      name: yield* optionalText(entry, "nazevSubjektu"),
      address: yield* parseAddress(entry["adresa"]),
      taxOfficeCode: yield* optionalText(entry, "@cisloFu"),
      publishedAccounts: yield* parseAccounts(entry["zverejneneUcty"]),
    };
    const publishedOn = yield* optionalXsdDate(
      entry,
      "@datumZverejneniNespolehlivosti",
    );
    if (!KNOWN_RELIABILITY.has(reliability)) {
      return yield* malformed(`ADIS returned reliability ${reliability}`);
    }
    // An unreliable person is not a VAT payer, so its payer flag need not
    // read ANO; the subject type carries that adverse status.
    const findings: CzVatReliabilityFinding[] = [];
    if (reliability === RELIABILITY.unreliable) {
      findings.push({ type: "unreliable-vat-payer", publishedOn });
    }
    if (subjectType === "unreliable-person") {
      findings.push({ type: "unreliable-person", publishedOn });
    }
    const [first, ...rest] = findings;
    if (first !== undefined) {
      return Result.ok({
        type: "found",
        sourceDataAsOf: null,
        totalMatches: findings.length,
        findings: [first, ...rest],
        record,
      } satisfies CzVatAnswer);
    }
    if (reliability !== RELIABILITY.reliable) {
      return yield* malformed("ADIS listed a registered subject as not found");
    }
    return Result.ok({
      type: "clear",
      sourceDataAsOf: null,
      record,
    } satisfies CzVatAnswer);
  });

/** Interpret a getStatusNespolehlivySubjektRozsirenyV2 body for one DIČ. */
const parseAdisAnswer = (
  body: Record<string, unknown>,
  digits: string,
): ParseResult<CzVatAnswer> =>
  Result.gen(function* () {
    const response = body["StatusNespolehlivySubjektRozsirenyResponse"];
    if (!isRecord(response)) {
      return yield* malformed("ADIS response element is missing");
    }
    const status = response["status"];
    if (!isRecord(status)) {
      return yield* malformed("ADIS status element is missing");
    }
    const statusCode = yield* requiredText(status, "@statusCode");
    if (!ANSWERED_STATUS_CODES.has(statusCode)) {
      return yield* unavailable({
        reason: "source-error",
        message: `ADIS answered with status ${statusCode}`,
        detail: statusCode,
      });
    }
    const entries = response["statusSubjektu"] ?? [];
    if (!Array.isArray(entries)) {
      return yield* malformed("ADIS subject statuses are not a list");
    }
    const matching = entries.filter(
      (entry) => isRecord(entry) && entry["@dic"] === digits,
    );
    const [entry, ...others] = matching;
    if (entry === undefined || others.length > 0 || !isRecord(entry)) {
      // One DIČ was asked, so exactly one answer for it must come back.
      return yield* malformed("ADIS did not answer for the requested DIČ");
    }
    return parseSubjectStatus(entry);
  });

/**
 * Ask ADIS whether the DIČ belongs to an unreliable VAT payer or unreliable
 * person, and read the bank accounts it has published.
 */
export const checkCzVatReliability = async (
  subject: CheckedEntityCheckSubject,
  signal: AbortSignal | undefined,
): Promise<Result<CzVatAnswer, EntityCheckSourceError>> => {
  if (subject.type !== "tax-id") {
    // The runner derives a DIČ from an IČO and answers not-covered for
    // anything else before a query is built.
    return panic("ADIS is queried by tax ID only");
  }
  // The service takes the DIČ without its "CZ" prefix.
  const digits = subject.value.replace(/^CZ/u, "");
  const body = await soapRequest({
    url: ENDPOINT,
    soapAction: `${SERVICE_NAMESPACE}${OPERATION}`,
    namespaces: { roz: SERVICE_NAMESPACE },
    body: `<roz:StatusNespolehlivySubjektRozsirenyV2Request><roz:dic>${escapeXml(digits)}</roz:dic></roz:StatusNespolehlivySubjektRozsirenyV2Request>`,
    repeatedElements: new Set(["statusSubjektu", "ucet"]),
    signal,
  });
  return body.andThen((parsed) => parseAdisAnswer(parsed, digits));
};
