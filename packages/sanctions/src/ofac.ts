import { Result } from "better-result";

import { countryFromName } from "./countries";
import type {
  Address,
  AliasQuality,
  BirthDate,
  EntityType,
  Identifier,
  IdentifierKind,
  ListVersion,
  ParsedList,
  SanctionsEntry,
  SanctionsListParseError,
  SanctionsName,
  SanctionsSource,
} from "./entry";
import { SANCTIONS_SOURCES } from "./sources";
import {
  invalidValue,
  missingField,
  parseDayBirthDate,
  parseSmallInteger,
} from "./values";
import {
  childText,
  childrenNamed,
  parseXmlList,
  readXmlListVersion,
} from "./xml";
import type { XmlListFormat, XmlNode } from "./xml";

const ROOT = "sdnList";
const METADATA = "publshInformation";
const RECORD = "sdnEntry";
type OfacSource = "us-sdn" | "us-non-sdn";
const MONTHS = new Map([
  ["Jan", 1],
  ["Feb", 2],
  ["Mar", 3],
  ["Apr", 4],
  ["May", 5],
  ["Jun", 6],
  ["Jul", 7],
  ["Aug", 8],
  ["Sep", 9],
  ["Oct", 10],
  ["Nov", 11],
  ["Dec", 12],
]);
const US_DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/u;
const YEAR = /^\d{4}$/u;
const MONTH_YEAR = /^([A-Z][a-z]{2}) (\d{4})$/u;
const DAY_MONTH_YEAR = /^(\d{1,2}) ([A-Z][a-z]{2}) (\d{4})$/u;

const listUrl = (source: OfacSource): string =>
  SANCTIONS_SOURCES[source].download.urls[0];

const listVersion = (
  source: SanctionsSource,
  metadata: XmlNode | null,
): Result<ListVersion, SanctionsListParseError> => {
  if (metadata === null) {
    return Result.err(missingField(source, `<${ROOT}> has no ${METADATA}`));
  }
  const stamp = childText(metadata, "Publish_Date");
  if (stamp === null) {
    return Result.err(
      missingField(source, `<${METADATA}> has no Publish_Date`),
    );
  }
  const match = US_DATE.exec(stamp);
  if (match === null) {
    return Result.err(invalidValue(source, `invalid Publish_Date "${stamp}"`));
  }
  const [, month, day, year] = match;
  if (month === undefined || day === undefined || year === undefined) {
    return Result.err(invalidValue(source, `invalid Publish_Date "${stamp}"`));
  }
  const publishedAt = `${year}-${month}-${day}`;
  return parseDayBirthDate(source, publishedAt, false).map(() => ({
    source,
    publishedAt,
    fileId: null,
  }));
};

const recordCount = (
  source: SanctionsSource,
  metadata: XmlNode | null,
): Result<number, SanctionsListParseError> => {
  const text = metadata === null ? null : childText(metadata, "Record_Count");
  if (text === null) {
    return Result.err(
      missingField(source, `<${METADATA}> has no Record_Count`),
    );
  }
  if (!/^\d+$/u.test(text) || !Number.isSafeInteger(Number(text))) {
    return Result.err(invalidValue(source, `invalid Record_Count "${text}"`));
  }
  return Result.ok(Number(text));
};

const monthNumber = (
  source: SanctionsSource,
  text: string,
): Result<number, SanctionsListParseError> => {
  const month = MONTHS.get(text);
  if (month !== undefined) {
    return Result.ok(month);
  }
  return Result.err(invalidValue(source, `unknown birth month "${text}"`));
};

type BirthPartOptions = {
  source: SanctionsSource;
  value: string;
  circa: boolean;
};

const birthPart = ({
  source,
  value,
  circa,
}: BirthPartOptions): Result<
  Extract<BirthDate, { precision: "day" | "month" | "year" }>,
  SanctionsListParseError
