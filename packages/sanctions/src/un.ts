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
import {
  invalidValue,
  isoDate,
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

const SOURCE: SanctionsSource = "un";
const ROOT = "CONSOLIDATED_LIST";
const LIST_URL = "https://scsanctions.un.org/resources/xml/en/consolidated.xml";

const RECORDS = {
  INDIVIDUAL: { entityType: "person", prefix: "INDIVIDUAL" },
  ENTITY: { entityType: "organisation", prefix: "ENTITY" },
} as const satisfies Record<string, { entityType: EntityType; prefix: string }>;

const isRecordName = (name: string): name is keyof typeof RECORDS =>
  Object.hasOwn(RECORDS, name);

// "Low" marks the aliases the committees consider too weak to act on alone.
const ALIAS_QUALITY: Readonly<Record<string, AliasQuality>> = {
  Good: "strong",
  "a.k.a.": "strong",
  "f.k.a.": "strong",
  Low: "weak",
};

const NAME_PARTS = ["FIRST_NAME", "SECOND_NAME", "THIRD_NAME", "FOURTH_NAME"];
const YEAR = /^\d{4}$/u;

const listVersion = (
  root: Record<string, string>,
): Result<ListVersion, SanctionsListParseError> => {
  const publishedAt = root["dateGenerated"]?.trim();
  if (publishedAt === undefined || publishedAt === "") {
    return Result.err(
      missingField(SOURCE, `<${ROOT}> has no dateGenerated attribute`),
    );
  }
  const version: ListVersion = { source: SOURCE, publishedAt, fileId: null };
  return Result.ok(version);
};

const birthDate = (
  node: XmlNode,
): Result<BirthDate | null, SanctionsListParseError> =>
  Result.gen(function* () {
    const type = childText(node, "TYPE_OF_DATE") ?? "EXACT";
    const date = childText(node, "DATE");
    const yearText = childText(node, "YEAR");
    const year =
      yearText === null ? null : yield* parseSmallInteger(SOURCE, yearText);
    switch (type) {
      case "EXACT":
      case "APPROXIMATELY": {
        const circa = type === "APPROXIMATELY";
        if (date !== null) {
          return parseDayBirthDate(SOURCE, date, circa);
        }
        return Result.ok(
          year === null ? null : { precision: "year" as const, year, circa },
        );
      }
      case "BETWEEN": {
        const from = childText(node, "FROM_YEAR");
        const to = childText(node, "TO_YEAR");
        if (from === null || to === null) {
          return Result.err(
            missingField(
              SOURCE,
              "a BETWEEN birth date lacks FROM_YEAR or TO_YEAR",
            ),
          );
        }
        return Result.ok({
          precision: "year-range" as const,
          fromYear: yield* parseSmallInteger(SOURCE, from),
          toYear: yield* parseSmallInteger(SOURCE, to),
          circa: false,
        });
      }
      default:
        return Result.err(
          invalidValue(SOURCE, `unknown TYPE_OF_DATE "${type}"`),
        );
    }
  });

// Document types are free text, sometimes in French or Spanish.
const identifierKind = (label: string): IdentifierKind => {
  const lower = label.toLowerCase();
  if (/passport|passeport|pasaporte/u.test(lower)) {
    return "passport";
  }
  return lower.includes("national identification") ? "national-id" : "other";
};

const identifier = (node: XmlNode): Identifier | null => {
  const number = childText(node, "NUMBER");
  if (number === null) {
    return null;
  }
  const label =
    childText(node, "TYPE_OF_DOCUMENT") ??
    childText(node, "TYPE_OF_DOCUMENT2") ??
    "";
  const issuer =
    childText(node, "ISSUING_COUNTRY") ?? childText(node, "COUNTRY_OF_ISSUE");
  return {
    kind: identifierKind(label),
    label,
    number,
    country: issuer === null ? null : countryFromName(issuer),
    status: "listed",
  };
};

const address = (node: XmlNode): Address | null => {
  const street = childText(node, "STREET");
  const city = childText(node, "CITY");
  const region = childText(node, "STATE_PROVINCE");
  const postalCode = childText(node, "ZIP_CODE");
  const countryName = childText(node, "COUNTRY");
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

const entry = (
  node: XmlNode,
): Result<SanctionsEntry, SanctionsListParseError> =>
  Result.gen(function* () {
    if (!isRecordName(node.name)) {
      return Result.err(
        invalidValue(SOURCE, `unexpected record <${node.name}>`),
      );
    }
    const { entityType, prefix } = RECORDS[node.name];
    const sourceId = childText(node, "DATAID");
    if (sourceId === null) {
      return Result.err(missingField(SOURCE, `<${node.name}> has no DATAID`));
    }

    const names: SanctionsName[] = [];
    const seen = new Set<string>();
    const addName = (name: string | null, quality: AliasQuality) => {
      if (name === null || seen.has(name)) {
        return;
      }
      seen.add(name);
      names.push({ name, quality });
    };
    addName(
      NAME_PARTS.map((part) => childText(node, part))
        .filter((part) => part !== null)
        .join(" ") || null,
      "strong",
    );
    const birthDates: BirthDate[] = [];
    for (const alias of childrenNamed(node, `${prefix}_ALIAS`)) {
      const name = childText(alias, "ALIAS_NAME");
      if (name === null) {
        continue;
      }
      const qualityText = childText(alias, "QUALITY") ?? "Good";
      const quality = ALIAS_QUALITY[qualityText];
      if (quality === undefined) {
        return Result.err(
          invalidValue(
            SOURCE,
            `entry ${sourceId} has alias quality "${qualityText}"`,
          ),
        );
      }
      // A few aliases pack several spellings into one field, "; "-separated.
      for (const spelling of name.split(";")) {
        addName(spelling.trim() || null, quality);
      }
      // Some aliases carry the birth date (a full date or a year) that goes
      // with that identity.
      const aliasBirth = childText(alias, "DATE_OF_BIRTH");
      if (aliasBirth !== null) {
        birthDates.push(
          YEAR.test(aliasBirth)
            ? { precision: "year", year: Number(aliasBirth), circa: false }
            : yield* parseDayBirthDate(SOURCE, aliasBirth, false),
        );
      }
    }
    addName(childText(node, "NAME_ORIGINAL_SCRIPT"), "strong");
    if (names.length === 0) {
      return Result.err(missingField(SOURCE, `entry ${sourceId} has no name`));
    }

    for (const birth of childrenNamed(node, `${prefix}_DATE_OF_BIRTH`)) {
      const parsed = yield* birthDate(birth);
      if (parsed !== null) {
        birthDates.push(parsed);
      }
    }

    const listedOnText = childText(node, "LISTED_ON");
    const listedOn =
      listedOnText === null ? null : yield* isoDate(SOURCE, listedOnText);

    const parsed: SanctionsEntry = {
      source: SOURCE,
      sourceId,
      referenceNumber: childText(node, "REFERENCE_NUMBER"),
      entityType,
      names,
      birthDates,
      nationalities: childrenNamed(node, "NATIONALITY")
        .flatMap((nationality) => childrenNamed(nationality, "VALUE"))
        .map((value) => value.text.trim())
        .filter((value) => value !== "")
        .map(countryFromName),
      identifiers: childrenNamed(node, `${prefix}_DOCUMENT`)
        .map(identifier)
        .filter((value) => value !== null),
      addresses: childrenNamed(node, `${prefix}_ADDRESS`)
        .map(address)
        .filter((value) => value !== null),
      programme: childText(node, "UN_LIST_TYPE"),
      legalBasis: null,
      listedOn,
      sourceUrl: LIST_URL,
    };
    return Result.ok(parsed);
  });

const FORMAT: XmlListFormat = {
  source: SOURCE,
  rootName: ROOT,
  layout: {
    [ROOT]: new Set(["INDIVIDUALS", "ENTITIES"]),
    INDIVIDUALS: new Set(["INDIVIDUAL"]),
    ENTITIES: new Set(["ENTITY"]),
  },
  recordNames: new Set(Object.keys(RECORDS)),
  toEntry: entry,
  toVersion: listVersion,
};

/**
 * Parses the UN Security Council consolidated list (XML) from a byte stream,
 * e.g. `Bun.file(path).stream()` or a fetch response body.
 */
export const parseUnList = (
  input: AsyncIterable<Uint8Array>,
): Promise<Result<ParsedList, SanctionsListParseError>> =>
  parseXmlList(FORMAT, input);

/** Reads the edition stamp at the start of a UN list and stops there. */
export const readUnListVersion = (
  input: AsyncIterable<Uint8Array>,
): Promise<Result<ListVersion, SanctionsListParseError>> =>
  readXmlListVersion(FORMAT, input);
