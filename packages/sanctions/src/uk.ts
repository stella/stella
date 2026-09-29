import { Result } from "better-result";

import { countryFromName } from "./countries";
import type {
  Address,
  AliasQuality,
  BirthDate,
  EntityType,
  Identifier,
  ListVersion,
  SanctionsEntry,
  SanctionsListParseError,
  SanctionsName,
} from "./entry";
import { SANCTIONS_SOURCES } from "./sources";
import {
  invalidValue,
  isoDate,
  missingField,
  parseDayBirthDate,
} from "./values";
import {
  childText,
  childrenNamed,
  parseXmlList,
  readXmlListVersion,
} from "./xml";
import type { XmlListFormat, XmlNode } from "./xml";

const SOURCE = "uk";
const ROOT = "Designations";
const RECORD = "Designation";
const METADATA = "DateGenerated";
const NAME_PARTS = ["Name1", "Name2", "Name3", "Name4", "Name5", "Name6"];
const ADDRESS_LINES = [
  "AddressLine1",
  "AddressLine2",
  "AddressLine3",
  "AddressLine4",
  "AddressLine5",
  "AddressLine6",
];
const UK_DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/u;
const UK_BIRTH_DATE = /^(\d{2}|dd)\/(\d{2}|mm)\/(\d{4}|yyyy)$/u;
const YEAR = /^\d{4}$/u;
const CENTURY = /^(?:(?:\d{2}|dd)\/(?:\d{2}|mm)\/)?(\d{2})yy$/u;

const nested = (node: XmlNode, ...names: string[]): XmlNode[] => {
  let nodes = [node];
  for (const name of names) {
    nodes = nodes.flatMap((parent) => childrenNamed(parent, name));
  }
  return nodes;
};

const ukDate = (value: string): Result<string, SanctionsListParseError> => {
  const match = UK_DATE.exec(value);
  if (match === null) {
    return Result.err(invalidValue(SOURCE, `invalid UK list date "${value}"`));
  }
  const [, day, month, year] = match;
  if (day === undefined || month === undefined || year === undefined) {
    return Result.err(invalidValue(SOURCE, `invalid UK list date "${value}"`));
  }
  return isoDate(SOURCE, `${year}-${month}-${day}`);
};

const version = (
  _root: Record<string, string>,
  metadata: XmlNode | null,
): Result<ListVersion, SanctionsListParseError> => {
  const date = metadata?.text.trim();
  if (date === undefined || date === "") {
    return Result.err(missingField(SOURCE, `<${ROOT}> has no ${METADATA}`));
  }
  return ukDate(date).map((publishedAt) => ({
    source: SOURCE,
    publishedAt,
    fileId: null,
  }));
};

/**
 * A date part the list states, or null for one it leaves unknown: the list
 * writes unknown parts as letters ("dd/mm/1975") or as zeros ("00/00/1975").
 */
const knownPart = (text: string): number | null => {
  const value = /^\d+$/u.test(text) ? Number(text) : 0;
  return value === 0 ? null : value;
};

/**
 * A listed birth date at the precision the list states it. A date without a
 * known year gives screening nothing to compare, so it is left out rather
 * than read as the year 0.
 */
const birthDate = (
  value: string,
): Result<BirthDate | null, SanctionsListParseError> => {
  if (YEAR.test(value)) {
    const year = knownPart(value);
    return Result.ok(
      year === null ? null : { precision: "year", year, circa: false },
    );
  }
  const century = CENTURY.exec(value);
  if (century !== null) {
    const hundreds = knownPart(century[1] ?? "");
    if (hundreds === null) {
      return Result.ok(null);
    }
    const firstYear = hundreds * 10 ** 2;
    return Result.ok({
      precision: "year-range",
      fromYear: firstYear,
      toYear: firstYear + 99,
      circa: false,
    });
  }
  const parts = UK_BIRTH_DATE.exec(value);
  const [, dayText, monthText, yearText] = parts ?? [];
  if (
    dayText === undefined ||
    monthText === undefined ||
    yearText === undefined
  ) {
    return Result.err(invalidValue(SOURCE, `invalid UK birth date "${value}"`));
  }
  const year = knownPart(yearText);
  const month = knownPart(monthText);
  const day = knownPart(dayText);
  if (year === null) {
    return Result.ok(null);
  }
  if (month === null) {
    return Result.ok({ precision: "year", year, circa: false });
  }
  if (month > 12) {
    return Result.err(invalidValue(SOURCE, `invalid UK birth date "${value}"`));
  }
  if (day === null) {
    return Result.ok({ precision: "month", year, month, circa: false });
  }
  return parseDayBirthDate(
    SOURCE,
    `${yearText}-${monthText}-${dayText}`,
    false,
  );
};

const entityType = (value: string | null): EntityType => {
  switch (value) {
    case null:
      return "unknown";
    case "Individual":
      return "person";
    case "Entity":
      return "organisation";
    case "Ship":
      return "vessel";
    default:
      return "unknown";
  }
};

const nameQuality = (node: XmlNode): AliasQuality => {
  const type = childText(node, "NameType")?.toLowerCase();
  switch (type) {
    case "primary name":
    case "primary name variation":
      return "strong";
    case "alias":
      break;
    case undefined:
      return "unknown";
    default:
      return "unknown";
  }
  const strength = childText(node, "AliasStrength");
  if (strength === null) {
    return "unknown";
  }
  switch (strength) {
    case "Good quality a.k.a":
      return "strong";
    case "Low quality a.k.a":
      return "weak";
    default:
      return "unknown";
  }
};

const nameText = (node: XmlNode): string | null =>
  NAME_PARTS.map((part) => childText(node, part))
    .filter((part) => part !== null)
    .join(" ") || null;

