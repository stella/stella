import { trimToNull } from "../shared/strings.js";
import type {
  RpoAddress,
  RpoCodedValue,
  RpoDated,
  RpoEntity,
  RpoMoney,
  RpoPerson,
  RpoRawAddress,
  RpoRawCodeValue,
  RpoRawEntity,
  RpoRawEquity,
  RpoRawPersonName,
  RpoRawRelatedEntity,
  RpoRawSearchHit,
  RpoRawSourceRegister,
  RpoRawStakeholder,
  RpoRawTimed,
  RpoRawTimedValue,
  RpoRelatedEntity,
  RpoSearchResult,
  RpoSourceRegister,
  RpoStatus,
} from "./types.js";

const ENTITY_URL_BASE = "https://api.statistics.sk/rpo/v1/entity/";

// Codelist CL000086 carries ISO 3166-1 numeric codes; 703 is Slovakia.
const SLOVAKIA_COUNTRY_CODE = "703";

// Codelist CL010108 item 1 ("Bez záznamu") states that no legal-status note
// is on file, so it is not a status worth surfacing.
const NO_LEGAL_STATUS_CODE = "1";

// `validTo` is absent on records in force; sort those as the newest.
const OPEN_END = "9999-12-31";

const MULTI_SPACE_PATTERN = /\s+/gu;
const POSTAL_CODE_SPACES = /\s/gu;

const collapse = (value: string | null | undefined): string | null =>
  trimToNull(value?.replaceAll(MULTI_SPACE_PATTERN, " "));

const isOpen = (record: RpoRawTimed): boolean => record.validTo === undefined;

const compareNewestFirst = (a: RpoRawTimed, b: RpoRawTimed): number => {
  const byEnd = (b.validTo ?? OPEN_END).localeCompare(a.validTo ?? OPEN_END);
  return byEnd === 0
    ? (b.validFrom ?? "").localeCompare(a.validFrom ?? "")
    : byEnd;
};

const newestFirst = <T extends RpoRawTimed>(records: T[] | undefined): T[] =>
  (records ?? []).toSorted(compareNewestFirst);

// The record in force, or, once the entity has ended and every record is
// closed, the last one that was.
const pickCurrentOrLatest = <T extends RpoRawTimed>(
  records: T[] | undefined,
): T | null => newestFirst(records).at(0) ?? null;

const currentRecords = <T extends RpoRawTimed>(records: T[] | undefined): T[] =>
  newestFirst(records).filter(isOpen);

const dated = <Value>(record: RpoRawTimed, value: Value): RpoDated<Value> => ({
  value,
  validFrom: record.validFrom ?? null,
  validTo: record.validTo ?? null,
});

const codedValue = (raw: RpoRawCodeValue | undefined): RpoCodedValue | null => {
  const label = collapse(raw?.value);
  return label ? { code: raw?.code ?? null, label } : null;
};

const formatPostalCode = (
  raw: string | undefined,
  slovak: boolean,
): string | null => {
  const compacted = raw?.replaceAll(POSTAL_CODE_SPACES, "") ?? "";
  if (compacted.length === 0) {
    return null;
  }
  // Slovak postal codes are five digits written `DDD DD`; foreign codes keep
  // the register's spelling.
  if (slovak && /^\d{5}$/u.test(compacted)) {
    return `${compacted.slice(0, 3)} ${compacted.slice(3)}`;
  }
  return trimToNull(raw);
};

// Slovak house numbers pair the land-register number (súpisné) with the
// street number (orientačné) as `súpisné/orientačné`; the API reports an
// absent land-register number as 0.
const formatHouseNumber = (raw: RpoRawAddress): string | null => {
  const building = trimToNull(raw.buildingNumber);
  const registration =
    raw.regNumber !== undefined && raw.regNumber > 0
      ? String(raw.regNumber)
      : null;
  if (registration && building) {
    return building.includes("/") ? building : `${registration}/${building}`;
  }
  return building ?? registration;
};

