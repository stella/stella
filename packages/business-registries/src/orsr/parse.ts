import type {
  OrsrAddress,
  OrsrCompany,
  OrsrCompanyStatus,
  OrsrCourtFile,
  OrsrRawAddress,
  OrsrRawCodelistItem,
  OrsrRawCodelistRef,
  OrsrRawCorporateBody,
  OrsrRawDeposit,
  OrsrRawExtractResponse,
  OrsrRawFileReference,
  OrsrRawLegalForm,
  OrsrRawLegalPerson,
  OrsrRawSearchHit,
  OrsrRawStakeholderMember,
  OrsrRawStatutoryBodyMember,
  OrsrRawTemporal,
  OrsrRawValueTemporal,
  OrsrRawWrappedCodelist,
  OrsrSearchResult,
  OrsrStakeholder,
  OrsrStatutoryBody,
  OrsrStatutoryMember,
} from "./types.js";

// Stakeholder `itemCode` → (organ heading, role label). Slovak entries
// arrive with the codelist identifier in `stakeholderType.item.codelistItem.itemCode`;
// the matching display strings are the same wording used by the official
// `sluzby.orsr.sk` portal so downstream UIs render the labels users see.
const STAKEHOLDER_TYPE_MAPPING: Record<string, [string, string]> = {
  Spolocnik: ["Spoločníci", "Spoločník"],
  Akcionar: ["Akcionár", "Akcionár"],
  Prokurista: ["Prokúra", "Prokúrista"],
  ClenDozornehoOrganu: ["Dozorná rada", "Člen dozornej rady"],
  Predchodca: ["Právny predchodca", "Právny predchodca"],
  ClenSpravnejRady: ["Spravná rada", "Člen správnej rady"],
  Komanditista: ["Spoločníci", "Komanditista"],
  Komplementar: ["Spoločníci", "Komplementár"],
  Likvidator: ["Likvidátor", "Likvidátor"],
  Zakladatel: ["Zakladatelia", "Zakladateľ"],
  VeduciOrganizacnejZlozky: [
    "Vedúci organizačnej zložky",
    "Vedúci organizačnej zložky",
  ],
};

const STATUTORY_BODY_ORGAN_NAME = "Štatutárny orgán";

// Country names that mean "Slovak Republic" in the upstream payload.
// Used to gate the `DDD DD` postal-code formatting so Czech / Hungarian
// addresses (which the registry sometimes carries for foreign-resident
// directors) keep their original format.
const SLOVAK_STATES = new Set([
  "Slovenská republika",
  "Slovensko",
  "Slovenská",
]);

// IČO identifier types appear in the upstream as a localized string; any
// of these substrings marks an IČO-typed identifier worth surfacing.
const ICO_IDENTIFIER_HINT = "IČO";

const SLOVAK_REGISTRY_URL =
  "https://sluzby.orsr.sk/Subjekt?oddiel={section}&vlozka={insertNumber}&sud={court}";

// XML→JSON round-trip leaves a sentinel timestamp on `effectiveTo` for
// records that are still in force; treat anything starting with `0001-`
// as "no end date" rather than coercing to a real date.
const SENTINEL_DATE_PREFIX = "0001-";

const MULTI_SPACE_PATTERN = /\s+/gu;

const isPresent = <T>(value: T | null | undefined): value is T =>
  value !== null && value !== undefined;

const isSentinelDate = (value: string | null | undefined): boolean =>
  typeof value === "string" && value.startsWith(SENTINEL_DATE_PREFIX);

const sentinelToNull = (value: string | null | undefined): string | null =>
  isPresent(value) && !isSentinelDate(value) ? value : null;

// Pick the first record marked `current: true`. For terminated entities
// the upstream sets every historical record's `current` flag back to
// false, so callers fall back to the latest historical entry instead.
const pickCurrent = <T extends OrsrRawTemporal>(
  records: T[] | undefined,
): T | null => {
  if (!records || records.length === 0) {
    return null;
  }
  return records.find((record) => record.current === true) ?? null;
};

const unwrapCodelist = (
  wrapped: OrsrRawWrappedCodelist | undefined,
): OrsrRawCodelistItem | null => {
  const item = wrapped?.item;
  if (item === undefined || typeof item === "string") {
    return null;
  }
  return item.codelistItem ?? null;
};

