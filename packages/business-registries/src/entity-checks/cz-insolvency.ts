import { panic, Result } from "better-result";

import { isRecord } from "../shared/guards.js";
import {
  malformed,
  optionalText,
  optionalXsdDate,
  requiredText,
} from "./fields.js";
import { EntityCheckCancelledError, unavailable } from "./result.js";
import type {
  EntityCheckSource,
  EntityCheckSourceError,
  EntityCheckSubject,
  EntityCheckUnavailableError,
  SourceAnswer,
} from "./result.js";
import { escapeXml, soapRequest } from "./soap.js";

// Czech insolvency register (ISIR), queried through the Ministry of Justice's
// public ISIR_CUZK_WS service (method getIsirWsCuzkData). The service answers
// "is this person or company a debtor in insolvency proceedings" from a copy
// of the register synchronised hourly. Documentation:
// https://isir.justice.cz/isir/help/Popis_WS_2_v1_13.pdf

const ENDPOINT = "https://isir.justice.cz:8443/isir_cuzk_ws/IsirWsCuzkService";
const TYPES_NAMESPACE = "http://isirws.cca.cz/types/";
const PUBLIC_DETAIL_HOST = "isir.justice.cz";
// Findings beyond this are counted in `totalMatches` but not returned.
const MAX_RESULTS = 50;

export const CZ_INSOLVENCY_SOURCE = {
  name: "Insolvenční rejstřík (ISIR)",
  authority: "Ministerstvo spravedlnosti České republiky",
  url: "https://isir.justice.cz",
} as const satisfies EntityCheckSource;

// `maxRelevanceVysledku` caps how far the service relaxes the query. Without
// it the service falls back from an IČO or name + birth date match to a bare
// surname match, which would report unrelated debtors.
// Codes 1 (birth number), 3 (file number) and 5 to 7 (weaker name matches)
// are never requested.
const RELEVANCE = {
  companyId: "2",
  nameAndBirthDate: "4",
} as const;

export const CZ_INSOLVENCY_MATCH_BASES = [
  "company-id",
  "name-and-birth-date",
] as const;

type IsirMatchBasis = (typeof CZ_INSOLVENCY_MATCH_BASES)[number];

const MATCH_BASIS_BY_RELEVANCE = new Map<string, IsirMatchBasis>([
  [RELEVANCE.companyId, "company-id"],
  [RELEVANCE.nameAndBirthDate, "name-and-birth-date"],
]);

export const CZ_INSOLVENCY_PHASES = ["ongoing", "ended", "unverified"] as const;

// Return codes (kodChyby). WS2 is the only code that means "the register
// holds nothing for these criteria"; every other code is a failure.
const EMPTY_RESULT_CODE = "WS2";

export type CzInsolvencyFinding = {
  /** Court file number without the court prefix, e.g. "25 INS 10525/2016". */
  fileNumber: string;
  court: string | null;
  /**
   * `ongoing` when the register lists the proceeding as pending, `ended`
   * otherwise, `unverified` when the pending-only query failed.
   */
  phase: (typeof CZ_INSOLVENCY_PHASES)[number];
  /** Register state code (druhStavKonkursu), e.g. "KONKURS", "ODDLUŽENÍ". */
  stateCode: string | null;
  matchedBy: IsirMatchBasis;
  debtor: {
    name: string | null;
    firstName: string | null;
    companyId: string | null;
    birthDate: string | null;
    address: string | null;
  };
  /** Effective date of the insolvency decision, when recorded. */
  insolvencyDeclaredOn: string | null;
  /** Effective date of the decision ending the insolvency, when recorded. */
  insolvencyEndedOn: string | null;
  /** Public ISIR page of the proceeding. */
  url: string | null;
};

type IsirRecord = {
  fileNumber: string;
  isCoDebtor: boolean;
  finding: Omit<CzInsolvencyFinding, "phase" | "matchedBy">;
};

type IsirAnswer =
  | { type: "empty"; syncedAt: string | null }
  | {
      type: "records";
      syncedAt: string | null;
      matchedBy: IsirMatchBasis;
      totalMatches: number;
      records: readonly IsirRecord[];
    };

type ParseResult<T> = Result<T, EntityCheckUnavailableError>;

const publicDetailUrl = (value: string | null): string | null => {
  if (value === null || !URL.canParse(value)) {
    return null;
  }
  const url = new URL(value);
  return url.protocol === "https:" && url.hostname === PUBLIC_DETAIL_HOST
    ? url.href
    : null;
};

const joinPresent = (parts: readonly (string | null)[], separator: string) =>
  parts.filter((part) => part !== null && part.length > 0).join(separator);