const address = (node: XmlNode): Address | null => {
  const street =
    ADDRESS_LINES.map((part) => childText(node, part))
      .filter((part) => part !== null)
      .join(", ") || null;
  const postalCode = childText(node, "AddressPostalCode");
  const countryName = childText(node, "AddressCountry");
  if (street === null && postalCode === null && countryName === null) {
    return null;
  }
  return {
    street,
    city: null,
    region: null,
    postalCode,
    country: countryName === null ? null : countryFromName(countryName),
  };
};

const identifier = (
  kind: Identifier["kind"],
  label: string,
  number: string,
): Identifier => ({
  kind,
  status: "listed",
  label,
  number,
  country: null,
});

const entry = (
  node: XmlNode,
): Result<SanctionsEntry, SanctionsListParseError> =>
  Result.gen(function* () {
    const sourceId = childText(node, "UniqueID");
    if (sourceId === null) {
      return Result.err(missingField(SOURCE, `<${RECORD}> has no UniqueID`));
    }
    const names: SanctionsName[] = [];
    const positions = new Map<string, number>();
    const addName = (name: string | null, quality: AliasQuality) => {
      if (name === null) {
        return;
      }
      const position = positions.get(name);
      if (position !== undefined) {
        if (quality === "strong") {
          const existing = names[position];
          if (existing !== undefined) {
            existing.quality = "strong";
          }
        }
        return;
      }
      positions.set(name, names.length);
      names.push({ name, quality });
    };
    const listedNames = nested(node, "Names", "Name");
    for (const name of listedNames.filter(
      (item) => childText(item, "NameType")?.toLowerCase() === "primary name",
    )) {
      addName(nameText(name), "strong");
    }
    for (const name of listedNames) {
      addName(nameText(name), nameQuality(name));
    }
    for (const name of nested(node, "NonLatinNames", "NonLatinName")) {
      addName(childText(name, "NameNonLatinScript"), "strong");
    }
    if (names.length === 0) {
      return Result.err(missingField(SOURCE, `entry ${sourceId} has no name`));
    }

    const birthDates: BirthDate[] = [];
    for (const date of nested(
      node,
      "IndividualDetails",
      "Individual",
      "DOBs",
      "DOB",
    )) {
      const value = date.text.trim();
      const parsed = value === "" ? null : yield* birthDate(value);
      if (parsed !== null) {
        birthDates.push(parsed);
      }
    }

    const identifiers: Identifier[] = [];
    for (const passport of nested(
      node,
      "IndividualDetails",
      "Individual",
      "PassportDetails",
      "Passport",
    )) {
      const number = childText(passport, "PassportNumber");
      if (number !== null) {
        identifiers.push(identifier("passport", "Passport", number));
      }
    }
    for (const nationalId of nested(
      node,
      "IndividualDetails",
      "Individual",
      "NationalIdentifierDetails",
      "NationalIdentifier",
    )) {
      for (const number of childrenNamed(
        nationalId,
        "NationalIdentifierNumber",
      )) {
        if (number.text.trim() !== "") {
          identifiers.push(
            identifier(
              "national-id",
              "National identifier",
              number.text.trim(),
            ),
          );
        }
      }
    }
    for (const registration of nested(
      node,
      "EntityDetails",
      "Entity",
      "BusinessRegistrationNumbers",
      "BusinessRegistrationNumber",
    )) {
      if (registration.text.trim() !== "") {
        identifiers.push(
          identifier(
            "registration",
            "Business registration number",
            registration.text.trim(),
          ),
        );
      }
    }
    for (const imo of nested(
      node,
      "ShipDetails",
      "Ship",
      "IMONumbers",
      "IMONumber",
    )) {
      if (imo.text.trim() !== "") {
        identifiers.push(identifier("imo", "IMO number", imo.text.trim()));
      }
    }
    for (const wallet of nested(
      node,
      "CryptoWalletAddresses",
      "CryptoWalletAddress",
    )) {
      if (wallet.text.trim() !== "") {
        identifiers.push(
          identifier("other", "Crypto wallet address", wallet.text.trim()),
        );
      }
    }

    const designated = childText(node, "DateDesignated");
    return Result.ok({
      source: SOURCE,
      issuer: SANCTIONS_SOURCES.uk.issuer,
      sourceId,
      referenceNumber:
        childText(node, "OFSIGroupID") ?? childText(node, "UNReferenceNumber"),
      entityType: entityType(childText(node, "IndividualEntityShip")),
      names,
      birthDates,
      nationalities: nested(
        node,
        "IndividualDetails",
        "Individual",
        "Nationalities",
        "Nationality",
      )
        .map((nationality) => nationality.text.trim())
        .filter((nationality) => nationality !== "")
        .map(countryFromName),
      identifiers,
      addresses: nested(node, "Addresses", "Address")
        .map(address)
        .filter((value) => value !== null),
      programme: childText(node, "RegimeName"),
      legalBasis: null,
      listedOn: designated === null ? null : yield* ukDate(designated),
      sourceUrl: SANCTIONS_SOURCES.uk.download.urls[0],
    } satisfies SanctionsEntry);
  });

const format: XmlListFormat = {
  source: SOURCE,
  rootName: ROOT,
  layout: { [ROOT]: new Set([METADATA, RECORD]) },
  recordNames: new Set([RECORD]),
  metadataName: METADATA,
  toEntry: entry,
  toVersion: version,
};

/** Parses the current UK Sanctions List XML, one designation at a time. */
export const parseUkList = async (input: AsyncIterable<Uint8Array>) =>
  parseXmlList(format, input);

export const readUkListVersion = async (input: AsyncIterable<Uint8Array>) =>
  readXmlListVersion(format, input);