// `{item}` may be either a bare string (legalPerson.physicalAddress.country,
// legalPerson.physicalAddress.municipality) or a wrapped codelist
// (statutoryBody member addresses use the codelist form). Both surfaces
// resolve to the same display string.
const codelistItemName = (
  wrapped: OrsrRawWrappedCodelist | undefined,
): string | null => {
  const item = wrapped?.item;
  if (item === undefined) {
    return null;
  }
  if (typeof item === "string") {
    return item;
  }
  return item.codelistItem?.itemName ?? null;
};

const codelistItemCode = (
  wrapped: OrsrRawWrappedCodelist | undefined,
): string | null => unwrapCodelist(wrapped)?.itemCode ?? null;

const legalFormName = (form: OrsrRawLegalForm): string | null =>
  form.item?.codelistItem?.itemName ?? null;

// Currency arrives in two shapes: as a bare string (`{item: "EUR"}`) or
// as a wrapped codelist (`{item: {codelistItem: {itemName: "EUR"}}}`).
const currencyName = (
  currency: { item?: OrsrRawCodelistRef | string } | undefined,
): string | null => {
  const item = currency?.item;
  if (item === undefined) {
    return null;
  }
  if (typeof item === "string") {
    return item;
  }
  return item.codelistItem?.itemName ?? null;
};