export const parseAddress = (raw: RpoRawAddress): RpoAddress => {
  const countryCode = raw.country?.code ?? null;
  const country = collapse(raw.country?.value);
  const slovak = countryCode === null || countryCode === SLOVAKIA_COUNTRY_CODE;
  const city = collapse(raw.municipality?.value);
  const house = formatHouseNumber(raw);
  // Villages without street names number their houses within the village.
  const streetName = collapse(raw.street) ?? (house ? city : null);
  const street = [streetName, house].filter(Boolean).join(" ") || null;
  const postalCode = formatPostalCode(raw.postalCodes?.at(0), slovak);
  const cityLine = [postalCode, city].filter(Boolean).join(" ") || null;
  const textAddress =
    [street, cityLine, country].filter(Boolean).join(", ") ||
    collapse(raw.formatedAddress);
  return { street, postalCode, city, country, textAddress };
};

const formatPersonName = (raw: RpoRawPersonName): string | null => {
  const formatted = collapse(raw.formatedName);
  if (formatted) {
    return formatted;
  }
  const prefixes = (raw.prefixes ?? []).map((item) => collapse(item.value));
  const postfixes = (raw.postfixes ?? [])
    .map((item) => collapse(item.value))
    .filter(Boolean);
  const core = [
    ...prefixes,
    ...(raw.givenNames ?? []).map(collapse),
    ...(raw.familyNames ?? []).map(collapse),
  ]
    .filter(Boolean)
    .join(" ");
  if (!core) {
    return null;
  }
  return postfixes.length > 0 ? `${core}, ${postfixes.join(" ")}` : core;
};

const parsePerson = (raw: RpoRawStakeholder): RpoPerson | null => {
  const name =
    collapse(raw.fullName) ??
    (raw.personName ? formatPersonName(raw.personName) : null);
  if (!name) {
    return null;
  }
  return {
    name,
    organName: collapse(raw.stakeholderType?.value),
    position: collapse(raw.statutoryBodyMember?.value),
    identifier: trimToNull(raw.identifier),
    address: raw.address ? parseAddress(raw.address).textAddress : null,
    validFrom: raw.validFrom ?? null,
    validTo: raw.validTo ?? null,
  };
};

const parsePeople = (raws: RpoRawStakeholder[] | undefined): RpoPerson[] =>
  newestFirst(raws)
    .map(parsePerson)
    .filter((person) => person !== null);

const parseTexts = (raws: RpoRawTimedValue[] | undefined): RpoDated<string>[] =>
  newestFirst(raws).flatMap((raw) => {
    const value = collapse(raw.value);
    return value ? [dated(raw, value)] : [];
  });

// Share capital and its paid-up portion arrive as separate equity records.
const pickMoney = (
  raws: RpoRawEquity[] | undefined,
  field: "value" | "valuePaid",
): RpoMoney | null => {
  const record = pickCurrentOrLatest(
    (raws ?? []).filter((raw) => raw[field] !== undefined),
  );
  const amount = record?.[field];
  if (record === null || amount === undefined) {
    return null;
  }
  return { amount, currency: record.currency?.code ?? null };
};

const parseSourceRegister = (
  raw: RpoRawSourceRegister | undefined,
): RpoSourceRegister | null => {
  const register = codedValue(raw?.value);
  if (!register) {
    return null;
  }
  return {
    name: register.label,
    code: register.code,
    registrationOffice: collapse(
      pickCurrentOrLatest(raw?.registrationOffices)?.value,
    ),
    registrationNumber: collapse(
      pickCurrentOrLatest(raw?.registrationNumbers)?.value,
    ),
  };
};

const parseRelated = (
  raws: RpoRawRelatedEntity[] | undefined,
): RpoRelatedEntity[] =>
  newestFirst(raws).flatMap((raw) => {
    const name = collapse(raw.fullName);
    return name
      ? [
          {
            ico: trimToNull(raw.identifier),
            name,
            validFrom: raw.validFrom ?? null,
          },
        ]
      : [];
  });

