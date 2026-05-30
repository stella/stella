import type {
  RpoActivity,
  RpoAddress,
  RpoCompany,
  RpoCompanyStatus,
  RpoDomainActivity,
  RpoDomainAddress,
  RpoDomainCourtFile,
  RpoDomainName,
  RpoDomainStatutoryBody,
  RpoLegalForm,
  RpoName,
  RpoRawEntity,
  RpoSearchResult,
  RpoSourceRegister,
  RpoStatutoryBody,
} from "./types.js";

// The RPO public detail portal is keyed by the same internal numeric
// `id` the API exposes; the IČO alone is enough to reach the public
// search page, but the per-entity deep link needs the numeric id. We
// build the deep link off `id` so callers always get a deterministic
// URL that resolves to the same record.
const RPO_DETAIL_URL_PREFIX = "https://rpo.statistics.sk/rpo/v1/entity/";

const isCurrentWindow = (entry: { validTo?: string }): boolean =>
  !entry.validTo;

const pickLatest = <T extends { validFrom?: string; validTo?: string }>(
  entries: readonly T[] | undefined,
): T | null => {
  if (!entries || entries.length === 0) {
    return null;
  }
  // Prefer the entry whose validity window is currently open. Fall
  // back to the latest historical entry so RPO records that only
  // expose superseded values still surface something.
  const current = entries.find(isCurrentWindow);
  return current ?? entries.at(-1) ?? null;
};

const pickPrimaryName = (
  names: readonly RpoName[] | undefined,
): string | null => {
  const latest = pickLatest(names);
  return latest?.value ?? null;
};

const collectAlternateNames = (
  names: readonly RpoName[] | undefined,
  primary: string | null,
): RpoDomainName[] => {
  if (!names || names.length === 0) {
    return [];
  }
  // Drop the entry that backs `RpoCompany.name` so callers do not see
  // the primary current name duplicated under alternateNames.
  const result: RpoDomainName[] = [];
  let primaryClaimed = false;
  for (const entry of names) {
    if (!primaryClaimed && isCurrentWindow(entry) && entry.value === primary) {
      primaryClaimed = true;
      continue;
    }
    result.push({ name: entry.value, isCurrent: isCurrentWindow(entry) });
  }
  return result;
};

const formatStreetLine = (raw: RpoAddress): string | null => {
  // RPO splits the street address into atoms (`street` + `buildingNumber`).
  // `regNumber` is the orientational house number; when non-zero, RPO
  // formats it as `regNumber/buildingNumber` (mirroring the Czech
  // tradition). Keep the structured rendering rather than emitting
  // atoms so consumers see the human address.
  const street = raw.street?.trim();
  const building = raw.buildingNumber?.trim();
  const regNumber =
    typeof raw.regNumber === "number" && raw.regNumber > 0
      ? String(raw.regNumber)
      : null;
  const houseSegment = [regNumber, building].filter(Boolean).join("/");
  if (street && houseSegment) {
    return `${street} ${houseSegment}`;
  }
  return street ?? (houseSegment || null);
};

export const parseAddress = (raw: RpoAddress): RpoDomainAddress => {
  const street = formatStreetLine(raw);
  const postalCode = raw.postalCodes?.at(0) ?? null;
  const city = raw.municipality?.value ?? null;
  const country = raw.country?.value ?? null;
  const composite = [
    street,
    [postalCode, city].filter(Boolean).join(" ") || null,
    country,
  ]
    .filter(Boolean)
    .join(", ");
  return {
    street,
    postalCode,
    city,
    country,
    textAddress: composite.length > 0 ? composite : null,
  };
};

const parseCurrentAddress = (
  addresses: readonly RpoAddress[] | undefined,
): RpoDomainAddress | null => {
  const latest = pickLatest(addresses);
  return latest ? parseAddress(latest) : null;
};