// Render `140000` + currency "EUR" as "140 000 EUR" — the Slovak
// thousands separator is U+00A0 (non-breaking space). Used for both
// the entity-level share capital and per-shareholder deposits.
const formatMonetary = (
  value: number | null | undefined,
  currency: string | null,
): string | null => {
  if (!isPresent(value)) {
    return null;
  }
  const formatter = new Intl.NumberFormat("sk-SK", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
  const amount = formatter.format(value);
  return currency ? `${amount} ${currency}` : amount;
};

const formatSlovakPostalCode = (
  postalCode: string | null,
  country: string | null,
): string | null => {
  if (!postalCode || postalCode.length !== 5) {
    return postalCode;
  }
  // Slovak postal codes are exclusively 5 digits → `DDD DD`. If the
  // address carries no country at all assume Slovak (most upstream
  // addresses do); foreign-country addresses keep their original
  // formatting.
  const treatAsSlovak = country === null || SLOVAK_STATES.has(country);
  if (!treatAsSlovak) {
    return postalCode;
  }
  return `${postalCode.slice(0, 3)} ${postalCode.slice(3)}`;
};

export const parseAddress = (raw: OrsrRawAddress): OrsrAddress => {
  const street = raw.streetName ?? null;
  const buildingNumber = raw.buildingNumber ?? null;
  const propertyNumber = raw.propertyRegistrationNumber ?? null;
  const country = codelistItemName(raw.country);
  const municipality = codelistItemName(raw.municipality);
  const postalCode = formatSlovakPostalCode(
    raw.deliveryAddress?.postalCode ?? null,
    country,
  );

  // Slovak addresses use either bare `buildingNumber` or the slash
  // form `súpisné/orientačné` — render both atoms when present.
  const houseSegment = [propertyNumber, buildingNumber]
    .filter(isPresent)
    .join("/");

  const streetLine = [street, houseSegment].filter(Boolean).join(" ");
  const cityLine = [postalCode, municipality].filter(isPresent).join(" ");

  const textParts = [streetLine || null, cityLine || null, country].filter(
    isPresent,
  );
  const textAddress = textParts.length > 0 ? textParts.join(", ") : null;

  return {
    street: streetLine || null,
    postalCode,
    city: municipality,
    country,
    textAddress,
  };
};

const parseCourtFile = (
  ref: OrsrRawFileReference | undefined,
): OrsrCourtFile | null => {
  if (!ref) {
    return null;
  }
  const { section, insertNumber, court } = ref;
  if (!section || insertNumber === undefined || !court) {
    return null;
  }
  return {
    court,
    section,
    insertNumber: String(insertNumber),
  };
};

const buildRegistryUrl = (file: OrsrCourtFile): string =>
  SLOVAK_REGISTRY_URL.replaceAll("{section}", encodeURIComponent(file.section))
    .replaceAll("{insertNumber}", encodeURIComponent(file.insertNumber))
    .replaceAll("{court}", encodeURIComponent(file.court));

const normalizeName = (raw: string | null | undefined): string | null => {
  if (!raw) {
    return null;
  }
  // Collapse runs of whitespace and trim wrapping quotes the registry
  // sometimes leaves around alias names.
  const collapsed = raw.replaceAll(MULTI_SPACE_PATTERN, " ").trim();
  return collapsed.replaceAll(/^"|"$/gu, "");
};

const pickPrimaryName = (
  raws: OrsrRawValueTemporal[] | undefined,
  terminated: boolean,
): string | null => {
  if (!raws || raws.length === 0) {
    return null;
  }
  // Terminated entities have no `current` record; use the latest
  // historical name (the entry the registry kept on file).
  const picked = terminated ? raws.at(0) : (pickCurrent(raws) ?? raws.at(0));
  return normalizeName(picked?.value ?? null);
};

// Pick the in-force record for an entity. Terminated entities have
// every history entry flipped to `current: false`, so the canonical
// "current" pick falls through to the latest historical version
// instead.
const pickActiveRecord = <T extends OrsrRawTemporal>(
  raws: T[] | undefined,
  terminated: boolean,
): T | null => {
  if (!raws || raws.length === 0) {
    return null;
  }
  if (terminated) {
    return raws.at(0) ?? null;
  }
  return pickCurrent(raws) ?? raws.at(-1) ?? null;
};

const pickActingClause = (
  raws: OrsrRawValueTemporal[] | undefined,
  terminated: boolean,
): string | null => {
  if (!raws || raws.length === 0) {
    return null;
  }
  if (terminated) {
    return raws.at(0)?.value ?? null;
  }
  return pickCurrent(raws)?.value ?? null;
};

const pickPersonName = (
  member: OrsrRawStatutoryBodyMember | OrsrRawStakeholderMember,
): string | null => {
  const data = member.personData ?? {};
  if (data.corporateBody?.corporateBodyFullName) {
    return normalizeName(data.corporateBody.corporateBodyFullName);
  }
  const formatted = data.physicalPerson?.personName?.formattedName ?? null;
  return normalizeName(formatted);
};

const pickPersonAddress = (
  member: OrsrRawStatutoryBodyMember | OrsrRawStakeholderMember,
): string | null => {
  const addresses = member.personData?.physicalAddress ?? [];
  const first = addresses.at(0);
  return first ? parseAddress(first).textAddress : null;
};

const pickPersonIdentifier = (
  member: OrsrRawStakeholderMember,
): string | null => {
  const ids = member.personData?.id ?? [];
  const first = ids.at(0);
  return first?.identifierValue ?? null;
};

const buildSharesByName = (
  deposits: OrsrRawDeposit[] | undefined,
): Map<string, OrsrRawDeposit> => {
  const result = new Map<string, OrsrRawDeposit>();
  if (!deposits) {
    return result;
  }
  for (const deposit of deposits) {
    const stakeholder = deposit.stakeholder?.at(0);
    const name = stakeholder?.value;
    if (name && !result.has(name)) {
      result.set(name, deposit);
    }
  }
  return result;
};

const buildShareSummary = (
  deposit: OrsrRawDeposit | undefined,
): string | null => {
  if (!deposit) {
    return null;
  }
  const currency = currencyName(deposit.currency);
  const size = formatMonetary(deposit.depositValue ?? null, currency);
  const paid = formatMonetary(deposit.depositPayedValue ?? null, currency);
  if (!size && !paid) {
    return null;
  }
  // Slovak share-capital convention surfaces both the registered
  // deposit amount and the paid-up portion side by side.
  return `Výška vkladu: ${size ?? "—"} | Rozsah splatenia: ${paid ?? "—"}`;
};

const parseStatutoryBodies = (
  body: OrsrRawCorporateBody,
): OrsrStatutoryBody[] => {
  const members = body.statutoryBody ?? [];
  const statutoryBodyType = pickCurrent(body.statutoryBodyType)?.value ?? null;
  const capitalized = statutoryBodyType
    ? statutoryBodyType.charAt(0).toUpperCase() + statutoryBodyType.slice(1)
    : null;

  const collected: OrsrStatutoryMember[] = [];
  for (const member of members) {
    if (member.current !== true) {
      continue;
    }
    const name = pickPersonName(member);
    if (!name) {
      continue;
    }
    const fn = member.function ?? null;
    const position =
      fn && capitalized && fn !== capitalized
        ? `${capitalized} - ${fn}`
        : (fn ?? capitalized);
    collected.push({
      name,
      position,
      address: pickPersonAddress(member),
      since: sentinelToNull(member.functionCreationDate ?? null),
    });
  }

  if (collected.length === 0) {
    return [];
  }
  return [{ organName: STATUTORY_BODY_ORGAN_NAME, members: collected }];
};

const parseStakeholders = (body: OrsrRawCorporateBody): OrsrStakeholder[] => {
  const shares = buildSharesByName(body.deposits);
  const result: OrsrStakeholder[] = [];
  for (const member of body.stakeholder ?? []) {
    if (member.current !== true) {
      continue;
    }
    const name = pickPersonName(member);
    if (!name) {
      continue;
    }
    const typeCode = codelistItemCode(member.stakeholderType) ?? "";
    const typeName = codelistItemName(member.stakeholderType) ?? "";
    const fallbackHeading = typeName
      ? typeName.charAt(0).toUpperCase() + typeName.slice(1)
      : typeCode;
    const mapping = STAKEHOLDER_TYPE_MAPPING[typeCode];
    const [organName, position] = mapping ?? [fallbackHeading, fallbackHeading];
    const resolvedPosition = member.function ?? position;
    result.push({
      organName,
      position: resolvedPosition,
      name,
      address: pickPersonAddress(member),
      identifier: pickPersonIdentifier(member),
      share:
        resolvedPosition === "Spoločník"
          ? buildShareSummary(shares.get(name))
          : null,
    });
  }
  return result;
};

const parseStatus = (
  body: OrsrRawCorporateBody | undefined,
): OrsrCompanyStatus => {
  if (!body) {
    return { type: "unknown" };
  }
  const terminated = sentinelToNull(body.termination ?? null);
  if (terminated) {
    return { type: "terminated", terminatedAt: terminated };
  }
  return { type: "active" };
};

const pickIco = (legalPerson: OrsrRawLegalPerson): string | null => {
  const entry = legalPerson.id?.find((id) => {
    const typeName = codelistItemName(id.identifierType);
    return typeName?.includes(ICO_IDENTIFIER_HINT) ?? false;
  });
  return (
    entry?.identifierValue ?? legalPerson.id?.at(0)?.identifierValue ?? null
  );
};

/**
 * Parse a full `/legal-person/extract` payload into the domain shape.
 *
 * Returns `null` when the response is structurally incomplete (missing
 * legal person / corporate body wrapper). Callers downstream of the
 * client should never see `null` because the client validates the
 * envelope first; the guard is here so test fixtures can exercise the
 * defensive path.
 */
export const parseExtract = (
  raw: OrsrRawExtractResponse,
): OrsrCompany | null => {
  const legalPerson = raw.legalPerson;
  const body = legalPerson?.corporateBody;
  if (!legalPerson || !body) {
    return null;
  }

  const status = parseStatus(body);
  const terminated = status.type === "terminated";

  const ico = pickIco(legalPerson);
  if (!ico) {
    return null;
  }

  const name = pickPrimaryName(body.corporateBodyFullName, terminated);
  if (!name) {
    return null;
  }

  const courtFile = parseCourtFile(raw.fileReference);
  const rawAddress = pickActiveRecord(legalPerson.physicalAddress, terminated);
  const legalForm = pickActiveRecord(body.legalForm, terminated);
  const equity = pickActiveRecord(body.equity, terminated);
  const equityCurrency = currencyName(equity?.currency);

  return {
    ico,
    name,
    legalForm: legalForm ? legalFormName(legalForm) : null,
    address: rawAddress ? parseAddress(rawAddress) : null,
    courtFile,
    establishedAt: sentinelToNull(body.establishment ?? null),
    terminatedAt: status.type === "terminated" ? status.terminatedAt : null,
    shareCapital:
      equity && equity.equityValueSpecified !== false
        ? formatMonetary(equity.equityValue ?? null, equityCurrency)
        : null,
    shareCapitalPaid:
      equity && equity.equityValuePaidSpecified !== false
        ? formatMonetary(equity.equityValuePaid ?? null, equityCurrency)
        : null,
    actingClause: pickActingClause(body.authorizationToExecute, terminated),
    status,
    statutoryBodies: parseStatutoryBodies(body),
    stakeholders: parseStakeholders(body),
    registryUrl: courtFile ? buildRegistryUrl(courtFile) : "",
  };
};

const composeSearchAddress = (hit: OrsrRawSearchHit): string | null => {
  const parts = [hit.physicalAddressLine1, hit.physicalAddressLine2]
    .map((part) => part?.trim() ?? "")
    .filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
};

export const parseSearchHit = (hit: OrsrRawSearchHit): OrsrSearchResult => ({
  ico: hit.registrationNumber ?? "",
  name: normalizeName(hit.corporateBodyFullName) ?? "",
  address: composeSearchAddress(hit),
});