> => {
  if (YEAR.test(value)) {
    return parseSmallInteger(source, value).map((year) => ({
      precision: "year" as const,
      year,
      circa,
    }));
  }
  const monthYear = MONTH_YEAR.exec(value);
  if (monthYear !== null) {
    const [, monthText, yearText] = monthYear;
    if (monthText !== undefined && yearText !== undefined) {
      return Result.gen(function* () {
        const month = yield* monthNumber(source, monthText);
        const year = yield* parseSmallInteger(source, yearText);
        return Result.ok({ precision: "month" as const, year, month, circa });
      });
    }
  }
  const dayMonthYear = DAY_MONTH_YEAR.exec(value);
  if (dayMonthYear !== null) {
    const [, dayText, monthText, yearText] = dayMonthYear;
    if (
      dayText !== undefined &&
      monthText !== undefined &&
      yearText !== undefined
    ) {
      return Result.gen(function* () {
        const month = yield* monthNumber(source, monthText);
        const year = yield* parseSmallInteger(source, yearText);
        const date = yield* parseDayBirthDate(
          source,
          `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${dayText.padStart(2, "0")}`,
          circa,
        );
        return Result.ok(date);
      });
    }
  }
  return Result.err(invalidValue(source, `unrecognised birth date "${value}"`));
};

const birthDate = (
  source: SanctionsSource,
  value: string,
): Result<BirthDate, SanctionsListParseError> => {
  const circa = value.startsWith("circa ");
  const text = circa ? value.slice(6) : value;
  const parts = text.split(" to ");
  if (parts.length === 1) {
    return birthPart({ source, value: text, circa });
  }
  if (parts.length !== 2) {
    return Result.err(
      invalidValue(source, `unrecognised birth range "${value}"`),
    );
  }
  const from = parts.at(0);
  const to = parts.at(1);
  if (from === undefined || to === undefined) {
    return Result.err(
      invalidValue(source, `unrecognised birth range "${value}"`),
    );
  }
  return Result.gen(function* () {
    const start = yield* birthPart({ source, value: from, circa });
    const end = yield* birthPart({ source, value: to, circa });
    if (start.year > end.year) {
      return Result.err(
        invalidValue(source, `reversed birth range "${value}"`),
      );
    }
    return Result.ok({
      precision: "year-range" as const,
      fromYear: start.year,
      toYear: end.year,
      circa,
    });
  });
};

const entityType = (value: string | null): EntityType => {
  switch (value) {
    case "Individual":
      return "person";
    case "Entity":
      return "organisation";
    case "Vessel":
      return "vessel";
    case "Aircraft":
      return "aircraft";
    default:
      return "unknown";
  }
};

const aliasQuality = (value: string | null): AliasQuality => {
  switch (value) {
    case "strong":
      return "strong";
    case "weak":
      return "weak";
    default:
      return "unknown";
  }
};

const identifierKind = (label: string): IdentifierKind => {
  const lower = label.toLowerCase();
  if (lower.includes("passport")) {
    return "passport";
  }
  if (/national id|national identification|identity card/u.test(lower)) {
    return "national-id";
  }
  if (/tax id|tax identification|fiscal code|vat/u.test(lower)) {
    return "tax";
  }
  if (/vessel registration identification|imo number/u.test(lower)) {
    return "imo";
  }
  if (
    /registration|company number|business number|corporate number/u.test(lower)
  ) {
    return "registration";
  }
  if (
    /identification number|driver.s licen[cs]e|mmsi|call sign|tail number/u.test(
      lower,
    )
  ) {
    return "other";
  }
  // OFAC also uses idList for gender, web URLs, sanctions notes and other
  // non-identity facts. Keep them visible, but never use them as ID matches.
  return "unknown";
};

const fullName = (node: XmlNode): string | null => {
  const first = childText(node, "firstName");
  const last = childText(node, "lastName");
  return [first, last].filter((part) => part !== null).join(" ") || null;
};

const address = (node: XmlNode): Address | null => {
  const street =
    ["address1", "address2", "address3"]
      .map((name) => childText(node, name))
      .filter((part) => part !== null)
      .join(", ") || null;
  const city = childText(node, "city");
  const region = childText(node, "stateOrProvince");
  const postalCode = childText(node, "postalCode");
  const countryName = childText(node, "country");
  if (
    [street, city, region, postalCode, countryName].every(
      (part) => part === null,
    )
  ) {
    return null;
  }
  return {
    street,
    city,
    region,
    postalCode,
    country: countryName === null ? null : countryFromName(countryName),
  };
};

