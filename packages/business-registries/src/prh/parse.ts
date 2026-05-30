import type {
  PrhAddress,
  PrhBusinessLine,
  PrhCompany,
  PrhCompanyName,
  PrhCompanyStatus,
  PrhRawAddress,
  PrhRawBusinessLine,
  PrhRawCompany,
  PrhRawCompanyForm,
  PrhRawLocalizedDescription,
  PrhRawName,
  PrhSearchResult,
} from "./types.js";

// PRH's public YTJ portal at `tietopalvelu.ytj.fi` resolves company
// pages by an internal `yavain`/`tarkiste` key pair, NOT by Y-tunnus,
// so we cannot construct a stable deep link from the business ID
// alone. The AvoinData REST endpoint, in contrast, is a deterministic
// per-entity URL that always returns the current record — useful as
// a verifiable provenance link even though the response is JSON.
const PRH_AVOINDATA_URL =
  "https://avoindata.prh.fi/opendata-ytj-api/v3/companies?businessId=";

// PRH language codes: "1" = Finnish, "2" = Swedish, "3" = English.
// Stella's product UI is English-first with Finnish as the most
// likely fallback for a Finnish entity.
const DESCRIPTION_LANGUAGE_PRIORITY = ["3", "1", "2"] as const;
const ADDRESS_CITY_LANGUAGE_PRIORITY = ["3", "1", "2"] as const;

// PRH name `type` discriminator: "1" = main company name (current
// when `endDate` is absent), "2" = parallel name, "3" = trade name
// (auxiliary business name).
const MAIN_NAME_TYPE = "1";

// Top-level `status`: "1" unregistered, "2" registered, "3" ended.
const STATUS_UNREGISTERED = "1";
const STATUS_REGISTERED = "2";
const STATUS_ENDED = "3";

// Address `type`: 1 = street address, 2 = postal address.
const STREET_ADDRESS_TYPE = 1;
const POSTAL_ADDRESS_TYPE = 2;

// `tradeRegisterStatus`: "1" = registered in the trade register,
// "2" = not. Anything else is treated as "not".
const TRADE_REGISTER_REGISTERED = "1";

const pickLocalizedDescription = (
  entries: PrhRawLocalizedDescription[] | undefined,
  priority: readonly string[],
): string | null => {
  if (!entries || entries.length === 0) {
    return null;
  }
  for (const code of priority) {
    const hit = entries.find((entry) => entry.languageCode === code);
    if (hit?.description) {
      return hit.description;
    }
  }
  return entries.at(0)?.description ?? null;
};

const pickCity = (raw: PrhRawAddress): string | null => {
  const offices = raw.postOffices ?? [];
  if (offices.length === 0) {
    return null;
  }
  for (const code of ADDRESS_CITY_LANGUAGE_PRIORITY) {
    const hit = offices.find((office) => office.languageCode === code);
    if (hit?.city) {
      return hit.city;
    }
  }
  return offices.at(0)?.city ?? null;
};

const isAddressActive = (raw: PrhRawAddress): boolean => !raw.endDate;

// PRH inconsistently ships the `co` field — sometimes a bare
// recipient ("Acme Oy"), sometimes already prefixed ("c/o Acme Oy",
// "C/O Acme Oy", "C/o Acme Oy"). Detect any case-insensitive `c/o`
// at the start so the formatter renders one prefix, not two.
const CO_PREFIX_PATTERN = /^c\/o\s+/iu;

const formatCoPrefix = (co: string | undefined): string | null => {
  const trimmed = co?.trim();
  if (!trimmed) {
    return null;
  }
  return CO_PREFIX_PATTERN.test(trimmed) ? trimmed : `c/o ${trimmed}`;
};

const formatStreetLine = (raw: PrhRawAddress): string | null => {
  // PRH splits address atoms: street + buildingNumber + entrance +
  // apartmentNumber. Most consumers want the human "Mannerheimintie
  // 1 A 5" rendering, not the atoms.
  const coPrefix = formatCoPrefix(raw.co);
  if (raw.postOfficeBox) {
    return [coPrefix, `PL ${raw.postOfficeBox}`].filter(Boolean).join(", ");
  }
  const houseSegment = [raw.buildingNumber, raw.entrance, raw.apartmentNumber]
    .map((segment) => segment?.trim() ?? "")
    .filter(Boolean)
    .join(" ");
  const street = raw.street?.trim();
  const structured =
    street && houseSegment
      ? `${street} ${houseSegment}`
      : (street ?? houseSegment);
  if (structured) {
    return [coPrefix, structured].filter(Boolean).join(", ");
  }
  // Foreign / opaque addresses arrive via `freeAddressLine` instead
  // of structured atoms. PRH v3 encodes the spaces in this field as
  // underscores (e.g. `Norgårdsvägen_3_SE-451_75_Uddevalla` for a
  // Swedish branch address); decode them back and collapse runs of
  // whitespace so the result reads as the address PRH meant to send.
  const free = raw.freeAddressLine
    ?.replaceAll("_", " ")
    .replaceAll(/\s+/gu, " ")
    .trim();
  if (free && free.length > 0) {
    return [coPrefix, free].filter(Boolean).join(", ");
  }
  return coPrefix;
};