const parseStatus = (termination: string | undefined): RpoStatus => {
  const terminatedAt = trimToNull(termination);
  return terminatedAt
    ? { type: "terminated", terminatedAt }
    : { type: "active" };
};

type NameAndHistory = {
  name: string | null;
  formerNames: RpoDated<string>[];
};

const parseNames = (raws: RpoRawTimedValue[] | undefined): NameAndHistory => {
  const names = parseTexts(raws);
  const [first, ...rest] = names;
  if (first === undefined) {
    return { name: null, formerNames: [] };
  }
  return { name: first.value, formerNames: rest };
};

const parseAddresses = (
  raws: RpoRawAddress[] | undefined,
): { address: RpoAddress | null; formerAddresses: RpoDated<RpoAddress>[] } => {
  const [first, ...rest] = newestFirst(raws);
  return {
    address: first ? parseAddress(first) : null,
    formerAddresses: rest.map((raw) => dated(raw, parseAddress(raw))),
  };
};

const pickIco = (hit: RpoRawSearchHit): string | null =>
  trimToNull(pickCurrentOrLatest(hit.identifiers)?.value);

export const entityUrl = (rpoId: number): string =>
  `${ENTITY_URL_BASE}${encodeURIComponent(String(rpoId))}`;

/**
 * Parse an `/entity/{id}` payload into the domain shape.
 *
 * Returns `null` when the record carries no IČO or no name at all. A record
 * of a terminated entity requested with the `current` view carries neither
 * name nor seat (every such record is closed); the client merges the name
 * and seat history from the search hit before parsing.
 */
export const parseEntity = (raw: RpoRawEntity): RpoEntity | null => {
  const ico = pickIco(raw);
  const { name, formerNames } = parseNames(raw.fullNames);
  if (!ico || !name) {
    return null;
  }
  const status = parseStatus(raw.termination);
  const { address, formerAddresses } = parseAddresses(raw.addresses);
  return {
    ico,
    name,
    formerNames,
    legalForm: codedValue(pickCurrentOrLatest(raw.legalForms)?.value),
    address,
    formerAddresses,
    establishedAt: trimToNull(raw.establishment),
    terminatedAt: status.type === "terminated" ? status.terminatedAt : null,
    status,
    legalStatuses: currentRecords(raw.legalStatuses).flatMap((record) => {
      const label = collapse(record.value?.value);
      return label && record.value?.code !== NO_LEGAL_STATUS_CODE
        ? [label]
        : [];
    }),
    sourceRegister: parseSourceRegister(raw.sourceRegister),
    statutoryBodies: parsePeople(raw.statutoryBodies),
    stakeholders: parsePeople(raw.stakeholders),
    authorizations: parseTexts(raw.authorizations),
    shareCapital: pickMoney(raw.equities, "value"),
    shareCapitalPaid: pickMoney(raw.equities, "valuePaid"),
    activities: newestFirst(raw.activities).flatMap((activity) => {
      const description = collapse(activity.economicActivityDescription);
      return description ? [dated(activity, description)] : [];
    }),
    mainActivity: codedValue(raw.statisticalCodes?.mainActivity),
    predecessors: parseRelated(raw.predecessors),
    successors: parseRelated(raw.successors),
    registryUrl: entityUrl(raw.id),
  };
};

/** Parse one `/search` row. Returns `null` for a row without IČO or name. */
export const parseSearchHit = (
  hit: RpoRawSearchHit,
): RpoSearchResult | null => {
  const ico = pickIco(hit);
  const { name } = parseNames(hit.fullNames);
  if (!ico || !name) {
    return null;
  }
  const address = pickCurrentOrLatest(hit.addresses);
  return {
    rpoId: hit.id,
    ico,
    name,
    address: address ? parseAddress(address).textAddress : null,
    sourceRegister: collapse(hit.sourceRegister?.value?.value),
    status: parseStatus(hit.termination),
  };
};