const toEntry = (
  source: OfacSource,
  node: XmlNode,
): Result<SanctionsEntry, SanctionsListParseError> =>
  Result.gen(function* () {
    const sourceId = childText(node, "uid");
    if (sourceId === null) {
      return Result.err(missingField(source, `<${RECORD}> has no uid`));
    }
    const names: SanctionsName[] = [];
    const seen = new Set<string>();
    const addName = (name: string | null, quality: AliasQuality) => {
      if (name !== null && !seen.has(name)) {
        seen.add(name);
        names.push({ name, quality });
      }
    };
    addName(fullName(node), "strong");
    for (const alias of childrenNamed(
      childrenNamed(node, "akaList").at(0) ?? node,
      "aka",
    )) {
      addName(fullName(alias), aliasQuality(childText(alias, "category")));
    }
    if (names.length === 0) {
      return Result.err(missingField(source, `entry ${sourceId} has no name`));
    }

    const birthDates: BirthDate[] = [];
    const birthList = childrenNamed(node, "dateOfBirthList").at(0);
    for (const item of birthList === undefined
      ? []
      : childrenNamed(birthList, "dateOfBirthItem")) {
      const text = childText(item, "dateOfBirth");
      if (text !== null) {
        birthDates.push(yield* birthDate(source, text));
      }
    }
    const identifiers: Identifier[] = [];
    const idList = childrenNamed(node, "idList").at(0);
    for (const id of idList === undefined ? [] : childrenNamed(idList, "id")) {
      const number = childText(id, "idNumber");
      if (number === null) {
        continue;
      }
      const label = childText(id, "idType") ?? "";
      const kind = identifierKind(label);
      const country = childText(id, "idCountry");
      identifiers.push({
        kind,
        status: "listed",
        label,
        number: kind === "imo" ? number.replace(/^IMO\s+/iu, "") : number,
        country: country === null ? null : countryFromName(country),
      });
    }
    const vessel = childrenNamed(node, "vesselInfo").at(0);
    const callSign =
      vessel === undefined ? null : childText(vessel, "callSign");
    if (callSign !== null) {
      identifiers.push({
        kind: "other",
        status: "listed",
        label: "Call Sign",
        number: callSign,
        country: null,
      });
    }
    const nationalityList = childrenNamed(node, "nationalityList").at(0);
    const citizenshipList = childrenNamed(node, "citizenshipList").at(0);
    const programmeList = childrenNamed(node, "programList").at(0);
    const addressList = childrenNamed(node, "addressList").at(0);
    const programmes =
      programmeList === undefined
        ? []
        : childrenNamed(programmeList, "program")
            .map((program) => program.text.trim())
            .filter((value) => value !== "");
    return Result.ok({
      source,
      issuer: SANCTIONS_SOURCES[source].issuer,
      sourceId,
      referenceNumber: sourceId,
      entityType: entityType(childText(node, "sdnType")),
      names,
      birthDates,
      nationalities: [
        ...(nationalityList === undefined
          ? []
          : childrenNamed(nationalityList, "nationality")),
        ...(citizenshipList === undefined
          ? []
          : childrenNamed(citizenshipList, "citizenship")),
      ]
        .map((nationality) => childText(nationality, "country"))
        .filter((country) => country !== null)
        .map(countryFromName),
      identifiers,
      addresses:
        addressList === undefined
          ? []
          : childrenNamed(addressList, "address")
              .map(address)
              .filter((value) => value !== null),
      programme: programmes.join("; ") || null,
      legalBasis: null,
      listedOn: null,
      sourceUrl: listUrl(source),
    });
  });

const format = (source: OfacSource): XmlListFormat => ({
  source,
  rootName: ROOT,
  layout: { [ROOT]: new Set([METADATA, RECORD]) },
  recordNames: new Set([RECORD]),
  metadataName: METADATA,
  toEntry: (record) => toEntry(source, record),
  toVersion: (_root, metadata) => listVersion(source, metadata),
  toRecordCount: (metadata) => recordCount(source, metadata),
});

/** Parses an OFAC SDN or consolidated non-SDN XML export from a byte stream. */
export const parseOfacList = async (
  source: OfacSource,
  input: AsyncIterable<Uint8Array>,
): Promise<Result<ParsedList, SanctionsListParseError>> =>
  await parseXmlList(format(source), input);

/** Reads the publication date and stops before the first OFAC entry. */
export const readOfacListVersion = async (
  source: OfacSource,
  input: AsyncIterable<Uint8Array>,
): Promise<Result<ListVersion, SanctionsListParseError>> =>
  await readXmlListVersion(format(source), input);