const parseLegalForm = (
  forms: readonly RpoLegalForm[] | undefined,
): { description: string | null; code: string | null } => {
  const current = pickLatest(forms);
  if (!current) {
    return { description: null, code: null };
  }
  return {
    description: current.value.value,
    code: current.value.code ?? null,
  };
};

const parseStatus = (raw: RpoRawEntity): RpoCompanyStatus => {
  if (raw.termination) {
    return { type: "dissolved", dissolvedAt: raw.termination };
  }
  return { type: "registered" };
};

const parseCourtFile = (
  source: RpoSourceRegister | undefined,
): RpoDomainCourtFile | null => {
  if (!source) {
    return null;
  }
  const court = pickLatest(source.registrationOffices)?.value ?? null;
  const fileNumber = pickLatest(source.registrationNumbers)?.value ?? null;
  if (!court && !fileNumber) {
    return null;
  }
  return { court, fileNumber };
};

const parseActivities = (
  activities: readonly RpoActivity[] | undefined,
): RpoDomainActivity[] => {
  if (!activities) {
    return [];
  }
  // Surface only currently-active entries; superseded activities are
  // dropped here. Each entry must carry a description — RPO sometimes
  // omits it, and a description-less row carries no information for
  // the model or the human reader.
  return activities
    .filter(isCurrentWindow)
    .filter(
      (entry): entry is RpoActivity & { economicActivityDescription: string } =>
        typeof entry.economicActivityDescription === "string" &&
        entry.economicActivityDescription.length > 0,
    )
    .map((entry) => ({
      description: entry.economicActivityDescription,
      registeredAt: entry.validFrom ?? null,
    }));
};

const parseStatutoryBodies = (
  bodies: readonly RpoStatutoryBody[] | undefined,
): RpoDomainStatutoryBody[] => {
  if (!bodies) {
    return [];
  }
  return bodies.filter(isCurrentWindow).map((entry) => ({
    role: entry.stakeholderType?.value ?? null,
    personName: entry.personName?.formatedName ?? null,
    address: entry.address ? parseAddress(entry.address) : null,
  }));
};

const pickIco = (raw: RpoRawEntity): string => {
  // RPO returns an `identifiers` array — historically more than one
  // entry was possible (an entity could be re-issued an IČO), though
  // in practice every modern row carries a single entry. Prefer the
  // currently-valid value, fall back to the latest.
  const latest = pickLatest(raw.identifiers);
  return latest?.value ?? "";
};

export const parseCompany = (raw: RpoRawEntity): RpoCompany => {
  const ico = pickIco(raw);
  const primaryName = pickPrimaryName(raw.fullNames) ?? ico;
  const legalForm = parseLegalForm(raw.legalForms);
  const mainActivity = raw.statisticalCodes?.mainActivity;
  return {
    ico,
    name: primaryName,
    alternateNames: collectAlternateNames(raw.fullNames, primaryName),
    legalForm: legalForm.description,
    legalFormCode: legalForm.code,
    address: parseCurrentAddress(raw.addresses),
    courtFile: parseCourtFile(raw.sourceRegister),
    mainActivity: mainActivity?.code
      ? { code: mainActivity.code, description: mainActivity.value }
      : null,
    activities: parseActivities(raw.activities),
    statutoryBodies: parseStatutoryBodies(raw.statutoryBodies),
    status: parseStatus(raw),
    establishedAt: raw.establishment ?? null,
    dissolvedAt: raw.termination ?? null,
    registryUrl: `${RPO_DETAIL_URL_PREFIX}${raw.id}`,
  };
};

export const parseSearchEntry = (raw: RpoRawEntity): RpoSearchResult => {
  const ico = pickIco(raw);
  const primaryName = pickPrimaryName(raw.fullNames) ?? ico;
  const address = parseCurrentAddress(raw.addresses);
  return {
    ico,
    name: primaryName,
    address: address?.textAddress ?? null,
  };
};
