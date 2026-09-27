import { Result, panic } from "better-result";

import { countryFromIso } from "./countries";
import type {
  Address,
  BirthDate,
  Country,
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
import {
  invalidValue,
  isoDate,
  missingField,
  parseDayBirthDate,
  parseSmallInteger,
  publisherStamp,
} from "./values";
import {
  attribute,
  childText,
  childrenNamed,
  parseXmlList,
  readXmlListVersion,
} from "./xml";
import type { XmlListFormat, XmlNode } from "./xml";

const SOURCE: SanctionsSource = "eu";
const UNKNOWN_COUNTRY = "00";

const ENTITY_TYPES: Readonly<Record<string, EntityType>> = {
  person: "person",
  enterprise: "organisation",
};

const IDENTIFIER_KINDS: Readonly<Record<string, IdentifierKind>> = {
  passport: "passport",
  id: "national-id",
  regnumber: "registration",
  fiscalcode: "tax",
  taxid: "tax",
  euvat: "tax",
  imo: "imo",
};

const listVersion = (
  root: Record<string, string>,
): Result<ListVersion, SanctionsListParseError> => {
  const stamp = root["generationDate"]?.trim();
  if (stamp === undefined || stamp === "") {
    return Result.err(missingField(SOURCE, "<export> has no generationDate"));
  }
  const publishedAt = publisherStamp(SOURCE, stamp);
  if (publishedAt.isErr()) {
    return Result.err(publishedAt.error);
  }
  const fileId = root["globalFileId"]?.trim();
  const version: ListVersion = {
    source: SOURCE,
    publishedAt: publishedAt.value,
    fileId: fileId === undefined || fileId === "" ? null : fileId,
  };
  return Result.ok(version);
};

const country = (node: XmlNode): Country | null => {
  const code = attribute(node, "countryIso2Code");
  if (code === null || code === UNKNOWN_COUNTRY) {
    return null;
  }
  return countryFromIso(code, attribute(node, "countryDescription") ?? code);
};

const aliasName = (node: XmlNode): string | null =>
  attribute(node, "wholeName") ??
  (["firstName", "middleName", "lastName"]
    .map((name) => attribute(node, name))
    .filter((part) => part !== null)
    .join(" ") ||
    null);

/** What one `<birthdate>` row says; a row may name only a birthplace. */
type BirthRow =
  | { type: "date"; date: BirthDate }
  | { type: "hijri-year" }
  | { type: "place-only" };

const birthDate = (node: XmlNode): Result<BirthRow, SanctionsListParseError> =>
  Result.gen(function* () {
    const circa = yield* booleanAttribute(node, "circa");
    const calendar = attribute(node, "calendarType") ?? "GREGORIAN";
    const full = attribute(node, "birthdate");
    if (full !== null) {
      // The full date is Gregorian even on rows recorded in another calendar.
      const date = yield* parseDayBirthDate(SOURCE, full, circa);
      return Result.ok({ type: "date" as const, date });
    }
    const year = yield* integerAttribute(node, "year");
    const month = yield* integerAttribute(node, "monthOfYear");
    const day = yield* integerAttribute(node, "dayOfMonth");
    const fromYear = yield* integerAttribute(node, "yearRangeFrom");
    const toYear = yield* integerAttribute(node, "yearRangeTo");
    const incomplete = (what: string) =>
      Result.err(
        invalidValue(
          SOURCE,
          `birth date ${attribute(node, "logicalId") ?? ""} ${what}`,
        ),
      );
    if (day !== null) {
      return incomplete("has a day of month but no full date");
    }
    if (year !== null && (fromYear !== null || toYear !== null)) {
      return incomplete("has both a year and a year range");
    }
    if (month !== null && year === null) {
      return incomplete("has a month but no year");
    }
    if (month !== null && (month < 1 || month > 12)) {
      return incomplete(`has month ${month}`);
    }
    switch (calendar) {
      // "ISLAMIC" rows carry lunar Hijri years and, for Iranian entries, solar
      // Hijri years alike, so a bare year cannot be converted safely. The
      // entry is only accepted when it also lists Gregorian dates.
      case "ISLAMIC":
        return Result.ok(
          year === null && fromYear === null && toYear === null
            ? { type: "place-only" as const }
            : { type: "hijri-year" as const },
        );
      case "GREGORIAN":
        if (year !== null) {
          const date: BirthDate =
            month === null
              ? { precision: "year", year, circa }
              : { precision: "month", year, month, circa };
          return Result.ok({ type: "date" as const, date });
        }
        if (fromYear !== null) {
          const date: BirthDate = {
            precision: "year-range",
            fromYear,
            toYear,
            circa,
          };
          return Result.ok({ type: "date" as const, date });
        }
        if (toYear !== null) {
          const date: BirthDate = {
            precision: "year-range",
            fromYear,
            toYear,
            circa,
          };
          return Result.ok({ type: "date" as const, date });
        }
        return Result.ok({ type: "place-only" as const });
      default:
        return Result.err(
          invalidValue(SOURCE, `unknown calendarType "${calendar}"`),
        );
    }
  });

/** An xsd:boolean flag; absent reads as false, anything unknown fails. */
const booleanAttribute = (
  node: XmlNode,
  name: string,
): Result<boolean, SanctionsListParseError> => {
  const value = attribute(node, name);
  switch (value) {
    case null:
    case "false":
      return Result.ok(false);
    case "true":
      return Result.ok(true);
    default:
      return Result.err(
        invalidValue(SOURCE, `${name}="${value}" is not true or false`),
      );
  }
};

const integerAttribute = (
  node: XmlNode,
  name: string,
): Result<number | null, SanctionsListParseError> => {
  const value = attribute(node, name);
  return value === null ? Result.ok(null) : parseSmallInteger(SOURCE, value);
};

const identifier = (
  node: XmlNode,
): Result<Identifier | null, SanctionsListParseError> => {
  const number = attribute(node, "number") ?? attribute(node, "latinNumber");
  if (number === null) {
    return Result.ok(null);
  }
  const code = attribute(node, "identificationTypeCode") ?? "";
  return booleanAttribute(node, "knownFalse").map((knownFalse): Identifier => ({
    kind: IDENTIFIER_KINDS[code] ?? "other",
    label: attribute(node, "identificationTypeDescription") ?? code,
    number,
    country: country(node),
    status: knownFalse ? "known-false" : "listed",
  }));
};

const address = (node: XmlNode): Address | null => {
  const street = attribute(node, "street");
  const city = attribute(node, "city") ?? attribute(node, "place");
  const region = attribute(node, "region");
  const postalCode = attribute(node, "zipCode");
  const where = country(node);
  if (
    [street, city, region, postalCode, where].every((part) => part === null)
  ) {
    return null;
  }
  return { street, city, region, postalCode, country: where };
};

const entry = (
  node: XmlNode,
): Result<SanctionsEntry, SanctionsListParseError> => {
  const sourceId = attribute(node, "logicalId");
  if (sourceId === null) {
    return Result.err(
      missingField(SOURCE, "<sanctionEntity> has no logicalId"),
    );
  }
  const subject = childrenNamed(node, "subjectType").at(0);
  const subjectCode = subject === undefined ? null : attribute(subject, "code");
  const entityType =
    subjectCode === null ? undefined : ENTITY_TYPES[subjectCode];
  if (entityType === undefined) {
    return Result.err(
      invalidValue(
        SOURCE,
        `entry ${sourceId} has subject type "${subjectCode ?? ""}"`,
      ),
    );
  }

  const names: SanctionsName[] = [];
  const seen = new Set<string>();
  for (const alias of childrenNamed(node, "nameAlias")) {
    const name = aliasName(alias);
    if (name === null || seen.has(name)) {
      continue;
    }
    seen.add(name);
    names.push({
      name,
      quality: attribute(alias, "strong") === "false" ? "weak" : "strong",
    });
  }
  if (names.length === 0) {
    return Result.err(missingField(SOURCE, `entry ${sourceId} has no name`));
  }

  const regulation = childrenNamed(node, "regulation").at(0);
  const sourceUrl =
    regulation === undefined ? null : childText(regulation, "publicationUrl");
  if (regulation === undefined || sourceUrl === null) {
    return Result.err(
      missingField(SOURCE, `entry ${sourceId} has no designating regulation`),
    );
  }

  const birthDates: BirthDate[] = [];
  let hijriOnly = false;
  for (const birth of childrenNamed(node, "birthdate")) {
    const parsed = birthDate(birth);
    if (parsed.isErr()) {
      return Result.err(parsed.error);
    }
    const row = parsed.value;
    switch (row.type) {
      case "date":
        birthDates.push(row.date);
        break;
      case "hijri-year":
        hijriOnly = true;
        break;
      case "place-only":
        break;
      default:
        row satisfies never;
        panic("unhandled birth row");
    }
  }
  if (hijriOnly && birthDates.length === 0) {
    return Result.err(
      invalidValue(
        SOURCE,
        `entry ${sourceId} gives its birth year only in the Hijri calendar`,
      ),
    );
  }

  const identifiers: Identifier[] = [];
  for (const document of childrenNamed(node, "identification")) {
    const parsed = identifier(document);
    if (parsed.isErr()) {
      return Result.err(parsed.error);
    }
    if (parsed.value !== null) {
      identifiers.push(parsed.value);
    }
  }

  const listedOnText =
    attribute(node, "designationDate") ??
    attribute(regulation, "publicationDate");
  const listedOn =
    listedOnText === null ? Result.ok(null) : isoDate(SOURCE, listedOnText);
  if (listedOn.isErr()) {
    return Result.err(listedOn.error);
  }

  const regulationType = attribute(regulation, "regulationType");
  const numberTitle = attribute(regulation, "numberTitle");
  const parsed: SanctionsEntry = {
    source: SOURCE,
    sourceId,
    referenceNumber: attribute(node, "euReferenceNumber"),
    entityType,
    names,
    birthDates,
    nationalities: childrenNamed(node, "citizenship")
      .map(country)
      .filter((value) => value !== null),
    identifiers,
    addresses: childrenNamed(node, "address")
      .map(address)
      .filter((value) => value !== null),
    programme: attribute(regulation, "programme"),
    legalBasis:
      numberTitle === null
        ? null
        : [regulationType, numberTitle]
            .filter((part) => part !== null)
            .join(" "),
    listedOn: listedOn.value,
    sourceUrl,
  };
  return Result.ok(parsed);
};

const FORMAT: XmlListFormat = {
  source: SOURCE,
  rootName: "export",
  layout: { export: new Set(["sanctionEntity"]) },
  recordNames: new Set(["sanctionEntity"]),
  toEntry: entry,
  toVersion: listVersion,
};

/**
 * Parses the EU consolidated financial sanctions list (XML schema 1.1) from a
 * byte stream, e.g. `Bun.file(path).stream()` or a fetch response body.
 */
export const parseEuList = async (
  input: AsyncIterable<Uint8Array>,
): Promise<Result<ParsedList, SanctionsListParseError>> =>
  await parseXmlList(FORMAT, input);

/** Reads the edition stamp at the start of an EU list and stops there. */
export const readEuListVersion = async (
  input: AsyncIterable<Uint8Array>,
): Promise<Result<ListVersion, SanctionsListParseError>> =>
  await readXmlListVersion(FORMAT, input);
