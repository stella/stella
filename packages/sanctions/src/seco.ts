import { Result } from "better-result";

import { countryFromIso } from "./countries";
import type {
  Address,
  AliasQuality,
  BirthDate,
  Country,
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
  parseSmallInteger,
} from "./values";
import {
  attribute,
  childText,
  childrenNamed,
  parseXmlList,
  readXmlListVersion,
} from "./xml";
import type { XmlListFormat, XmlNode } from "./xml";

const SOURCE = "ch";
const ROOT = "swiss-sanctions-list";
const PROGRAM = "sanctions-program";
const TARGET = "target";
const PLACE = "place";

type Programme = { name: string; legalBasis: string };
type Place = {
  city: string | null;
  region: string | null;
  country: Country | null;
};
type PendingAddress = { address: Address; placeId: string };

const englishText = (node: XmlNode, name: string): string | null =>
  childrenNamed(node, name)
    .find((child) => attribute(child, "lang") === "eng")
    ?.text.trim() || null;

const version = (
  root: Record<string, string>,
): Result<ListVersion, SanctionsListParseError> => {
  if (root["list-type"] !== "whole-list") {
    return Result.err(
      invalidValue(
        SOURCE,
        `expected a whole-list, found "${root["list-type"] ?? ""}"`,
      ),
    );
  }
  const date = root["date"];
  if (date === undefined) {
    return Result.err(missingField(SOURCE, `<${ROOT}> has no date`));
  }
  return isoDate(SOURCE, date).map((publishedAt) => ({
    source: SOURCE,
    publishedAt,
    fileId: null,
  }));
};

const aliasQuality = (node: XmlNode): AliasQuality => {
  const type = attribute(node, "name-type");
  if (type === null) {
    return "unknown";
  }
  switch (type) {
    case "primary-name":
    case "alias":
    case "formerly-known-as":
      break;
    default:
      return "unknown";
  }
  const quality = attribute(node, "quality");
  if (quality === null) {
    return "unknown";
  }
  switch (quality) {
    case "good":
      return "strong";
    case "low":
      return "weak";
    default:
      return "unknown";
  }
};

const nameSpellings = (node: XmlNode): string[] => {
  const parts = childrenNamed(node, "name-part").toSorted(
    (left, right) =>
      Number(attribute(left, "order")) - Number(attribute(right, "order")),
  );
  const base = parts.map((part) => childText(part, "value") ?? "");
  const joined = (values: readonly string[]) =>
    values.filter(Boolean).join(" ").trim();
  const spellings = [joined(base)];
  // Retain each published spelling variant without a Cartesian expansion of
  // independent part variants (some source names would exceed 1,000 forms).
  for (const [index, part] of parts.entries()) {
    for (const variant of childrenNamed(part, "spelling-variant")) {
      const text = variant.text.trim();
      if (text === "") {
        continue;
      }
      const values = [...base];
      values[index] = text;
      spellings.push(joined(values));
    }
  }
  return spellings.filter((name) => name !== "");
};