const parseAddress = (
  record: Record<string, unknown>,
): ParseResult<string | null> =>
  Result.gen(function* () {
    const street = joinPresent(
      [
        yield* optionalText(record, "ulice"),
        yield* optionalText(record, "cisloPopisne"),
      ],
      " ",
    );
    const city = joinPresent(
      [
        yield* optionalText(record, "psc"),
        yield* optionalText(record, "mesto"),
      ],
      " ",
    );
    const address = joinPresent(
      [street, city, yield* optionalText(record, "zeme")],
      ", ",
    );
    return Result.ok(address.length === 0 ? null : address);
  });

const parseRecord = (value: unknown): ParseResult<IsirRecord> =>
  Result.gen(function* () {
    if (!isRecord(value)) {
      return yield* malformed("ISIR data entry is not an element");
    }
    const senate = yield* requiredText(value, "cisloSenatu");
    const caseType = yield* requiredText(value, "druhVec");
    const serial = yield* requiredText(value, "bcVec");
    const year = yield* requiredText(value, "rocnik");
    const fileNumber = `${senate} ${caseType} ${serial}/${year}`;
    const coDebtorFlag = yield* optionalText(value, "dalsiDluznikVRizeni");
    return Result.ok({
      fileNumber,
      isCoDebtor: coDebtorFlag === "T",
      finding: {
        fileNumber,
        court: yield* optionalText(value, "nazevOrganizace"),
        stateCode: yield* optionalText(value, "druhStavKonkursu"),
        debtor: {
          name: yield* optionalText(value, "nazevOsoby"),
          firstName: yield* optionalText(value, "jmeno"),
          companyId: yield* optionalText(value, "ic"),
          birthDate: yield* optionalXsdDate(value, "datumNarozeni"),
          address: yield* parseAddress(value),
        },
        insolvencyDeclaredOn: yield* optionalXsdDate(
          value,
          "datumPmZahajeniUpadku",
        ),
        insolvencyEndedOn: yield* optionalXsdDate(
          value,
          "datumPmUkonceniUpadku",
        ),
        url: publicDetailUrl(yield* optionalText(value, "urlDetailRizeni")),
      },
    });
  });

const parseCount = (status: Record<string, unknown>): ParseResult<number> =>
  requiredText(status, "pocetVysledku").andThen((raw) =>
    /^\d+$/u.test(raw)
      ? Result.ok(Number(raw))
      : Result.err(malformed("ISIR result count is not a number")),
  );

/** Interpret a getIsirWsCuzkData SOAP body. */
const parseIsirAnswer = (
  body: Record<string, unknown>,
): ParseResult<IsirAnswer> =>
  Result.gen(function* () {
    const response = body["getIsirWsCuzkDataResponse"];
    if (!isRecord(response)) {
      return yield* malformed("ISIR response element is missing");
    }
    const status = response["stav"];
    if (!isRecord(status)) {
      return yield* malformed("ISIR status element is missing");
    }
    const syncedAt = yield* optionalText(status, "casSynchronizace");
    const errorCode = yield* optionalText(status, "kodChyby");
    const data = response["data"] ?? [];
    if (!Array.isArray(data)) {
      return yield* malformed("ISIR data is not a list");
    }

    if (errorCode === EMPTY_RESULT_CODE) {
      if (data.length > 0) {
        return yield* malformed(
          "ISIR reported an empty result alongside records",
        );
      }
      return Result.ok({ type: "empty", syncedAt } as const);
    }
    if (errorCode !== null) {
      // WS1/WS3 (rejected input), WS4 (stale copy), SQL1, SERVER1, or a code
      // this client does not know.
      return yield* unavailable({
        reason: "source-error",
        message: `ISIR answered with error code ${errorCode}`,
        detail: errorCode,
      });
    }
    if (data.length === 0) {
      return yield* malformed(
        "ISIR returned neither records nor an empty-result code",
      );
    }

    const relevance = yield* requiredText(status, "relevanceVysledku");
    const matchedBy = MATCH_BASIS_BY_RELEVANCE.get(relevance);
    if (matchedBy === undefined) {
      // A weaker match basis than requested (for example a bare surname)
      // cannot be attributed to the subject.
      return yield* malformed(
        `ISIR matched on unexpected relevance ${relevance}`,
      );
    }
    const records: IsirRecord[] = [];
    for (const entry of data) {
      records.push(yield* parseRecord(entry));
    }
    const count = yield* parseCount(status);
    return Result.ok({
      type: "records",
      syncedAt,
      matchedBy,
      totalMatches: Math.max(count, records.length),
      records,
    } as const);
  });

type IsirQuery = {
  subject: EntityCheckSubject;
  pendingOnly: boolean;
  signal: AbortSignal | undefined;
};