export const parseAddress = (raw: PrhRawAddress): PrhAddress => {
  const street = formatStreetLine(raw);
  const city = pickCity(raw);
  const composite = [
    street,
    [raw.postCode, city].filter(Boolean).join(" ") || null,
    raw.country,
  ]
    .filter(Boolean)
    .join(", ");
  return {
    street,
    postalCode: raw.postCode ?? null,
    city,
    country: raw.country ?? null,
    textAddress: composite.length > 0 ? composite : null,
  };
};

const pickActiveAddressByType = (
  addresses: PrhRawAddress[] | undefined,
  type: number,
): PrhRawAddress | null => {
  if (!addresses) {
    return null;
  }
  // Prefer the active address of the requested type; fall back to the
  // latest historical one (PRH includes superseded addresses with an
  // `endDate`) so we always surface something when historical data is
  // all we have.
  const active = addresses.find(
    (entry) => entry.type === type && isAddressActive(entry),
  );
  if (active) {
    return active;
  }
  const historical = addresses.filter((entry) => entry.type === type);
  return historical.at(-1) ?? null;
};

const pickCurrentCompanyForm = (
  forms: PrhRawCompanyForm[] | undefined,
): PrhRawCompanyForm | null => {
  if (!forms || forms.length === 0) {
    return null;
  }
  return forms.find((form) => !form.endDate) ?? forms.at(-1) ?? null;
};

const parseBusinessLine = (
  raw: PrhRawBusinessLine | undefined,
): PrhBusinessLine | null => {
  if (!raw?.type) {
    return null;
  }
  return {
    code: raw.type,
    description: pickLocalizedDescription(
      raw.descriptions,
      DESCRIPTION_LANGUAGE_PRIORITY,
    ),
  };
};

const collectAlternateNames = (raws: PrhRawName[]): PrhCompanyName[] => {
  // Drop the primary current name (type 1, no endDate) — it is
  // already surfaced as `PrhCompany.name`. Keep older primary names
  // (with endDate) as historical, plus all parallel / trade names.
  const result: PrhCompanyName[] = [];
  let primaryClaimed = false;
  for (const raw of raws) {
    if (raw.type === MAIN_NAME_TYPE && !raw.endDate && !primaryClaimed) {
      primaryClaimed = true;
      continue;
    }
    result.push({ name: raw.name, isCurrent: !raw.endDate });
  }
  return result;
};

const pickPrimaryName = (raws: PrhRawName[]): string | null => {
  const active = raws.find(
    (name) => name.type === MAIN_NAME_TYPE && !name.endDate,
  );
  if (active) {
    return active.name;
  }
  // Fallback: latest historical primary name, then anything at all.
  const historical = raws.filter((name) => name.type === MAIN_NAME_TYPE);
  return historical.at(-1)?.name ?? raws.at(0)?.name ?? null;
};

const parseStatus = (raw: PrhRawCompany): PrhCompanyStatus => {
  if (raw.status === STATUS_REGISTERED) {
    return { type: "registered" };
  }
  if (raw.status === STATUS_UNREGISTERED) {
    return { type: "unregistered" };
  }
  if (raw.status === STATUS_ENDED) {
    return { type: "ended", endedAt: raw.endDate ?? null };
  }
  // PRH may omit `status` entirely or return an undocumented value.
  // Coercing either to "ended" would misreport valid live entities;
  // surface "unknown" so consumers can render an honest status badge
  // (or skip rendering one at all) rather than claim the company is
  // dissolved.
  return { type: "unknown" };
};

export const parseCompany = (raw: PrhRawCompany): PrhCompany => {
  const businessId = raw.businessId.value;
  const names = raw.names ?? [];
  const primaryName = pickPrimaryName(names) ?? businessId;
  const currentForm = pickCurrentCompanyForm(raw.companyForms);
  const street = pickActiveAddressByType(raw.addresses, STREET_ADDRESS_TYPE);
  const postal = pickActiveAddressByType(raw.addresses, POSTAL_ADDRESS_TYPE);
  return {
    businessId,
    name: primaryName,
    alternateNames: collectAlternateNames(names),
    legalForm: currentForm
      ? pickLocalizedDescription(
          currentForm.descriptions,
          DESCRIPTION_LANGUAGE_PRIORITY,
        )
      : null,
    legalFormCode: currentForm?.type ?? null,
    streetAddress: street ? parseAddress(street) : null,
    postalAddress: postal ? parseAddress(postal) : null,
    mainBusinessLine: parseBusinessLine(raw.mainBusinessLine),
    status: parseStatus(raw),
    tradeRegisterRegistered:
      raw.tradeRegisterStatus === TRADE_REGISTER_REGISTERED,
    registeredAt: raw.registrationDate ?? null,
    endedAt: raw.endDate ?? null,
    registryUrl: `${PRH_AVOINDATA_URL}${encodeURIComponent(businessId)}`,
  };
};

export const parseSearchEntry = (raw: PrhRawCompany): PrhSearchResult => {
  const businessId = raw.businessId.value;
  const names = raw.names ?? [];
  // Same street → postal fallback as the lookup path: PO-box-only /
  // agent-mailing entities would otherwise surface with a null address
  // in name-search results even though the payload carries enough to
  // render one.
  const street =
    pickActiveAddressByType(raw.addresses, STREET_ADDRESS_TYPE) ??
    pickActiveAddressByType(raw.addresses, POSTAL_ADDRESS_TYPE);
  const address = street ? parseAddress(street).textAddress : null;
  return {
    businessId,
    name: pickPrimaryName(names) ?? businessId,
    address,
  };
};