const birthDate = (
  node: XmlNode,
): Result<BirthDate | null, SanctionsListParseError> =>
  Result.gen(function* () {
    if (attribute(node, "calendar") !== "Gregorian") {
      return Result.err(
        invalidValue(SOURCE, "birth date has an unsupported calendar"),
      );
    }
    const yearText = attribute(node, "year");
    const monthText = attribute(node, "month");
    const dayText = attribute(node, "day");
    const circa = attribute(node, "quality") !== "good";
    const year =
      yearText === null ? null : yield* parseSmallInteger(SOURCE, yearText);
    const month =
      monthText === null ? null : yield* parseSmallInteger(SOURCE, monthText);
    const day =
      dayText === null ? null : yield* parseSmallInteger(SOURCE, dayText);
    if (month === null) {
      return Result.ok(
        year === null ? null : { precision: "year" as const, year, circa },
      );
    }
    if (month < 1 || month > 12) {
      return Result.err(invalidValue(SOURCE, `invalid birth month ${month}`));
    }
    if (day === null) {
      return Result.ok(
        year === null
          ? null
          : { precision: "month" as const, year, month, circa },
      );
    }
    const checked = yield* parseDayBirthDate(
      SOURCE,
      `${String(year ?? 2000).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      circa,
    );
    return Result.ok(
      year === null
        ? { precision: "month-day" as const, month, day, circa }
        : checked,
    );
  });

const identifierKind = (label: string): Identifier["kind"] => {
  switch (label) {
    case "passport":
    case "diplomatic-passport":
      return "passport";
    case "id-card":
      return "national-id";
    case "residence-permit":
    case "driving-license":
    case "travel-document":
    case "other":
      return "other";
    default:
      return "unknown";
  }
};

const identifier = (node: XmlNode): Identifier | null => {
  const number = childText(node, "number");
  if (number === null) {
    return null;
  }
  const label = attribute(node, "document-type") ?? "";
  const issuer = childrenNamed(node, "issuer").at(0);
  const countryName = issuer?.text.trim();
  const code = issuer === undefined ? null : attribute(issuer, "code");
  return {
    kind: identifierKind(label),
    status: "listed",
    label,
    number,
    country:
      countryName === undefined || countryName === ""
        ? null
        : countryFromIso(code, countryName),
  };
};

const targetType = (node: XmlNode): EntityType => {
  if (childrenNamed(node, "individual").length > 0) {
    return "person";
  }
  if (childrenNamed(node, "entity").length > 0) {
    return "organisation";
  }
  const object = childrenNamed(node, "object").at(0);
  if (object !== undefined) {
    const objectType = attribute(object, "object-type");
    if (objectType === null) {
      return "unknown";
    }
    switch (objectType) {
      case "vessel":
        return "vessel";
      case "aircraft":
        return "aircraft";
      default:
        return "unknown";
    }
  }
  return "unknown";
};

const sourceUrl = SANCTIONS_SOURCES.ch.download.urls[0];

type ReadState = {
  programmes: Map<string, Programme>;
  places: Map<string, Place>;
  pending: PendingAddress[];
  seenTargets: Set<string>;
};

const readProgramme = (
  record: XmlNode,
  programmes: Map<string, Programme>,
): Result<null, SanctionsListParseError> => {
  const programme = englishText(record, "program-key");
  const ordinance = englishText(record, "program-name");
  const set = childrenNamed(record, "sanctions-set").find(
    (item) => attribute(item, "lang") === "eng",
  );
  const setId = set === undefined ? null : attribute(set, "ssid");
  if (
    programme === null ||
    ordinance === null ||
    set === undefined ||
    setId === null
  ) {
    return Result.err(
      missingField(SOURCE, "sanctions programme lacks English metadata"),
    );
  }
  programmes.set(setId, {
    name: programme,
    legalBasis: `${ordinance}: ${set.text.trim()}`,
  });
  return Result.ok(null);
};

const readPlace = (
  record: XmlNode,
  places: Map<string, Place>,
): Result<null, SanctionsListParseError> => {
  const id = attribute(record, "ssid");
  if (id === null) {
    return Result.err(missingField(SOURCE, "place has no ssid"));
  }
  const country = childrenNamed(record, "country").at(0);
  const countryName = country?.text.trim();
  places.set(id, {
    city: childText(record, "location"),
    region: childText(record, "area"),
    country:
      country === undefined || countryName === undefined || countryName === ""
        ? null
        : countryFromIso(attribute(country, "iso-code"), countryName),
  });
  return Result.ok(null);
};

const targetModification = (
  record: XmlNode,
  sourceId: string,
): Result<"active" | "delisted", SanctionsListParseError> => {
  const latest = childrenNamed(record, "modification").at(0);
  if (latest === undefined) {
    return Result.err(
      missingField(SOURCE, `target ${sourceId} has no modification`),
    );
  }
  // The source orders modifications newest first; the whole-list XML also
  // retains delisted history that must not enter the screening index.
  const type = attribute(latest, "modification-type");
  switch (type) {
    case "de-listed":
      return Result.ok("delisted");
    case "listed":
    case "amended":
      return Result.ok("active");
    case null:
      return Result.err(
        invalidValue(SOURCE, `target ${sourceId} has no modification type`),
      );
    default:
      return Result.err(
        invalidValue(
          SOURCE,
          `target ${sourceId} has an unknown modification type`,
        ),
      );
  }
};

const targetProgrammes = (
  record: XmlNode,
  sourceId: string,
  programmes: Map<string, Programme>,
): Result<Programme[], SanctionsListParseError> => {
  const setIds = childrenNamed(record, "sanctions-set-id")
    .map((set) => set.text.trim())
    .filter((id) => id !== "");
  if (setIds.length === 0) {
    return Result.err(
      missingField(SOURCE, `target ${sourceId} has no sanctions set`),
    );
  }
  const associated: Programme[] = [];
  for (const setId of setIds) {
    const programme = programmes.get(setId);
    if (programme === undefined) {
      return Result.err(
        invalidValue(
          SOURCE,
          `target ${sourceId} refers to unknown sanctions set ${setId}`,
        ),
      );
    }
    associated.push(programme);
  }
  return Result.ok(associated);
};

const targetNames = (
  identities: XmlNode[],
  sourceId: string,
): Result<SanctionsName[], SanctionsListParseError> => {
  const names: SanctionsName[] = [];
  const positions = new Map<string, number>();
  for (const identity of identities) {
    for (const name of childrenNamed(identity, "name")) {
      const quality = aliasQuality(name);
      for (const spelling of nameSpellings(name)) {
        const position = positions.get(spelling);
        if (position !== undefined) {
          const previous = names[position];
          if (quality === "strong" && previous !== undefined) {
            previous.quality = "strong";
          }
          continue;
        }
        positions.set(spelling, names.length);
        names.push({ name: spelling, quality });
      }
    }
  }
  if (names.length === 0) {
    return Result.err(missingField(SOURCE, `target ${sourceId} has no name`));
  }
  return Result.ok(names);
};

const identityAddresses = (
  identity: XmlNode,
  pending: PendingAddress[],
): Address[] => {
  const addresses: Address[] = [];
  for (const location of childrenNamed(identity, "address")) {
    const placeId = attribute(location, "place-id");
    const street =
      [
        childText(location, "c-o"),
        childText(location, "address-details"),
        childText(location, "p-o-box"),
      ]
        .filter((part) => part !== null)
        .join(", ") || null;
    const address: Address = {
      street,
      city: null,
      region: null,
      postalCode: childText(location, "zip-code"),
      country: null,
    };
    addresses.push(address);
    if (placeId !== null) {
      pending.push({ address, placeId });
    }
  }
  return addresses;
};

type IdentityDetails = Pick<
  SanctionsEntry,
  "birthDates" | "nationalities" | "identifiers" | "addresses"
>;

const identityDetails = (
  identities: XmlNode[],
  isIndividual: boolean,
  pending: PendingAddress[],
): Result<IdentityDetails, SanctionsListParseError> =>
  Result.gen(function* () {
    const birthDates: BirthDate[] = [];
    const nationalities: Country[] = [];
    const identifiers: Identifier[] = [];
    const addresses: Address[] = [];
    for (const identity of identities) {
      if (isIndividual) {
        for (const date of childrenNamed(identity, "day-month-year")) {
          const parsed = yield* birthDate(date);
          if (parsed !== null) {
            birthDates.push(parsed);
          }
        }
        for (const nationality of childrenNamed(identity, "nationality")) {
          const country = childrenNamed(nationality, "country").at(0);
          const name = country?.text.trim();
          if (country !== undefined && name !== undefined && name !== "") {
            nationalities.push(
              countryFromIso(attribute(country, "iso-code"), name),
            );
          }
        }
        for (const document of childrenNamed(
          identity,
          "identification-document",
        )) {
          const parsed = identifier(document);
          if (parsed !== null) {
            identifiers.push(parsed);
          }
        }
      }
      addresses.push(...identityAddresses(identity, pending));
    }
    return Result.ok({ birthDates, nationalities, identifiers, addresses });
  });

const targetListedOn = (
  record: XmlNode,
): Result<string | null, SanctionsListParseError> => {
  const listed = childrenNamed(record, "modification").find(
    (item) => attribute(item, "modification-type") === "listed",
  );
  const date =
    listed === undefined
      ? null
      : (attribute(listed, "effective-date") ??
        attribute(listed, "publication-date") ??
        attribute(listed, "enactment-date"));
  return date === null ? Result.ok(null) : isoDate(SOURCE, date);
};

const readTarget = (
  record: XmlNode,
  state: ReadState,
): Result<SanctionsEntry | null, SanctionsListParseError> =>
  Result.gen(function* () {
    const sourceId = attribute(record, "ssid");
    if (sourceId === null) {
      return Result.err(missingField(SOURCE, "target has no ssid"));
    }
    if (state.seenTargets.has(sourceId)) {
      return Result.err(
        invalidValue(SOURCE, `duplicate target ssid ${sourceId}`),
      );
    }
    state.seenTargets.add(sourceId);
    if ((yield* targetModification(record, sourceId)) === "delisted") {
      return Result.ok(null);
    }
    const associated = yield* targetProgrammes(
      record,
      sourceId,
      state.programmes,
    );
    const subject = record.children.find(
      (child) =>
        child.name === "individual" ||
        child.name === "entity" ||
        child.name === "object",
    );
    if (subject === undefined) {
      return Result.err(
        missingField(SOURCE, `target ${sourceId} has no subject`),
      );
    }
    const identities = childrenNamed(subject, "identity");
    const names = yield* targetNames(identities, sourceId);
    const details = yield* identityDetails(
      identities,
      subject.name === "individual",
      state.pending,
    );
    const listedOn = yield* targetListedOn(record);
    return Result.ok({
      source: SOURCE,
      issuer: SANCTIONS_SOURCES.ch.issuer,
      sourceId,
      referenceNumber: sourceId,
      entityType: targetType(record),
      names,
      ...details,
      programme: [...new Set(associated.map((item) => item.name))].join("; "),
      legalBasis: [...new Set(associated.map((item) => item.legalBasis))].join(
        "; ",
      ),
      listedOn,
      sourceUrl,
    } satisfies SanctionsEntry);
  });

const finishPlaces = (
  state: ReadState,
): Result<void, SanctionsListParseError> => {
  for (const { address, placeId } of state.pending) {
    const place = state.places.get(placeId);
    if (place === undefined) {
      return Result.err(
        invalidValue(SOURCE, `address refers to unknown place ${placeId}`),
      );
    }
    address.city = place.city;
    address.region = place.region;
    address.country = place.country;
  }
  return Result.ok();
};

const formatForRead = (): {
  format: XmlListFormat;
  finish: () => Result<void, SanctionsListParseError>;
} => {
  const state: ReadState = {
    programmes: new Map(),
    places: new Map(),
    pending: [],
    seenTargets: new Set(),
  };
  const toEntry = (record: XmlNode) => {
    switch (record.name) {
      case PROGRAM:
        return readProgramme(record, state.programmes);
      case PLACE:
        return readPlace(record, state.places);
      case TARGET:
        return readTarget(record, state);
      default:
        return Result.err(
          invalidValue(SOURCE, `unexpected record <${record.name}>`),
        );
    }
  };
  const format: XmlListFormat = {
    source: SOURCE,
    rootName: ROOT,
    layout: { [ROOT]: new Set([PROGRAM, TARGET, PLACE]) },
    recordNames: new Set([PROGRAM, TARGET, PLACE]),
    toEntry,
    toVersion: version,
  };
  return { format, finish: () => finishPlaces(state) };
};

/** Parses SECO's whole-list XML, excluding the delisted history it retains. */
export const parseSecoList = async (input: AsyncIterable<Uint8Array>) => {
  const { format, finish } = formatForRead();
  const parsed = await parseXmlList(format, input);
  return parsed.andThen((list) => finish().map(() => list));
};

export const readSecoListVersion = async (input: AsyncIterable<Uint8Array>) =>
  readXmlListVersion(formatForRead().format, input);