const subjectCriteria = (subject: EntityCheckSubject): string => {
  switch (subject.type) {
    case "company-id": {
      return `<ic>${escapeXml(subject.value)}</ic><maxRelevanceVysledku>${RELEVANCE.companyId}</maxRelevanceVysledku>`;
    }
    case "person": {
      // Prefix and diacritics-insensitive name matching widens recall; the
      // birth date plus the relevance cap keep matches on the same person,
      // and each finding carries the debtor as registered for review.
      return [
        `<nazevOsoby>${escapeXml(subject.lastName)}</nazevOsoby>`,
        `<jmeno>${escapeXml(subject.firstName)}</jmeno>`,
        `<datumNarozeni>${escapeXml(subject.birthDate)}</datumNarozeni>`,
        `<vyhledatBezDiakritiky>T</vyhledatBezDiakritiky>`,
        `<maxRelevanceVysledku>${RELEVANCE.nameAndBirthDate}</maxRelevanceVysledku>`,
      ].join("");
    }
    default: {
      subject satisfies never;
      return panic("Unhandled subject");
    }
  }
};

const queryIsir = async ({
  subject,
  pendingOnly,
  signal,
}: IsirQuery): Promise<Result<IsirAnswer, EntityCheckSourceError>> => {
  // The service rejects empty elements, so optional ones are omitted.
  const criteria = [
    subjectCriteria(subject),
    `<maxPocetVysledku>${MAX_RESULTS}</maxPocetVysledku>`,
    pendingOnly ? "<filtrAktualniRizeni>T</filtrAktualniRizeni>" : "",
  ].join("");
  const body = await soapRequest({
    url: ENDPOINT,
    soapAction: "",
    namespaces: { typ: TYPES_NAMESPACE },
    body: `<typ:getIsirWsCuzkDataRequest>${criteria}</typ:getIsirWsCuzkDataRequest>`,
    repeatedElements: new Set(["data"]),
    signal,
  });
  return body.andThen(parseIsirAnswer);
};

const phaseOf = (
  fileNumber: string,
  pending: Result<IsirAnswer, EntityCheckUnavailableError>,
): CzInsolvencyFinding["phase"] => {
  if (pending.isErr()) {
    return "unverified";
  }
  if (pending.value.type === "empty") {
    return "ended";
  }
  return pending.value.records.some(
    (record) => record.fileNumber === fileNumber,
  )
    ? "ongoing"
    : "ended";
};

/**
 * Ask ISIR whether the subject is a debtor in any recorded insolvency
 * proceeding, pending or ended. Anything but an explicit answer is an error.
 */
export const checkCzInsolvency = async (
  subject: EntityCheckSubject,
  signal: AbortSignal | undefined,
): Promise<Result<SourceAnswer<CzInsolvencyFinding>, EntityCheckSourceError>> =>
  await Result.gen(async function* () {
    const all = yield* Result.await(
      queryIsir({ subject, pendingOnly: false, signal }),
    );
    if (all.type === "empty") {
      return Result.ok({
        type: "clear",
        sourceDataAsOf: all.syncedAt,
      } satisfies SourceAnswer<CzInsolvencyFinding>);
    }
    // Co-debtors (for example a spouse in a joint proceeding) are added by
    // the service without matching the criteria; they are not the subject.
    const matched = all.records.filter((record) => !record.isCoDebtor);

    // The service documents the pending-only filter as the reliable way to
    // tell pending from ended proceedings, so ask a second time with it. A
    // source failure here keeps the findings and marks the phase unverified;
    // cancellation still ends the check.
    const pendingQuery = await queryIsir({
      subject,
      pendingOnly: true,
      signal,
    });
    const pending = yield* settlePending(pendingQuery);

    const [first, ...rest] = matched.map(
      ({ fileNumber, finding }): CzInsolvencyFinding => ({
        fileNumber,
        court: finding.court,
        phase: phaseOf(fileNumber, pending),
        stateCode: finding.stateCode,
        matchedBy: all.matchedBy,
        debtor: finding.debtor,
        insolvencyDeclaredOn: finding.insolvencyDeclaredOn,
        insolvencyEndedOn: finding.insolvencyEndedOn,
        url: finding.url,
      }),
    );
    if (first === undefined) {
      return yield* malformed("ISIR returned only co-debtors of other debtors");
    }
    return Result.ok({
      type: "found",
      sourceDataAsOf: all.syncedAt,
      totalMatches: all.totalMatches,
      findings: [first, ...rest],
    } satisfies SourceAnswer<CzInsolvencyFinding>);
  });

/** Keep a source failure as a value; let cancellation end the check. */
const settlePending = (
  pending: Result<IsirAnswer, EntityCheckSourceError>,
): Result<
  Result<IsirAnswer, EntityCheckUnavailableError>,
  EntityCheckCancelledError
> => {
  if (pending.isOk()) {
    return Result.ok(Result.ok(pending.value));
  }
  return EntityCheckCancelledError.is(pending.error)
    ? Result.err(pending.error)
    : Result.ok(Result.err(pending.error));
};
